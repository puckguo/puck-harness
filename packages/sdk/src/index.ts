/**
 * @puck-agent/sdk — `createPuck()`: assemble an agent from exactly the
 * pieces you want. This is the convenience facade; every parameter is
 * optional and every underlying package can be used directly instead.
 */

import type { AgentEvent, AgentEventListener, LoopHooks, Message, StreamFn, Tool, Usage } from "@puck-agent/core";
import { Agent, assistantText, sumUsage } from "@puck-agent/core";
import type { ApprovalGateOptions } from "@puck-agent/features/approval";
import { createApprovalGate } from "@puck-agent/features/approval";
import type { CompactionOptions } from "@puck-agent/features/compaction";
import { createCompactionHook } from "@puck-agent/features/compaction";
import type { Model } from "@puck-agent/llm";
import { createMockStreamFn, createStreamFn, FileCredentialStore, loginProvider, logoutProvider, resolveModel, type CredentialStore, type LoginInteraction } from "@puck-agent/llm";
import { Session, SessionStore } from "@puck-agent/session";
import { createCodingTools } from "@puck-agent/tools";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { puckDir } from "@puck-agent/llm";

export interface PuckOptions {
	/** Model id from the catalog, a custom Model, or "mock" for offline runs. */
	model: string | Model;
	apiKey?: string;
	baseUrl?: string;
	temperature?: number;
	maxTokens?: number;
	/** Credential store for /login-style key persistence. Default: FileCredentialStore (~/.puck/auth.json). Pass false to disable. */
	credentials?: CredentialStore | false;

	systemPrompt?: string;
	/** Memory layer (agent.md/experience.md) appended after the system prompt. */
	agentContext?: string;
	/** "coding" gets bash+read+write+edit; "none" disables tools; or pass your own. */
	tools?: Tool[] | "coding" | "none";
	cwd?: string;

	/** Persist the transcript as JSONL: a dir (auto id), {dir,id}, an existing Session, or false. */
	session?: string | { dir: string; id?: string } | Session | false;

	/** Compact context with an LLM summary when it grows past maxTokens. */
	compaction?: { enabled?: boolean } & Partial<CompactionOptions>;
	/** Gate tool calls behind an approval callback. */
	approval?: ApprovalGateOptions;
	/** Extra loop hooks, merged last. */
	hooks?: LoopHooks;

	/** Fully custom stream function (overrides model resolution). */
	streamFn?: StreamFn;
}

export interface PuckRunResult {
	/** Messages added during the run. */
	messages: Message[];
	/** Final visible assistant text of the run. */
	text: string;
	/** Aggregated usage of the run. */
	usage: Usage;
}

export interface Puck {
	agent: Agent;
	session: Session | undefined;
	/** Send input, run to completion, return the final text plus aggregates. */
	run(input: string | Message | Message[]): Promise<PuckRunResult>;
	/** Subscribe to all events (streaming, tools, turns). */
	subscribe(listener: AgentEventListener): () => void;
	/** Iterate one run's events as an async iterable. */
	iterate(input: string | Message | Message[]): AsyncGenerator<AgentEvent>;
	/** Switch model mid-session (takes effect from the next LLM call). */
	setModel(model: string | Model): void;
	/** Current logical model id, if known. */
	readonly modelId: string | undefined;
	/** Credential store used for key resolution (undefined = env vars only). */
	readonly credentials: CredentialStore | undefined;
	abort(): void;
}

// re-export auth helpers so SDK consumers don't need @puck-agent/llm for login flows
export { loginProvider, logoutProvider, type LoginInteraction } from "@puck-agent/llm";

/** Persist the default model id for future puck sessions (~/.puck/config.json). */
export function setDefaultModel(modelId: string): void {
	const path = `${puckDir()}/config.json`;
	let config: Record<string, unknown> = {};
	try {
		config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		/* fresh config */
	}
	config.defaultModel = modelId;
	mkdirSync(puckDir(), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, "\t"), "utf8");
}

/** Read the persisted default model id, if any. */
export function getDefaultModel(): string | undefined {
	try {
		const config = JSON.parse(readFileSync(`${puckDir()}/config.json`, "utf8")) as { defaultModel?: string };
		return config.defaultModel;
	} catch {
		return undefined;
	}
}

