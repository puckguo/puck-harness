/**
 * External harness session import — bring pi / codex / Claude Code history
 * into puck sessions so /resume can continue them.
 *
 * Supported source formats (each verified against real local samples):
 *
 *   pi v3    ~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl
 *            lines: {type:"message", message:{role, content:[text|thinking|toolCall], usage, model, provider}}
 *                   {type:"compaction", summary}  {type:"model_change", provider, modelId}
 *
 *   codex    ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *            lines: {type:"response_item", payload:{type:"message"|"function_call"|"function_call_output"}}
 *            call ids are unpaired (call.id ≠ output.call_id) → sequential pairing inside a turn
 *
 *   claude   ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
 *            one logical assistant message spans multiple lines (same message.id → merge)
 *            tool_use.id ↔ tool_result.tool_use_id pairs exactly
 *            isCompactSummary → compaction;  type:"ai-title" → session title
 *
 * Conversion is copy-on-import: the source file is never touched; a new puck
 * session file is materialized (id prefix `import-<source>-`).
 */

import type { AssistantMessage, Message, TextContent, ThinkingContent, ToolCall, ToolResultMessage, Usage, UserMessage } from "@puck-agent/core";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Session } from "./index.js";

export type ImportSource = "pi" | "codex" | "claude";

/** Summary of an external session, before import (picker listing). */
export interface ExternalSessionInfo {
	source: ImportSource;
	/** Absolute path of the source file. */
	path: string;
	/** Source-native session id. */
	id: string;
	title: string;
	turns: number;
	assistantMessages: number;
	toolCalls: number;
	compactions: number;
	model?: string;
	updatedAt: number;
	/**
	 * Working directory this session belongs to. Each harness exposes it
	 * differently: pi v3 stores it on the session header line, codex on
	 * `session_meta.payload.cwd`, claude on the parent directory name (no in-file
	 * cwd — we expose the slug instead, plus a `cwdMatch()` helper for filtering).
	 * `undefined` when the source can't tell us.
	 */
	cwd?: string;
}

export interface ImportOptions {
	/** Session id for the materialized puck file (default: import-<source>-<name>). */
	id?: string;
	model?: string;
}

interface Converted {
	messages: Message[];
	compactions: number;
	model?: string;
}

// ---------------------------------------------------------------------------
// file walking / scanning
// ---------------------------------------------------------------------------

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ".";

function walkJsonl(root: string, maxDepth: number): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	while (stack.length > 0) {
		const { dir, depth } = stack.pop()!;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const full = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (name.endsWith(".jsonl")) out.push(full);
			else if (isDir && depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
		}
		if (out.length > 500) break; // sanity cap
	}
	return out;
}

