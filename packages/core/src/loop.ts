/**
 * The agent loop — the heart of puck.
 *
 *   user message ──▶ LLM ──▶ assistant message
 *                        │        │
 *                        │        └─ tool calls ──▶ tool results ──┐
 *                        └─────────────────────────────────────────┘ (repeat)
 *
 * A run appends to `context.messages` (the canonical transcript), emits
 * events, and resolves with every message produced during the run.
 * Everything stateful (queues, subscriptions, abort ownership) lives one
 * layer up in `agent.ts`.
 */

import type {
	AgentEventListener,
	AssistantMessage,
	LoopHooks,
	Message,
	StreamFn,
	StreamOptions,
	Tool,
	ToolCall,
	ToolResult,
	ToolResultMessage,
} from "./types.js";
import { errorResult, now } from "./utils.js";
import { validateToolArguments } from "./validate.js";

export interface AgentLoopOptions {
	/** Canonical transcript. Mutated in place: run messages are appended. */
	context: {
		systemPrompt?: string;
		messages: Message[];
		tools: Tool[];
	};
	/** New user input for this run. Omit to continue from the current tail (e.g. after editing history). */
	prompt?: Message | Message[];
	streamFn: StreamFn;
	emit: AgentEventListener;
	hooks?: LoopHooks;
	/** Provider options (apiKey, temperature, ...) forwarded to every LLM call. */
	streamOptions?: StreamOptions;
	signal?: AbortSignal;
}

/** Run the agent loop to completion. Resolves with all messages added during the run. */
export async function runAgentLoop(options: AgentLoopOptions): Promise<Message[]> {
	const { context, streamFn, emit, hooks } = options;
	const signal = options.signal;
	const streamOptions: StreamOptions = { ...options.streamOptions, signal };
	const added: Message[] = [];
	const prompts = options.prompt === undefined ? [] : Array.isArray(options.prompt) ? options.prompt : [options.prompt];

	// Ingest the prompt into the canonical transcript first (state change),
	// then validate, then emit events — so a bad tail throws before any event fires.
	for (const message of prompts) {
		context.messages.push(message);
		added.push(message);
	}

	const tail = context.messages[context.messages.length - 1];
	if (tail !== undefined && tail.role === "assistant") {
		// roll back the ingestion so the transcript is unchanged on failure
		context.messages.length -= prompts.length;
		throw new Error(
			"Cannot run the loop from an assistant tail. Provide a prompt, or remove/replace the trailing assistant message first.",
		);
	}

	await emit({ type: "run_start" });
	for (const message of prompts) {
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}

	/** Drain steering into the transcript (emits message_start/end per message). */
	const injectSteering = async (): Promise<number> => {
		const steering = hooks?.getSteeringMessages?.() ?? [];
		for (const message of steering) {
			context.messages.push(message);
			added.push(message);
			await emit({ type: "message_start", message });
			await emit({ type: "message_end", message });
		}
		return steering.length;
	};

	let turn = 0;
	while (true) {
		// Steering: messages queued while the run is active are injected before the next LLM call.
		await injectSteering();

		await emit({ type: "turn_start", turn });
		const assistant = await streamAssistant(context, streamFn, streamOptions, hooks, emit);
		added.push(assistant);

		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			await emit({ type: "turn_end", turn, message: assistant, toolResults: [] });

			// A failed request normally settles the run — unless the user queued
			// steering input meanwhile. In that case drop the failed assistant
			// message and continue with the next LLM call (which may already run on
			// a switched model when the host replaced streamFn mid-run).
			const pending = hooks?.getSteeringMessages?.() ?? [];
			if (assistant.stopReason === "error" && pending.length > 0 && !signal?.aborted) {
				context.messages.pop(); // remove the failed assistant FIRST
				added.pop();
				for (const message of pending) {
					context.messages.push(message);
					added.push(message);
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
				}
				turn++;
				continue;
			}
			break;
		}

		const toolCalls = assistant.content.filter((c): c is ToolCall => c.type === "toolCall");
		let toolResults: ToolResultMessage[] = [];

		if (toolCalls.length > 0) {
			toolResults =
				assistant.stopReason === "length"
					? await failTruncatedToolCalls(toolCalls, emit)
					: await executeToolCalls(context.tools, assistant, toolCalls, hooks, signal, emit);

			for (const result of toolResults) {
				context.messages.push(result);
				added.push(result);
				await emit({ type: "message_start", message: result });
				await emit({ type: "message_end", message: result });
			}
		}

		await emit({ type: "turn_end", turn, message: assistant, toolResults });
		turn++;

		const shouldStop =
			signal?.aborted ||
			toolCalls.length === 0 ||
			(hooks?.maxTurns !== undefined && turn >= hooks.maxTurns) ||
			(toolResults.length > 0 && toolResults.every((r) => terminates.has(r))) ||
			hooks?.shouldStop?.({ turn, message: assistant, toolResults }) === true;
		if (shouldStop) {
			// Natural end (answer complete, no tool calls) with steering queued
			// meanwhile: extend the run one more turn so the user's interjection is
			// answered in THIS run instead of being silently dropped. Hard stops
			// (abort, maxTurns, terminate hints) are never overridden.
			const naturalEnd = toolCalls.length === 0 && !signal?.aborted && (hooks?.maxTurns === undefined || turn < hooks.maxTurns);
			if (naturalEnd && (await injectSteering()) > 0) {
				turn++;
				continue;
			}
			break;
		}
	}

	await emit({ type: "run_end", messages: added });
	return added;
}

