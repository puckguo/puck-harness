/**
 * Agent — the stateful wrapper around the pure loop.
 *
 * Owns the canonical transcript, fan-out of events to subscribers,
 * the abort controller, and the steering queue. This is the class
 * host applications hold on to; `runAgentLoop` below it stays pure.
 */

import { runAgentLoop } from "./loop.js";
import type { AgentEvent, AgentEventListener, LoopHooks, Message, StreamFn, StreamOptions, Tool } from "./types.js";
import { userMessage } from "./utils.js";

export interface AgentOptions {
	systemPrompt?: string;
	tools?: Tool[];
	/** Initial transcript (e.g. hydrated from a session file). */
	messages?: Message[];
	streamFn: StreamFn;
	/** Provider options (apiKey, temperature, ...) forwarded to every LLM call. */
	streamOptions?: StreamOptions;
	hooks?: LoopHooks;
	/** Logical model id for tracking (emitted in model_update events). */
	modelId?: string;
}

export class Agent {
	public systemPrompt: string | undefined;
	public tools: Tool[];
	public messages: Message[];
	public streamFn: StreamFn;
	public streamOptions: StreamOptions | undefined;
	/** Logical id of the current model (informational; the StreamFn is authoritative). */
	public modelId: string | undefined;

	/** User hooks. The steering queue drain is composed in automatically. */
	private userHooks: LoopHooks | undefined;
	private readonly listeners = new Set<AgentEventListener>();
	private steeringQueue: Message[] = [];
	private activeAbort: AbortController | undefined;
	private activeRun: Promise<Message[]> | undefined;
	private runId = 0;

	constructor(options: AgentOptions) {
		this.systemPrompt = options.systemPrompt;
		this.tools = options.tools ? [...options.tools] : [];
		this.messages = options.messages ? [...options.messages] : [];
		this.streamFn = options.streamFn;
		this.streamOptions = options.streamOptions;
		this.userHooks = options.hooks;
		this.modelId = options.modelId;
	}

	/**
	 * Switch the model mid-session: replaces the StreamFn and emits model_update.
	 * Safe to call while streaming — takes effect from the next LLM call
	 * (the in-flight request finishes on the old model).
	 */
	setModel(modelId: string, streamFn: StreamFn): void {
		const previous = this.modelId;
		this.modelId = modelId;
		this.streamFn = streamFn;
		void this.dispatch({ type: "model_update", modelId, previousModelId: previous });
	}

	get isStreaming(): boolean {
		return this.activeRun !== undefined;
	}

	/** Subscribe to all agent events. Returns an unsubscribe function. */
	subscribe(listener: AgentEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Send user input and run to completion.
	 *
	 * While a run is active the input is queued as steering: it is injected
	 * before the next LLM call of the *current* run, and the returned promise
	 * resolves when that run (including the steering) finishes.
	 */
	prompt(input: string | Message | Message[]): Promise<Message[]> {
		const messages = typeof input === "string" ? [userMessage(input)] : Array.isArray(input) ? input : [input];
		return this.startOrSteer(messages);
	}

	/**
	 * Queue steering input without waiting for the current turn to finish.
	 * No-op when the agent is idle (use `prompt` instead).
	 */
	queue(input: string | Message | Message[]): void {
		if (!this.isStreaming) return;
		const messages = typeof input === "string" ? [userMessage(input)] : Array.isArray(input) ? input : [input];
		this.steeringQueue.push(...messages);
	}

	/**
	 * Continue the current transcript without new input. If the transcript
	 * ends in a failed/aborted assistant message, that message is dropped
	 * and the request is retried.
	 */
	continueRun(): Promise<Message[]> {
		if (this.isStreaming) return this.activeRun!;
		const tail = this.messages[this.messages.length - 1];
		if (tail?.role === "assistant" && (tail.stopReason === "error" || tail.stopReason === "aborted")) {
			this.messages.pop();
		}
		return this.startOrSteer([]);
	}

	/** Abort the active run. The run settles gracefully with an aborted assistant message. */
	abort(): void {
		this.activeAbort?.abort();
	}

	/** Iterate the events of one run. Sugar over subscribe + prompt. */
	async *iterate(input: string | Message | Message[]): AsyncGenerator<AgentEvent> {
		const queue: AgentEvent[] = [];
		let wake: (() => void) | undefined;
		let done = false;

		const unsubscribe = this.subscribe((event) => {
			queue.push(event);
			wake?.();
		});
		const run = this.prompt(input).finally(() => {
			done = true;
			wake?.();
		});

		try {
			while (true) {
				while (queue.length > 0) {
					yield queue.shift()!;
				}
				if (done) break;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
			await run;
		} finally {
			unsubscribe();
		}
	}

	/** Replace the transcript wholesale (compaction, editing, rollback). */
	replaceMessages(messages: Message[]): void {
		if (this.isStreaming) throw new Error("Cannot replace messages while the agent is streaming");
		this.messages = [...messages];
	}

	private startOrSteer(messages: Message[]): Promise<Message[]> {
		if (this.isStreaming) {
			this.steeringQueue.push(...messages);
			return this.activeRun!;
		}

		const abort = new AbortController;
		const controller = this;
		const run = ++this.runId;

		const hooks: LoopHooks = {
			...this.userHooks,
			getSteeringMessages: () => {
				const queued = controller.steeringQueue.splice(0);
				const userSteering = controller.userHooks?.getSteeringMessages?.() ?? [];
				return [...queued, ...userSteering];
			},
		};

		// Indirection: the loop reads this.streamFn on every LLM call, so
		// setModel() takes effect for in-flight runs at the next call.
		const streamFnProxy: StreamFn = (context, options) => controller.streamFn(context, options);

		this.activeAbort = abort;
		this.activeRun = runAgentLoop({
			context: {
				systemPrompt: this.systemPrompt,
				messages: this.messages,
				tools: this.tools,
			},
			prompt: messages,
			streamFn: streamFnProxy,
			emit: (event) => this.dispatch(event),
			hooks,
			streamOptions: this.streamOptions,
			signal: abort.signal,
		}).finally(() => {
			// Only clear if this is still the active run (no newer run started).
			if (controller.runId === run) {
				controller.activeAbort = undefined;
				controller.activeRun = undefined;
				controller.steeringQueue = [];
			}
		});

		return this.activeRun;
	}

	private async dispatch(event: AgentEvent): Promise<void> {
		for (const listener of this.listeners) {
			await listener(event);
		}
	}
}