/** Scan all supported harness stores (~/.claude, ~/.pi, ~/.codex), newest first. */
export function scanExternalSessions(): ExternalSessionInfo[] {
	const infos: ExternalSessionInfo[] = [];
	const roots: Array<{ root: string; source: ImportSource; maxDepth: number }> = [
		{ root: join(HOME, ".claude", "projects"), source: "claude", maxDepth: 2 },
		{ root: join(HOME, ".pi", "agent", "sessions"), source: "pi", maxDepth: 2 },
		{ root: join(HOME, ".codex", "sessions"), source: "codex", maxDepth: 4 },
	];
	for (const { root, source, maxDepth } of roots) {
		for (const file of walkJsonl(root, maxDepth)) {
			try {
				infos.push(scanOne(file, source));
			} catch {
				/* unreadable — skip, never break the picker */
			}
		}
	}
	return infos.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Detect which harness wrote this JSONL ("" when unknown). */
export function detectFormat(path: string): ImportSource | "" {
	const lines = readLines(path);
	for (const line of lines.slice(0, 40)) {
		if (line.type === "session_meta") return "codex";
		if (line.type === "response_item" && line.payload) return "codex";
		if (line.type === "session" && line.version !== undefined) return "pi";
		if ((line.type === "user" || line.type === "assistant") && line.message && (line.uuid || line.parentUuid !== undefined)) return "claude";
		if (line.type === "ai-title") return "claude";
		if (line.type === "message" && line.message) return "pi";
	}
	return "";
}

// ---------------------------------------------------------------------------
// import (materialize)
// ---------------------------------------------------------------------------

/** Convert an external session file into a new puck session inside destDir. */
export function importExternalSession(path: string, destDir: string, options: ImportOptions = {}): Session {
	const detected = detectFormat(path);
	if (!detected) throw new Error("unknown session format: " + path);
	const lines = readLines(path);
	const conv =
		detected === "pi" ? piToPuck(lines) : detected === "codex" ? codexToPuck(lines) : claudeToPuck(lines);

	const id = options.id ?? `import-${detected}-${baseName(path).replace(/\.jsonl$/, "").slice(-24)}`;
	const session = Session.create(destDir, { id, model: options.model ?? conv.model });
	for (const m of sanitize(conv.messages)) session.append(m);
	for (let i = 0; i < conv.compactions; i++) session.recordCompaction();
	return session;
}

/**
 * Drop toolCalls whose output never arrived (aborted turns) — the wire API
 * rejects a toolCall without a following toolResult, so an orphan would 400
 * the first resumed request. Empty assistant messages fall away with them.
 */
function sanitize(messages: Message[]): Message[] {
	const answered = new Set<string>();
	for (const m of messages) if (m.role === "toolResult") answered.add(m.toolCallId);
	const out: Message[] = [];
	for (const m of messages) {
		if (m.role === "assistant") {
			const content = m.content.filter((c) => c.type !== "toolCall" || answered.has(c.id));
			if (content.length === 0) continue;
			out.push({ ...m, content });
		} else {
			out.push(m);
		}
	}
	// toolResults whose call was dropped keep their id — harmless on the wire
	return out;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function readLines(path: string): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			/* torn trailing line */
		}
	}
	return out;
}

function baseName(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1];
}

function asTextUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function asToolResult(toolCallId: string, toolName: string, text: string, isError: boolean, ts: number): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: ts };
}

function firstUserText(messages: Message[]): string {
	for (const m of messages) {
		if (m.role !== "user") continue;
		const text = typeof m.content === "string" ? m.content : "";
		if (text.trim() && !text.startsWith("[Context compaction]")) return text;
	}
	return "";
}

function clipTitle(text: string): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one ? (one.length > 40 ? one.slice(0, 39) + "…" : one) : "(empty)";
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => {
				const b = c as { type?: string; text?: string };
				// openai Responses API variants: input_text/output_text carry the text
				if (b?.type === "text" || b?.type === "input_text" || b?.type === "output_text") return b.text ?? "";
				return "";
			})
			.join("");
	}
	return "";
}

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

function scanOne(path: string, source: ImportSource): ExternalSessionInfo {
	const lines = readLines(path);
	const conv = source === "pi" ? piToPuck(lines) : source === "codex" ? codexToPuck(lines) : claudeToPuck(lines);
	const info: ExternalSessionInfo = {
		source,
		path,
		id: "",
		title: clipTitle(firstUserText(conv.messages)),
		turns: conv.messages.filter((m) => m.role === "user" && !(typeof m.content === "string" && m.content.startsWith("[Context compaction]"))).length,
		assistantMessages: conv.messages.filter((m) => m.role === "assistant").length,
		toolCalls: conv.messages.reduce((n, m) => (m.role === "assistant" ? n + m.content.filter((c) => c.type === "toolCall").length : n), 0),
		compactions: conv.compactions,
		model: conv.model,
		updatedAt: mtimeOf(path),
	};
	// native ids + free titles + cwd
	// pi v3 + claude: cwd is encoded in the parent directory name (each harness
	// has its own encoding scheme — see piCwdSlug / claudeCwdSlug). codex
	// embeds cwd verbatim in `session_meta.payload.cwd`.
	if (source === "pi") {
		const header = lines.find((l) => l.type === "session") as { id?: string } | undefined;
		if (header?.id) info.id = header.id;
		info.cwd = basenameOfPath(path);
	} else if (source === "claude") {
		// first "user"-type line carries sessionId; ai-title overrides the title
		for (const l of lines) {
			if (l.sessionId) {
				info.id = String(l.sessionId);
				break;
			}
		}
		const t = lines.find((l) => l.type === "ai-title") as { aiTitle?: string } | undefined;
		if (t?.aiTitle) info.title = t.aiTitle;
		// claude code: parent dir IS the cwd slug (no in-file cwd field)
		info.cwd = basenameOfPath(path);
	} else {
		const meta = lines.find((l) => l.type === "session_meta") as { payload?: { session_id?: string; cwd?: string } } | undefined;
		if (meta?.payload?.session_id) info.id = meta.payload.session_id;
		if (meta?.payload?.cwd) info.cwd = meta.payload.cwd;
	}
	return info;
}