/** Terminate hints are tracked out-of-band so ToolResultMessage stays wire-clean. */
const terminates = new WeakSet<ToolResultMessage>();

/** One LLM call. Applies transformContext, then streams partials into message_update events. */
async function streamAssistant(
	context: { systemPrompt?: string; messages: Message[]; tools: Tool[] },
	streamFn: StreamFn,
	streamOptions: StreamOptions,
	hooks: LoopHooks | undefined,
	emit: AgentEventListener,
): Promise<AssistantMessage> {
	let view = context.messages;
	if (hooks?.transformContext) {
		view = await hooks.transformContext(view);
	}

	const stream = streamFn({ systemPrompt: context.systemPrompt, messages: view, tools: context.tools }, streamOptions);

	let final: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "start") {
			await emit({ type: "message_start", message: event.partial });
		} else if (event.type === "delta") {
			await emit({ type: "message_update", message: event.partial });
		} else {
			final = event.message;
		}
	}
	const message = final ?? (await stream.result());

	context.messages.push(message);
	await emit({ type: "message_end", message });
	return message;
}

/** Tool call skipped because the run was aborted mid-batch (sequential mode). */
async function failAbortedToolCall(toolCall: ToolCall, emit: AgentEventListener): Promise<ToolResultMessage> {
	await emit({ type: "tool_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
	const result = errorResult(`Tool call "${toolCall.name}" was not executed: the run was aborted.`);
	await emit({ type: "tool_end", toolCallId: toolCall.id, toolName: toolCall.name, result, isError: true });
	return toToolResultMessage(toolCall, result);
}

/** Tool calls from a length-truncated message may carry broken arguments: fail them all. */
async function failTruncatedToolCalls(toolCalls: ToolCall[], emit: AgentEventListener): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({ type: "tool_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
		const result = errorResult(
			`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, ` +
				`so its arguments may be truncated. Re-issue the call with complete arguments.`,
		);
		await emit({ type: "tool_end", toolCallId: toolCall.id, toolName: toolCall.name, result, isError: true });
		results.push(toToolResultMessage(toolCall, result));
	}
	return results;
}

async function executeToolCalls(
	tools: Tool[],
	assistant: AssistantMessage,
	toolCalls: ToolCall[],
	hooks: LoopHooks | undefined,
	signal: AbortSignal | undefined,
	emit: AgentEventListener,
): Promise<ToolResultMessage[]> {
	if ((hooks?.toolExecution ?? "parallel") === "sequential") {
		const results: ToolResultMessage[] = [];
		for (const toolCall of toolCalls) {
			results.push(await executeOneToolCall(tools, assistant, toolCall, hooks, signal, emit));
			if (signal?.aborted) {
				// every unanswered toolCall would dangle in the transcript and 400 the
				// next wire request — close them out with abort errors instead
				for (const rest of toolCalls.slice(results.length)) {
					results.push(await failAbortedToolCall(rest, emit));
				}
				break;
			}
		}
		return results;
	}
	// Parallel: fire all, keep assistant source order in the transcript.
	return Promise.all(toolCalls.map((toolCall) => executeOneToolCall(tools, assistant, toolCall, hooks, signal, emit)));
}

async function executeOneToolCall(
	tools: Tool[],
	assistant: AssistantMessage,
	toolCall: ToolCall,
	hooks: LoopHooks | undefined,
	signal: AbortSignal | undefined,
	emit: AgentEventListener,
): Promise<ToolResultMessage> {
	await emit({ type: "tool_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });

	const tool = tools.find((t) => t.name === toolCall.name);
	let result: ToolResult;

	if (!tool) {
		result = errorResult(`Tool "${toolCall.name}" not found. Available tools: ${tools.map((t) => t.name).join(", ")}`);
	} else {
		const validationError = validateToolArguments(tool, toolCall.arguments);
		if (validationError) {
			result = errorResult(validationError);
		} else {
			const before = await hooks?.beforeToolCall?.({ toolCall, args: toolCall.arguments, assistantMessage: assistant });
			if (before?.block) {
				result = errorResult(before.reason ?? `Tool "${toolCall.name}" was blocked by policy`);
			} else if (signal?.aborted) {
				result = errorResult("Aborted before execution");
			} else {
				result = await runTool(tool, toolCall, signal);
			}
		}
	}

	const after = await hooks?.afterToolCall?.({
		toolCall,
		args: toolCall.arguments,
		result,
		isError: result.isError === true,
	});
	if (after) {
		if (after.content !== undefined) result = { ...result, content: after.content };
		if (after.isError !== undefined) result = { ...result, isError: after.isError };
	}

	await emit({
		type: "tool_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: result.isError === true,
	});
	return toToolResultMessage(toolCall, result);
}

async function runTool(tool: Tool, toolCall: ToolCall, signal: AbortSignal | undefined): Promise<ToolResult> {
	try {
		return await tool.execute(toolCall.arguments, { cwd: process.cwd(), signal });
	} catch (error) {
		return errorResult(error instanceof Error ? error.message : String(error));
	}
}

function toToolResultMessage(toolCall: ToolCall, result: ToolResult): ToolResultMessage {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content ?? [],
		isError: result.isError === true,
		timestamp: now(),
	};
	if (result.terminate) terminates.add(message);
	return message;
}
