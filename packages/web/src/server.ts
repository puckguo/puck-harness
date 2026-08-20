/**
 * puck web server — a thin HTTP/SSE adapter over the puck SDK, with full
 * CLI feature parity (slash commands, compaction, thinking, timings, login).
 *
 *   browser ──POST /api/run (SSE reply)──▶ createPuck() per session
 *                                           │
 *                                           ├─ agent.subscribe → SSE frames
 *                                           ├─ SessionStore (JSONL logs)
 *                                           ├─ TimingCollector (~/.puck/timings.jsonl)
 *                                           └─ FileCredentialStore (~/.puck/auth.json)
 *
 * One puck instance per sessionId, kept alive across requests. Concurrency:
 * `Agent.prompt()` itself queues concurrent input as steering, so two POSTs
 * racing on one session simply serialize inside the agent loop.
 */

import type { AgentEvent } from "@puckguo123/core";
import { estimateMessageTokens } from "@puckguo123/core";
import { compactNow } from "@puckguo123/features/compaction";
import {
	createMockStreamFn,
	FileCredentialStore,
	findProvider,
	listModels,
	listProviders,
	resolveModel,
} from "@puckguo123/llm";
import { createPuck, getDefaultModel, setDefaultModel, type Puck } from "@puckguo123/sdk";
import { SessionStore } from "@puckguo123/session";
import { aggregateByModel, TimingCollector, TimingStore } from "@puckguo123/timing";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeSse, type RunRequestBody, type WebEvent } from "./protocol.js";
import { serveStatic } from "./static.js";

export interface WebServerOptions {
	port?: number;
	host?: string;
	/** Directory for session JSONL logs. Default: <cwd>/.puck/sessions */
	sessionsDir?: string;
	/** Server-side cwd for coding tools. Default: process.cwd() */
	cwd?: string;
	/** Default model id (`provider/model`). Default: PUCK_MODEL env > saved default > deepseek-chat. */
	model?: string;
	/** Serve the bundled web UI (default true). */
	ui?: boolean;
	/** Offline scripted model — zero network, for UI development. */
	mock?: boolean;
}

const MOCK_SCRIPT = [
	{
		thinking: "The user wants a demo. I should run a command first to show tool output.",
		text: "先看看当前目录。",
		delayMs: 500,
		toolCalls: [
			{ name: "bash", arguments: { command: "echo hello from puck web" } },
			{ name: "write", arguments: { path: "puck-demo.txt", content: "written by the mock model" } },
		],
	},
	{ text: "mock 模型跑完了命令 — 真实模型用 /model 切换。", delayMs: 250 },
];

type Effort = "off" | "low" | "medium" | "high";

/** Sensible first model per provider (CLI FALLBACK_MODEL_BY_PROVIDER parity). */
const FALLBACK_MODEL_BY_PROVIDER: Record<string, string> = {
	anthropic: "claude-sonnet-4-5",
	deepseek: "deepseek-chat",
	groq: "llama-3.3-70b-versatile",
	minimax: "MiniMax-M3",
	"minimax-cn": "MiniMax-M3",
	moonshot: "kimi-k2-0905-vision-preview",
	"moonshot-cn": "kimi-k2-0905-vision-preview",
	openai: "gpt-4o",
	openrouter: "openrouter/auto",
	ollama: "qwen3:8b",
	"qwen-token-plan": "qwen3-coder-plus",
	"qwen-token-plan-cn": "qwen3-coder-plus",
	xai: "grok-4",
};

interface SessionRuntime {
	puck: Puck;
	inTokens: number;
	outTokens: number;
	thinking: Effort | undefined;
	detachTiming: () => void;
}