function basenameOfPath(p: string): string {
	const parts = p.split(/[\\/]/);
	return parts[parts.length - 2] ?? ""; // parent directory of the .jsonl file
}

/**
 * pi v3 stores sessions under `<sessionsRoot>/<encodeCwd(cwd)>/<file>.jsonl`.
 * This mirrors the slug scheme pi itself uses (`--<sanitized-cwd>--`) so a
 * session's parent dir name equals encodeCwd(originalCwd). Both sides agree on
 * the encoding, which makes comparison exact without decoding (decoding is
 * ambiguous because `-` is also legal in directory names).
 */
export function piCwdSlug(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Claude Code uses a simpler slug: `\` and `:` each become `-`, no `--`
 * delimiters. From samples:
 *   C--guo-SoftwareDevelopment-AIcoach-SmartExerciseEval → C:\guo\SoftwareDevelopment\AIcoach\SmartExerciseEval
 */
export function claudeCwdSlug(cwd: string): string {
	return cwd.replace(/[\\/]/g, "-").replace(/:/g, "-");
}

/**
 * True when `info` was started in `cwd` (current working directory). Comparison
 * strategy depends on source:
 *   pi v3       — exact slug match (parent dir name === encodeCwd(cwd))
 *   codex       — case-insensitive path comparison after normalizing separators
 *   claude code — exact slug match (parent dir name === encodeCwd(cwd))
 */
export function cwdMatches(cwd: string, info: ExternalSessionInfo): boolean {
	if (!info.cwd) return false;
	if (info.source === "pi") return info.cwd === piCwdSlug(cwd);
	if (info.source === "claude") return info.cwd === claudeCwdSlug(cwd);
	// codex: compare normalized paths (cwd is stored verbatim in session_meta)
	return normalizePath(info.cwd) === normalizePath(cwd);
}

function normalizePath(p: string): string {
	return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

interface PiLine {
	type: string;
	message?: {
		role: string;
		content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
		model?: string;
		provider?: string;
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
		timestamp?: number;
	};
	summary?: string;
	provider?: string;
	modelId?: string;
}

function piToPuck(lines: Array<Record<string, unknown>>): Converted {
	const messages: Message[] = [];
	let compactions = 0;
	let model: string | undefined;

	for (const raw of lines) {
		const e = raw as unknown as PiLine;
		if (e.type === "model_change" && e.provider && e.modelId) {
			model = `${e.provider}/${e.modelId}`;
		} else if (e.type === "compaction" && e.summary) {
			compactions++;
			messages.push(asTextUser("[Context compaction] The beginning of this conversation was summarized:\n\n" + e.summary, Date.now()));
		} else if (e.type === "message" && e.message) {
			const m = e.message;
			const ts = m.timestamp ?? Date.now();
			if (m.role === "user") {
				const text = contentText(m.content);
				if (text.trim()) messages.push(asTextUser(text, ts));
			} else if (m.role === "assistant") {
				const content: Array<TextContent | ThinkingContent | ToolCall> = [];
				for (const c of m.content ?? []) {
					if (c.type === "text" && c.text) content.push({ type: "text", text: c.text });
					else if (c.type === "thinking" && c.thinking) content.push({ type: "thinking", thinking: c.thinking });
					else if (c.type === "toolCall" && c.id && c.name) content.push({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments ?? {} });
				}
				if (content.length === 0) continue;
				if (m.provider) model = `${m.provider}/${m.model ?? "unknown"}`;
				messages.push({
					role: "assistant",
					content,
					model: model ?? m.model ?? "unknown",
					stopReason: "stop",
					usage: {
						input: m.usage?.input ?? 0,
						output: m.usage?.output ?? 0,
						cacheRead: m.usage?.cacheRead,
						cacheWrite: m.usage?.cacheWrite,
						totalTokens: m.usage?.totalTokens ?? 0,
					},
					timestamp: ts,
				} satisfies AssistantMessage);
			} else if (m.role === "toolResult") {
				const tr = m as unknown as { toolCallId?: string; toolName?: string; content?: unknown };
				if (tr.toolCallId && tr.toolName) {
					messages.push(asToolResult(tr.toolCallId, tr.toolName, contentText(tr.content), false, ts));
				}
			}
		}
	}
	return { messages, compactions, model };
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

interface CodexPayload {
	type: string;
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	id?: string;
	name?: string;
	arguments?: string;
	call_id?: string;
	output?: string;
}

function isNoise(text: string): boolean {
	return (
		text.startsWith("<environment_context>") ||
		text.startsWith("<user_instructions>") ||
		text.startsWith("# AGENTS.md") ||
		text.startsWith("<permissions instructions>")
	);
}

function codexToPuck(lines: Array<Record<string, unknown>>): Converted {
	const messages: Message[] = [];
	let model: string | undefined;
	// sequential pairing: remember pending function_calls; the next output closes the oldest
	const pending: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

	for (const raw of lines) {
		const line = raw as { type?: string; payload?: CodexPayload };
		if (line.type === "turn_context") {
			const tc = raw as unknown as { payload?: { model?: string } };
			if (tc.payload?.model) model = `openai/${tc.payload.model}`;
		}
		if (line.type !== "response_item" || !line.payload) continue;
		const p = line.payload;

		if (p.type === "message" && p.role) {
			const text = contentText(p.content);
			if (!text.trim()) continue;
			if (p.role === "user") {
				if (isNoise(text)) continue;
				messages.push(asTextUser(text, Date.now()));
			} else if (p.role === "assistant") {
				messages.push({
					role: "assistant",
					content: [{ type: "text", text }],
					model: model ?? "openai/unknown",
					stopReason: "stop",
					usage: { input: 0, output: 0, totalTokens: 0 },
					timestamp: Date.now(),
				} satisfies AssistantMessage);
			}
			// developer / system → dropped (harness-injected noise)
		} else if (p.type === "function_call" && p.name) {
			let args: Record<string, unknown> = {};
			try {
				args = p.arguments ? (JSON.parse(p.arguments) as Record<string, unknown>) : {};
			} catch {
				/* keep empty args */
			}
			const call = { id: p.id ?? p.call_id ?? `codex-${pending.length}`, name: p.name, arguments: args };
			pending.push(call);
			// the toolCall lives on an assistant message (puck transcript shape);
			// its output (next function_call_output) closes it via the FIFO queue
			messages.push({
				role: "assistant",
				content: [{ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments }],
				model: model ?? "openai/unknown",
				stopReason: "stop",
				usage: { input: 0, output: 0, totalTokens: 0 },
				timestamp: Date.now(),
			} satisfies AssistantMessage);
		} else if (p.type === "function_call_output") {
			// close the oldest pending call (codex ids do not pair exactly)
			const call = pending.shift();
			if (call) {
				messages.push(asToolResult(call.id, call.name, String(p.output ?? ""), false, Date.now()));
			}
		}
	}
	// pending calls that never got an output are already on assistant messages —
	// dropping their toolResult is the safest transcript shape (宁缺毋滥)
	return { messages, compactions: 0, model };
}

// ---------------------------------------------------------------------------
// claude code
// ---------------------------------------------------------------------------

interface ClaudeLine {
	type: string;
	uuid?: string;
	parentUuid?: string | null;
	isSidechain?: boolean;
	isCompactSummary?: boolean;
	message?: {
		id?: string;
		role?: string;
		model?: string;
		content?: string | Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }>;
		usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
	};
	messageId?: string;
	aiTitle?: string;
	timestamp?: string;
}

function claudeToPuck(lines: Array<Record<string, unknown>>): Converted {
	const messages: Message[] = [];
	let compactions = 0;
	let model: string | undefined;
	const ts = () => Date.now();

	// pass 1: main-chain message lines, in file order (sidechain = subagent, skipped)
	const entries = lines
		.map((l) => l as unknown as ClaudeLine)
		.filter((l) => (l.type === "user" || l.type === "assistant") && l.message && !l.isSidechain);

	// pass 2: merge assistant runs sharing message.id into one logical message
	const merged: ClaudeLine[] = [];
	for (const e of entries) {
		const prev = merged[merged.length - 1];
		if (
			e.message?.id &&
			prev?.message?.id &&
			e.message.id === prev.message.id &&
			e.type === "assistant" &&
			prev.type === "assistant"
		) {
			// concat content blocks; usage is per-span incremental → accumulate
			const a = Array.isArray(prev.message.content) ? prev.message.content : [];
			const b = Array.isArray(e.message.content) ? e.message.content : [];
			prev.message.content = [...a, ...b];
			const ua = prev.message.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined;
			const ub = e.message.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined;
			if (ua && ub) {
				prev.message.usage = {
					input_tokens: (ua.input_tokens ?? 0) + (ub.input_tokens ?? 0),
					output_tokens: (ua.output_tokens ?? 0) + (ub.output_tokens ?? 0),
					cache_read_input_tokens: (ua.cache_read_input_tokens ?? 0) + (ub.cache_read_input_tokens ?? 0),
				};
			} else if (ub) prev.message.usage = ub;
			continue;
		}
		merged.push(e);
	}

	for (const e of merged) {
		const m = e.message!;
		if (e.type === "user") {
			if (e.isCompactSummary) {
				compactions++;
				const text = contentText(m.content);
				if (text) messages.push(asTextUser("[Context compaction] The beginning of this conversation was summarized:\n\n" + text, ts()));
				continue;
			}
			if (typeof m.content === "string") {
				if (m.content.trim()) messages.push(asTextUser(m.content, ts()));
			} else if (Array.isArray(m.content)) {
				// split: text blocks → user message; tool_result blocks → toolResult messages (id-paired)
				const textBlocks = m.content.filter((c) => c.type === "text" && c.text && c.text !== "[Request interrupted by user]");
				const texts = textBlocks.map((c) => c.text!).join("");
				if (texts.trim()) messages.push(asTextUser(texts, ts()));
				for (const c of m.content) {
					if (c.type === "tool_result" && c.tool_use_id) {
						const inner = typeof c.content === "string" ? c.content : contentText(c.content);
						messages.push(asToolResult(c.tool_use_id, "tool", inner, Boolean((c as { is_error?: boolean }).is_error), ts()));
					}
				}
			}
		} else if (e.type === "assistant") {
			const blocks = Array.isArray(m.content) ? m.content : [];
			const content: Array<TextContent | ThinkingContent | ToolCall> = [];
			for (const c of blocks) {
				if (c.type === "text" && c.text) content.push({ type: "text", text: c.text });
				else if (c.type === "thinking" && c.thinking) content.push({ type: "thinking", thinking: c.thinking });
				else if (c.type === "tool_use" && c.id && c.name) content.push({ type: "toolCall", id: c.id, name: c.name, arguments: c.input ?? {} });
			}
			if (content.length === 0) continue;
			if (m.model) model = m.model;
			messages.push({
				role: "assistant",
				content,
				model: model ?? "unknown",
				stopReason: "stop",
				usage: {
					input: m.usage?.input_tokens ?? 0,
					output: m.usage?.output_tokens ?? 0,
					cacheRead: m.usage?.cache_read_input_tokens,
					cacheWrite: m.usage?.cache_creation_input_tokens,
					totalTokens: (m.usage?.input_tokens ?? 0) + (m.usage?.output_tokens ?? 0),
				},
				timestamp: ts(),
			} satisfies AssistantMessage);
		}
	}
	return { messages, compactions, model };
}