export const DEFAULT_CODING_PROMPT = `You are a careful coding agent working in the user's repository.

- Use the read tool before editing files you haven't seen.
- Prefer precise edits over rewriting whole files.
- Run tests or builds with bash when your changes could break something.
- When you finish a task, summarize what changed and how it was verified.`;

export function createPuck(options: PuckOptions): Puck {
	// --- credentials ---------------------------------------------------------
	const credentials = options.credentials === false ? undefined : (options.credentials ?? new FileCredentialStore());

	// --- model / streamFn ---------------------------------------------------
	let streamFn: StreamFn;
	let model: Model | undefined;
	if (options.streamFn) {
		streamFn = options.streamFn;
	} else if (options.model === "mock") {
		streamFn = createMockStreamFn([{ text: "(mock model; pass streamFn or a script for real behavior)" }]);
	} else {
		model = typeof options.model === "string" ? resolveModel(options.model) : options.model;
		streamFn = createStreamFn(model, credentials);
	}

	// --- tools ----------------------------------------------------------------
	const tools: Tool[] =
		options.tools === undefined || options.tools === "coding"
			? createCodingTools({ cwd: options.cwd })
			: options.tools === "none"
				? []
				: options.tools;

	// --- session ----------------------------------------------------------------
	let session: Session | undefined;
	if (options.session !== false && options.session !== undefined) {
		if (options.session instanceof Session) {
			session = options.session;
		} else {
			const store = new SessionStore(typeof options.session === "string" ? options.session : options.session.dir);
			const id = typeof options.session === "object" ? options.session.id : undefined;
			// Record cwd on create so /resume can filter sessions by working dir.
			session = id && store.list().includes(id) ? store.load(id) : store.create({ id, model: model?.id, cwd: options.cwd });
		}
	}

	// --- hooks --------------------------------------------------------------------
	const hooks: LoopHooks = { ...options.hooks };
	if (options.compaction?.enabled) {
		hooks.transformContext = createCompactionHook({
			streamFn,
			maxTokens: options.compaction.maxTokens ?? 100_000,
			keepRecent: options.compaction.keepRecent,
			summarizePrompt: options.compaction.summarizePrompt,
			// every fold is part of the session's history ("compact ×N" in /resume)
			onCompact: (_summary, prefixMessages) => session?.recordCompaction(prefixMessages),
		});
	}
	if (options.approval) {
		const approvalGate = createApprovalGate(options.approval);
		const inner = hooks.beforeToolCall;
		hooks.beforeToolCall = async (info) => (await approvalGate(info)) ?? inner?.(info);
	}

	// --- agent ----------------------------------------------------------------------
	// agentContext: loaded memory layer (agent.md / experience.md) appended after
	// the base prompt — kept separate so callers can swap instructions without
	// rebuilding the context files.
	const basePrompt = options.systemPrompt ?? (tools.length > 0 ? DEFAULT_CODING_PROMPT : undefined);
	const systemPrompt = options.agentContext ? (basePrompt ? basePrompt + "\n\n" + options.agentContext : options.agentContext) : basePrompt;
	const agent = new Agent({
		systemPrompt,
		tools,
		messages: session ? [...session.messages] : [],
		streamFn,
		streamOptions: {
			apiKey: options.apiKey,
			baseUrl: options.baseUrl,
			temperature: options.temperature,
			maxTokens: options.maxTokens,
		},
		hooks,
		modelId: model?.id,
	});

	if (session) {
		agent.subscribe((event) => {
			if (event.type === "message_end") session?.append(event.message);
		});
	}

	return {
		agent,
		session,
		run: async (input) => {
			const messages = await agent.prompt(input);
			const last = [...messages].reverse().find((m) => m.role === "assistant");
			return {
				messages,
				text: last?.role === "assistant" ? assistantText(last) : "",
				usage: sumUsage(messages),
			};
		},
		subscribe: (listener) => agent.subscribe(listener),
		iterate: (input) => agent.iterate(input),
		setModel: (next) => {
			if (next === "mock") {
				agent.setModel("mock", createMockStreamFn([{ text: "(mock model)" }]));
				return;
			}
			const nextModel = typeof next === "string" ? resolveModel(next) : next;
			agent.setModel(nextModel.id, createStreamFn(nextModel, credentials));
		},
		get modelId() {
			return agent.modelId;
		},
		get credentials() {
			return credentials;
		},
		abort: () => agent.abort(),
	};
}