export function createWebServer(options: WebServerOptions = {}) {
	const cwd = options.cwd ?? process.cwd();
	const sessionsDir = options.sessionsDir ?? join(cwd, ".puck", "sessions");
	const store = new SessionStore(sessionsDir);
	const credentials = new FileCredentialStore();
	const timingStore = new TimingStore();
	const defaultModel = options.mock ? "mock" : (options.model ?? process.env.PUCK_MODEL ?? getDefaultModel() ?? "deepseek-chat");
	/** Thinking effort for sessions created later (parity: /think before first message). */
	let defaultThinking: Effort | undefined;
	const runtimes = new Map<string, SessionRuntime>();

	const getRuntime = (sessionId: string): SessionRuntime => {
		const existing = runtimes.get(sessionId);
		if (existing) return existing;
		const puck = createPuck({
			model: defaultModel,
			streamFn: options.mock ? createMockStreamFn(MOCK_SCRIPT) : undefined,
			tools: "coding",
			cwd,
			session: { dir: sessionsDir, id: sessionId },
			credentials,
			compaction: { enabled: true, maxTokens: 100_000 },
		});
		if (defaultThinking) {
			puck.agent.streamOptions = { ...puck.agent.streamOptions, thinkingEffort: defaultThinking };
		}
		// every turn is recorded to ~/.puck/timings.jsonl (parity with the CLI)
		const collector = new TimingCollector({
			sessionId: puck.session?.id,
			modelId: puck.modelId,
			onTurn: (record) => void timingStore.append(record),
		});
		const rt: SessionRuntime = {
			puck,
			inTokens: 0,
			outTokens: 0,
			thinking: defaultThinking,
			detachTiming: collector.attach(puck.agent),
		};
		runtimes.set(sessionId, rt);
		return rt;
	};

	const contextWindowOf = (modelId: string | undefined): number => {
		if (!modelId || modelId === "mock") return options.mock ? 128_000 : 0;
		try {
			return resolveModel(modelId).contextWindow;
		} catch {
			return 0;
		}
	};

	const providerState = (): Array<{ id: string; name: string; state: "stored" | "env" | "none" }> =>
		listProviders().map((provider) => ({
			id: provider.id,
			name: provider.name,
			state: credentials.read(provider.id)
				? ("stored" as const)
				: provider.apiKeyEnvs.some((name) => process.env[name])
					? ("env" as const)
					: ("none" as const),
		}));

	const server = createServer((req, res) => {
		void handle(req, res).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: message }));
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://local");

		// --- UI static files -------------------------------------------------
		if (options.ui !== false && req.method === "GET" && !url.pathname.startsWith("/api/")) {
			const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
			if (serveStatic(req, res, root)) return;
		}

		if (url.pathname === "/api/health" && req.method === "GET") {
			return json(res, 200, { ok: true, mock: Boolean(options.mock), model: defaultModel, cwd });
		}

		if (url.pathname === "/api/sessions" && req.method === "GET") {
			return json(res, 200, store.statsAll());
		}

		if (url.pathname === "/api/providers" && req.method === "GET") {
			return json(res, 200, providerState());
		}

		if (url.pathname === "/api/catalog" && req.method === "GET") {
			// No-key browsing: full provider registry with built-in fallback models.
			// Users can pick anything here; the run fails clearly without a key,
			// exactly like the CLI does.
			const groups = listProviders().map((provider) => ({
				provider: provider.id,
				name: provider.name,
				state: credentials.read(provider.id)
					? ("stored" as const)
					: provider.apiKeyEnvs.some((name) => process.env[name])
						? ("env" as const)
						: ("none" as const),
				fallback: FALLBACK_MODEL_BY_PROVIDER[provider.id] ?? undefined,
			}));
			return json(res, 200, groups);
		}

		if (url.pathname === "/api/models" && req.method === "GET") {
			const { discoverUsableModels } = await import("@puckguo123/llm");
			const usable = options.mock ? [] : await discoverUsableModels(credentials);
			return json(res, 200, usable.map((entry) => ({ provider: entry.provider.id, models: entry.models })));
		}

		if (url.pathname === "/api/state" && req.method === "GET") {
			const id = url.searchParams.get("sessionId");
			if (!id) return json(res, 400, { error: "sessionId required" });
			const rt = runtimes.get(id) ?? getRuntime(id);
			const modelId = rt.puck.modelId;
			return json(res, 200, {
				sessionId: id,
				model: modelId,
				thinking: rt.thinking ?? null,
				messages: rt.puck.agent.messages,
				ctxTokens: estimateMessageTokens(rt.puck.agent.messages),
				ctxWindow: contextWindowOf(modelId),
				inTokens: rt.inTokens,
				outTokens: rt.outTokens,
				running: rt.puck.agent.isStreaming,
				session: rt.puck.session
					? {
							id: rt.puck.session.id,
							turns: rt.puck.session.messages.filter((m) => m.role === "user").length,
							compactions: rt.puck.session.compactionCount,
						}
					: null,
			});
		}

		if (url.pathname === "/api/status" && req.method === "GET") {
			const id = url.searchParams.get("sessionId");
			const rt = id ? (runtimes.get(id) ?? getRuntime(id)) : undefined;
			return json(res, 200, {
				model: rt?.puck.modelId ?? defaultModel,
				mock: Boolean(options.mock),
				thinking: rt?.thinking ?? defaultThinking ?? null,
				cwd,
				keysPath: credentials.filePath,
				providers: providerState(),
				session: rt?.puck.session
					? {
							id: rt.puck.session.id,
							turns: rt.puck.session.messages.filter((m) => m.role === "user").length,
							compactions: rt.puck.session.compactionCount,
						}
					: null,
			});
		}

		if (url.pathname === "/api/abort" && req.method === "POST") {
			const body = (await readJson(req)) as { sessionId?: string };
			if (!body.sessionId) return json(res, 400, { error: "sessionId required" });
			runtimes.get(body.sessionId)?.puck.abort();
			return json(res, 200, { ok: true });
		}

		if (url.pathname === "/api/model" && req.method === "POST") {
			const body = (await readJson(req)) as { sessionId?: string; model?: string; persist?: boolean };
			if (!body.model) return json(res, 400, { error: "model required" });
			if (options.mock) return json(res, 400, { error: "mock mode cannot switch models" });
			try {
				resolveModel(body.model); // validate before switching
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return json(res, 400, { error: message });
			}
			if (body.sessionId && runtimes.has(body.sessionId)) {
				runtimes.get(body.sessionId)!.puck.setModel(body.model);
			}
			if (body.persist !== false) setDefaultModel(body.model);
			return json(res, 200, { ok: true, model: body.model, ctxWindow: contextWindowOf(body.model) });
		}

		if (url.pathname === "/api/think" && req.method === "POST") {
			const body = (await readJson(req)) as { sessionId?: string; effort?: string };
			const levels = ["off", "low", "medium", "high"] as const;
			if (body.effort !== undefined && !levels.includes(body.effort as (typeof levels)[number])) {
				return json(res, 400, { error: "effort must be off|low|medium|high" });
			}
			const effort = body.effort as Effort | undefined;
			if (body.sessionId && runtimes.has(body.sessionId)) {
				const rt = runtimes.get(body.sessionId)!;
				rt.thinking = effort;
				rt.puck.agent.streamOptions = { ...rt.puck.agent.streamOptions, thinkingEffort: effort };
			} else {
				defaultThinking = effort;
			}
			return json(res, 200, { ok: true, thinking: effort ?? null });
		}

		if (url.pathname === "/api/compact" && req.method === "POST") {
			const body = (await readJson(req)) as { sessionId?: string };
			if (!body.sessionId) return json(res, 400, { error: "sessionId required" });
			const rt = runtimes.get(body.sessionId);
			if (!rt) return json(res, 400, { error: "unknown session (send a message first)" });
			if (rt.puck.agent.isStreaming) return json(res, 409, { ok: false, reason: "本轮还在运行，等结束后再压缩" });
			const messages = rt.puck.agent.messages;
			const before = estimateMessageTokens(messages);
			if (messages.length < 8 || before < 3000) {
				return json(res, 200, {
					ok: false,
					reason: `上下文还很小（${messages.length} 条消息 / ~${before} tok），无需压缩`,
				});
			}
			try {
				const result = await compactNow(messages, rt.puck.agent.streamFn);
				if (!result) {
					return json(res, 200, { ok: false, reason: "没有可折叠的历史（保留窗口已覆盖全部消息）" });
				}
				rt.puck.agent.replaceMessages(result.view);
				rt.puck.session?.recordCompaction(result.folded);
				const after = estimateMessageTokens(result.view);
				return json(res, 200, {
					ok: true,
					folded: result.folded,
					keptRecent: result.keptRecent,
					beforeTokens: before,
					afterTokens: after,
					summary: result.summary,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return json(res, 200, { ok: false, reason: `压缩失败: ${message}` });
			}
		}

		if (url.pathname === "/api/timings" && req.method === "GET") {
			return json(res, 200, aggregateByModel(timingStore.load()));
		}

		if (url.pathname === "/api/login" && req.method === "POST") {
			const body = (await readJson(req)) as { provider?: string; apiKey?: string; dryRun?: boolean };
			if (!body.provider || !body.apiKey) return json(res, 400, { error: "provider and apiKey required" });
			const provider = findProvider(body.provider);
			// dryRun: validate the key against GET /models WITHOUT storing it —
			// lets the UI offer "verify then choose" before any state change
			if (body.dryRun) {
				if (!provider) return json(res, 400, { error: `unknown provider ${body.provider}` });
				try {
					const models = await listModels(provider, body.apiKey);
					return json(res, 200, { ok: true, models });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return json(res, 200, { ok: false, error: message });
				}
			}
			credentials.write(body.provider, body.apiKey);
			// live model list after storing the key (parity: /login → pick default)
			let models: string[] = [];
			if (provider) {
				try {
					models = await listModels(provider, body.apiKey);
				} catch {
					models = []; // list unavailable — /model <id> still works
				}
			}
			return json(res, 200, { ok: true, models });
		}

		if (url.pathname === "/api/logout" && req.method === "POST") {
			const body = (await readJson(req)) as { provider?: string };
			if (!body.provider) return json(res, 400, { error: "provider required" });
			credentials.delete(body.provider);
			return json(res, 200, { ok: true });
		}

		if (url.pathname === "/api/run" && req.method === "POST") {
			const body = (await readJson(req)) as RunRequestBody;
			if (!body || typeof body.input !== "string" || !body.input.trim()) {
				return json(res, 400, { error: "input required" });
			}
			const sessionId = body.sessionId ?? randomUUID();
			const rt = getRuntime(sessionId);
			if (body.model && !options.mock && body.model !== rt.puck.modelId) {
				try {
					resolveModel(body.model);
					rt.puck.setModel(body.model);
				} catch {
					/* keep the current model; the run proceeds on it */
				}
			}
			if (body.thinkingEffort) {
				rt.thinking = body.thinkingEffort;
				rt.puck.agent.streamOptions = { ...rt.puck.agent.streamOptions, thinkingEffort: body.thinkingEffort };
			}

			// --- SSE stream ---------------------------------------------------
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			res.write(encodeSse({ type: "server_notice", message: `session ${sessionId}` }));
			res.flushHeaders?.();

			const push = (event: WebEvent): void => {
				if (!res.writableEnded) res.write(encodeSse(event));
			};

			let settled = false;
			const finish = (ok: boolean): void => {
				if (settled) return;
				settled = true;
				push({ type: "run_settled", ok });
				res.end();
			};

			const unsubscribe = rt.puck.subscribe((event: AgentEvent) => {
				push(event as WebEvent);
				if (event.type === "turn_end") {
					rt.inTokens += event.message.usage.input;
					rt.outTokens += event.message.usage.output;
				}
				if (event.type === "model_update") {
					if (event.modelId !== event.previousModelId) push({ type: "server_notice", message: `model → ${event.modelId}` });
				}
			});

			try {
				const result = await rt.puck.run(body.input);
				const failed = result.messages.find((m) => m.role === "assistant" && m.stopReason === "error");
				if (failed?.role === "assistant") push({ type: "server_error", message: failed.errorMessage ?? "run failed" });
			} catch (error) {
				push({ type: "server_error", message: error instanceof Error ? error.message : String(error) });
			} finally {
				unsubscribe();
				finish(true);
			}
			return;
		}

		json(res, 404, { error: "not found" });
	}

	const port = options.port ?? 8787;
	const host = options.host ?? "127.0.0.1";

	return {
		server,
		start: () =>
			new Promise<void>((resolveStart) => {
				server.listen(port, host, () => {
					console.log(`puck web · http://${host}:${port}${options.ui === false ? "" : " · UI /"}${options.mock ? " · mock" : ""}`);
					resolveStart();
				});
			}),
		stop: () =>
			new Promise<void>((resolveStop) => {
				for (const rt of runtimes.values()) {
					rt.detachTiming();
					rt.puck.abort();
				}
				server.close(() => resolveStop());
			}),
		/** Test seam: runtime map access. */
		_runtime: runtimes,
	};
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw.trim()) return {};
	return JSON.parse(raw) as unknown;
}
