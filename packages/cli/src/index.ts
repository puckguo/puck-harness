#!/usr/bin/env node
/**
 * puck CLI — a minimal REPL coding agent.
 *
 *   puck                        # interactive, model from config/env/default
 *   puck --model deepseek-chat
 *   puck --mock                 # offline demo with a scripted model
 *   puck "one shot prompt"      # single prompt, then exit
 *
 * Slash commands inside the REPL:
 *   /login [provider]           # store an API key (~/.puck/auth.json)
 *   /logout [provider]
 *   /models                     # live model list per configured provider
 *   /model <id|provider/id>     # switch model (this session + default)
 *   /status                     # current model / session / keys
 */

import type { AgentEvent, LoopHooks, Message } from "@puckguo123/core";
import { estimateMessageTokens } from "@puckguo123/core";
import { compactNow } from "@puckguo123/features/compaction";
import { RewindStore, applyFileOps, type Checkpoint } from "@puckguo123/features/rewind";
import { createIndexedSkillTool, loadHarnessSkillsIndexed, skillsIndexToPrompt, type SkillIndex } from "@puckguo123/features/skills";
import { createMockStreamFn, createStreamFn, discoverUsableModels, FileCredentialStore, findProvider, listModels, listProviders, loginProvider, logoutProvider, PROVIDERS, resolveApiKey, resolveModel, resolveProviderApiKey } from "@puckguo123/llm";
import { createPuck, DEFAULT_CODING_PROMPT, getDefaultModel, setDefaultModel } from "@puckguo123/sdk";
import { createCodingTools } from "@puckguo123/tools";
import { Session, SessionStore, scanForeignSessions } from "@puckguo123/session";
import { ConversationStore } from "@puckguo123/store";
import { IdleTaskScheduler, loadAgentContext, memoryStats, runDailySummary, runLongTermDistill, type ContextSource } from "@puckguo123/memory";
import { importExternalSession, scanExternalSessions, type ExternalSessionInfo, type ImportSource, cwdMatches } from "@puckguo123/session/import";
import { aggregateByModel, analyzeTimings, detectAnomalies, formatMs, generateDashboard, TimingCollector, TimingStore } from "@puckguo123/timing";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { buildBar, renderBar, renderEditDiff, renderToolEnd, SlashPopup, Spinner, TerminalChrome, FileTrail, renderTrail, selectFromList, queryCursorPosition, WorkingTitle, formatTokens, summarizeTurn, QueuedInput, clipCp, renderQueueRows, parseInterject, DoubleEscDetector, watchStandaloneEsc, type SlashCommand, type TurnSummary, type QueueViewState } from "./term.js";
import { errorLogPath, logError } from "./errorlog.js";
import { expandFileMentions, FileIndex, MentionPopup, type ReadFileResult } from "./filemention.js";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { puckDir } from "@puckguo123/llm";

/** Slash commands — single source for /help and the live popup. */
const SLASH_COMMANDS: SlashCommand[] = [
	{ name: "login", args: "[provider]", desc: "接入 provider / 存 API key（无参 = 选择器）" },
	{ name: "logout", args: "<provider>", desc: "移除已存的 key" },
	{ name: "models", desc: "列出已接入 provider 的可用模型（实时）" },
	{ name: "model", args: "<id>", desc: "切换模型（provider/model，同时设为默认）" },
	{ name: "think", args: "[off|low|medium|high]", desc: "调整 thinking 等级（下一轮生效）" },
	{ name: "compact", desc: "手动压缩上下文（摘要折叠旧对话，保留最近轮）" },
	{ name: "clear", desc: "清空上下文，开始新对话（原会话保留在磁盘，可 /resume 找回）" },
	{ name: "rewind", desc: "回退到之前的节点（双击 Esc 同样触发）：对话 / 代码 / 两者" },
	{ name: "resume", desc: "选择一个历史会话继续对话（默认当前项目；a 切全部目录：各项目的 puck + pi/codex/claude）" },
	{ name: "memory", desc: "记忆系统：agent.md / experience / 每日总结" },
	{ name: "skills", desc: "已加载的技能清单（来自 ~/.puck · ~/.claude · ~/.codex · ~/.pi 的 skills 目录）" },
	{ name: "tasks", desc: "后台任务目录与状态（每日总结等，空闲时运行）" },
	{ name: "recall", args: "<关键词>", desc: "跨项目搜索历史对话（sqlite 索引）" },
	{ name: "prompt", desc: "查看系统提示组成：各文件、路径、字数（↑↓ 选择查看内容）" },
	{ name: "status", desc: "当前模型 / 会话 / key 状态" },
	{ name: "timings", desc: "模型用时统计摘要" },
	{ name: "help", desc: "显示命令帮助" },
];

/**
 * Sensible first model per provider, used only when a key exists but the user
 * never picked a default (real lists come from GET /models after login).
 */
const FALLBACK_MODEL_BY_PROVIDER: Record<string, string> = {
	anthropic: 'claude-sonnet-4-5',
	deepseek: 'deepseek-chat',
	groq: 'llama-3.3-70b-versatile',
	minimax: 'MiniMax-M3',
	'minimax-cn': 'MiniMax-M3',
	moonshot: 'kimi-k2-0905-vision-preview',
	'moonshot-cn': 'kimi-k2-0905-vision-preview',
	openai: 'gpt-4o',
	openrouter: 'openrouter/auto',
	ollama: 'qwen3:8b',
	'qwen-token-plan': 'qwen3-coder-plus',
	'qwen-token-plan-cn': 'qwen3-coder-plus',
	xai: 'grok-4',
};

interface CliArgs {
	model: string;
	mock: boolean;
	noMemory: boolean;
	noSkills: boolean;
	sessionId?: string;
	prompt?: string;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { model: process.env.PUCK_MODEL ?? getDefaultModel() ?? "", mock: false, noMemory: false, noSkills: false };
	const positional: string[] = [];
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--model" || arg === "-m") args.model = argv[++i];
		else if (arg === "--mock") args.mock = true;
		else if (arg === "--no-memory") args.noMemory = true;
		else if (arg === "--no-skills") args.noSkills = true;
		else if (arg === "--session" || arg === "-s") args.sessionId = argv[++i];
		else if (arg === "--help" || arg === "-h") {
			console.log("usage: puck [--model <id>] [--mock] [--session <id>] [--no-memory] [--no-skills] [prompt]");
			console.log("       puck timings [--html] [--analyze] [--model <id>] [--last N] [--clear]");
			console.log("       puck login [provider]   interactive API key setup");
			process.exit(0);
		} else positional.push(arg);
	}
	args.prompt = positional.join(" ") || undefined;
	return args;
}

const MOCK_SCRIPT = [
	{
		// delayMs exercises the spinner path (silent period ≥ one spinner tick)
		thinking: "The user wants a demo. I should run a command first to show tool output.",
		text: "Let me check the current directory first.",
		delayMs: 700,
		toolCalls: [
			{ name: "bash", arguments: { command: "echo hello from puck" } },
			{ name: "write", arguments: { path: "puck-demo.txt", content: "written by the mock model" } },
		],
	},
	{ text: "The mock model ran the command. puck works — try a real model with /model MiniMax-M3!", delayMs: 300 },
];

/**
 * Steering (interjection) — a queued line optionally injected into the
 * RUNNING conversation via the agent's steering queue: it lands as a user
 * message right before the next LLM call, so the model can react to it
 * mid-task instead of only after the whole run settles.
 */
const STEER_TAG = "【插队消息】";

/** Wrap an interjected line so the model knows it arrived while it was working. */
const steeringMessage = (text: string): string =>
	`${STEER_TAG}用户在任务执行期间插入了下面的新指令。请把它作为当前最高优先级立即处理，并结合它调整接下来的做法；若原任务仍需完成，处理完插入内容后请继续完成原任务。\n\n${text}`;

/** Strip the steering wrapper for terminal display (show only what the user typed). */
const steeringDisplay = (text: string): string => {
	if (!text.startsWith(STEER_TAG)) return text;
	const body = text.indexOf("\n\n");
	return body >= 0 ? text.slice(body + 2) : text;
};

/**
 * REPL event renderer. Returns the event handler plus `beginRun()` — call it
 * the moment the user presses Enter on a chat message so the inline stats
 * measure the user-perceived span (Enter → output done), not just the last
 * LLM turn of a multi-turn (tool-calling) run.
 */
/**
 * Output color roles — one visual class per content type (docs/usage.md §终端体验).
 * body stays default so model text reads as “正文”; everything else is tinted.
 * Auto-disabled when stdout is piped (one-shot/script mode stays byte-clean).
 */
const NO_COLOR = "";
const ttyOut = Boolean(process.stdout.isTTY);
const COLORS = ttyOut
	? {
			user: "\x1b[36m", // cyan — user prompt & echo
			think: "\x1b[90m", // light gray — model thinking (浅色，区别于正文)
			command: "\x1b[35m", // magenta — executed commands
			path: "\x1b[94m", // bright blue — file paths
			ok: "\x1b[32m", // green — success
			err: "\x1b[31m", // red — errors
			dim: "\x1b[2m", // faint — meta / stats / labels
			reset: "\x1b[0m",
		}
	: { user: NO_COLOR, think: NO_COLOR, command: NO_COLOR, path: NO_COLOR, ok: NO_COLOR, err: NO_COLOR, dim: NO_COLOR, reset: NO_COLOR };

/**
 * Per-harness accent colors used by the /resume picker. Each harness gets
 * its own color so the `[puck]` / `[pi]` / `[claude]` / `[codex]` source tag
 * is glanceable in the list — users mixing sessions across harnesses can
 * filter visually without reading the prefix. Color is purely cosmetic and
 * degrades to plain text in non-TTY mode (see COLORS above).
 *
 * puck also gets a tag (blue) so every row identifies its harness — without
 * it the cwd-scoped view (which drops the cwd segment because every row
 * shares it) would leave puck rows unlabeled, looking indistinguishable
 * from misclassified external entries.
 */
const SOURCE_COLORS: Record<"puck" | ImportSource, string> = ttyOut
	? {
			puck: "\x1b[34m", // blue — puck sessions (this harness)
			pi: "\x1b[36m", // cyan — pi sessions
			claude: "\x1b[35m", // magenta — claude code sessions
			codex: "\x1b[32m", // green — codex sessions
		}
	: { puck: "", pi: "", claude: "", codex: "" };

function renderEvents(hooks?: { onFileTouched?: (path: string) => void; onTurnSummary?: (summary: TurnSummary) => void; onError?: (info: { kind: string; error: unknown; context?: Record<string, unknown> }) => void }): ((event: AgentEvent) => void) & { beginRun: (prefix?: string) => void; setIdleTitle: (title?: string) => void } {
	// Per-class streaming state: append-only deltas for thinking (gray) and
	// text (body) parts — thinking must stream visibly, it IS the wait explanation.
	let renderedThink = "";
	let renderedText = "";
	let turnStartAt: number | undefined;
	// User messages seen since run_start. #1 is the run's own prompt (already
	// echoed by the REPL); any later one is a steering injection → echo it in
	// the stream where it lands. Counting (not position) survives injections
	// that arrive before the first turn_start (concurrent pipe-mode prompts).
	let userMsgCount = 0;
	// Run anchor = Enter keypress (via beginRun; falls back to the first
	// turn_start for callers that never call beginRun, e.g. one-shot mode).
	let runStartAt: number | undefined;
	// First streamed assistant text of the WHOLE run (Enter → first token),
	// NOT reset per turn — tool turns in between must not re-measure it.
	let firstTokenAt: number | undefined;
	// Args of in-flight tool calls (call id → args), kept only until tool_end —
	// gives onError the exact model arguments behind a failed call.
	const toolArgs = new Map<string, unknown>();
	const renderContent = (content: Array<{ type: string; thinking?: string; text?: string }>): void => {
		const think = content
			.filter((c) => c.type === "thinking")
			.map((c) => c.thinking ?? "")
			.join("");
		const text = content
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		// first visible delta of a phase: retire the spinner, restore the prompt prefix
		if (spinner.active && (think.length > renderedThink.length || text.length > renderedText.length)) {
			spinner.stop(runPrefix);
		}
		// append-only: a non-prefix (interleaved rewrite) is skipped, never duplicated
		if (think.startsWith(renderedThink) && think.length > renderedThink.length) {
			process.stdout.write(COLORS.think + think.slice(renderedThink.length) + COLORS.reset);
			renderedThink = think;
		}
		if (text.startsWith(renderedText) && text.length > renderedText.length) {
			// first visible answer after streamed thinking: newline separator
			if (renderedThink && !renderedText) process.stdout.write("\n");
			process.stdout.write(text.slice(renderedText.length));
			renderedText = text;
		}
	};
	const spinner = new Spinner(Boolean(process.stdout.isTTY));
	// terminal-title animation spans the whole run (turns + tools), not just silent periods
	const workingTitle = new WorkingTitle();
	// prefix re-emitted after the spinner clears (set by beginRun; "" in one-shot)
	let runPrefix = "";
	/**
	 * Echo an interjected (steering) user message at the spot where it lands
	 * in the run. Retires the spinner first so the echo owns a full line and
	 * the next turn's answer starts BELOW it — visual order matches time
	 * order. The steering wrapper is stripped; only the user's text shows.
	 */
	const echoSteering = (message: Message): void => {
		const raw =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? (message.content as Array<{ type?: string; text?: string }>).filter((b) => b?.type === "text").map((b) => b.text ?? "").join(" ")
					: "";
		const text = steeringDisplay(raw).replace(/\s+$/, "");
		if (!text) return;
		const onSpinnerLine = spinner.active;
		spinner.stop();
		const lines = text.split("\n");
		const one = clipCp(lines[0], 100);
		const more = lines.length > 1 ? " " + COLORS.dim + `…(+${lines.length - 1}行)` + COLORS.reset : "";
		process.stdout.write((onSpinnerLine ? "" : "\n") + COLORS.user + "you ›" + COLORS.reset + " " + one + more + COLORS.dim + "  ⤵ 已插队" + COLORS.reset + "\n");
	};
	const handler = (event: AgentEvent): void => {
		switch (event.type) {
			case "run_start":
				userMsgCount = 0; // #1 will be this run's own prompt
				break;
			case "turn_start":
				if (runStartAt === undefined) runStartAt = Date.now();
				turnStartAt = Date.now();
				workingTitle.start(); // one-shot mode has no beginRun anchor
				if (!spinner.active) spinner.start(runPrefix, "thinking");
				break;
			case "message_update":
				if (event.message.role === "assistant" && firstTokenAt === undefined && runStartAt !== undefined) {
					firstTokenAt = Date.now() - runStartAt;
				}
				if (event.message.role === "assistant") renderContent(event.message.content);
				break;
			case "message_start":
				if (event.message.role === "assistant") renderContent(event.message.content);
				break;
			case "message_end":
				if (event.message.role === "user") {
					// #1 = the run's own prompt (the REPL already echoed it); later ones
					// are steering injections — echo them where they land in the stream
					if (userMsgCount >= 1) echoSteering(event.message);
					userMsgCount++;
				}
				if (event.message.role === "assistant") {
					if (event.message.stopReason === "error") {
						hooks?.onError?.({ kind: "api", error: event.message.errorMessage ?? "unknown API error" });
						process.stdout.write(`${COLORS.err}✗ ${event.message.errorMessage ?? "error"}${COLORS.reset}\n`);
					}
					// aborted: partial thinking/text already streamed — mark the cutoff so
					// the transcript boundary is visible (matches the "⏹ 已停止" line)
					if (event.message.stopReason === "aborted") {
							process.stdout.write(`${COLORS.dim}⏹ 已中止（部分输出可能不完整）${COLORS.reset}\n`);
					}
					spinner.stop(runPrefix);
				if ((renderedThink || renderedText) && !(renderedText || "").endsWith("\n")) process.stdout.write("\n");
					renderedThink = "";
					renderedText = "";
				}
				break;
			case "tool_start":
				spinner.stop();
				toolArgs.set(event.toolCallId, event.args);
				if (event.toolName === "write" || event.toolName === "edit") {
					const touched = (event.args as { path?: string } | undefined)?.path;
					if (touched) hooks?.onFileTouched?.(touched);
				}
				process.stdout.write(renderToolStart(event.toolName, event.args));
				break;
			case "tool_end": {
				const failedArgs = toolArgs.get(event.toolCallId);
				toolArgs.delete(event.toolCallId);
				if (event.isError) {
					const text = (event.result.content ?? [])
						.filter((c) => c.type === "text")
						.map((c) => c.text ?? "")
						.join("\n");
					hooks?.onError?.({ kind: "tool", error: text || "tool failed", context: { tool: event.toolName, args: failedArgs } });
				}
				const mark = event.isError ? `${COLORS.err}❌ ${event.toolName}${COLORS.reset}\n` : `${COLORS.ok}✅ ${event.toolName}${COLORS.reset}\n`;
				process.stdout.write(mark + renderToolEnd(event.result));
				// tools done → the next LLM turn is another silent period
				spinner.start(runPrefix, "thinking");
				break;
			}
			case "run_end": {
				spinner.stop();
				// last-turn summary: title carries a few words, the bar a one-liner —
				// glanceable "what was the last turn about" without scrolling back
				const summary = summarizeTurn(event.messages);
				workingTitle.stop(summary.short ? `puck · ${summary.short}` : "puck");
				hooks?.onTurnSummary?.(summary);
				const usage = event.messages.reduce(
					(total, m) => (m.role === "assistant" ? total + (m.usage.totalTokens ?? 0) : total),
					0,
				);
				const parts = [`${usage} tokens`];
				if (firstTokenAt !== undefined) parts.push(`首字 ${formatMs(firstTokenAt)}`);
				// 本轮 = Enter → final output done (user-perceived wall clock; includes
				// all LLM turns + tool executions in between)
				if (runStartAt !== undefined) parts.push(`本轮 ${formatMs(Date.now() - runStartAt)}`);
				process.stdout.write(`${COLORS.dim}— ${parts.join(" · ")} —${COLORS.reset}\n`);
				turnStartAt = undefined;
				firstTokenAt = undefined;
				runStartAt = undefined;
				break;
			}
			default:
				break;
		}
	};
	handler.beginRun = (prefix = ""): void => {
		runStartAt = Date.now();
		firstTokenAt = undefined;
		runPrefix = prefix;
		workingTitle.start();
	};
	/** Reset/replace the idle title (e.g. /clear drops the last-turn summary). */
	handler.setIdleTitle = (title = "puck"): void => {
		workingTitle.stop(title);
	};
	return handler;
}

/** One colored line per tool invocation — each tool class gets its accent. */
/**
 * Replay a hydrated session transcript into the terminal scrollback — the
 * same rendering as a live run (user echo, gray thinking, tool lines, folded
 * results), so /resume lands you back INSIDE the conversation instead of a
 * blank screen. Long thinking/user messages are clipped; tool output uses the
 * live 3-line fold.
 */
function renderHistory(messages: readonly Message[]): void {
	const textOf = (blocks: ReadonlyArray<{ type?: string; text?: string }>): string =>
		blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
	for (const m of messages) {
		if (m.role === "user") {
			const text = typeof m.content === "string" ? m.content : textOf(m.content);
			if (!text.trim()) continue;
			const lines = text.replace(/\s+$/, "").split("\n");
			process.stdout.write("\n" + COLORS.user + "you ›" + COLORS.reset + " " + lines.slice(0, 12).join("\n"));
			if (lines.length > 12) process.stdout.write("\n" + COLORS.dim + `… (+${lines.length - 12} 行)` + COLORS.reset);
			process.stdout.write("\n");
		} else if (m.role === "assistant") {
			const think = m.content.filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking").map((b) => b.thinking ?? "").join("");
			if (think.trim()) {
				const lines = think.trim().split("\n");
				process.stdout.write(COLORS.think + lines.slice(0, 3).join("\n") + (lines.length > 3 ? COLORS.dim + `\n… (思考共 ${lines.length} 行)` + COLORS.reset : "") + COLORS.reset + "\n");
			}
			const text = textOf(m.content).replace(/\s+$/, "");
			if (text) process.stdout.write(text + "\n");
			for (const block of m.content) {
				if (block.type === "toolCall") process.stdout.write(renderToolStart(block.name, block.arguments));
			}
		} else if (m.role === "toolResult") {
			const mark = m.isError ? COLORS.err + "❌ " + m.toolName + COLORS.reset + "\n" : COLORS.ok + "✅ " + m.toolName + COLORS.reset + "\n";
			process.stdout.write(mark + renderToolEnd({ content: m.content }));
		}
	}
}




/** "3 分钟前 / 2 小时前 / 昨天 / 3 天前 / 2026-08-01" for the resume picker. */
function relativeTime(ts: number): string {
	const diff = Date.now() - ts;
	const min = Math.floor(diff / 60_000);
	if (min < 1) return "刚刚";
	if (min < 60) return `${min} 分钟前`;
	const hours = Math.floor(min / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.floor(hours / 24);
	if (days === 1) return "昨天";
	if (days < 7) return `${days} 天前`;
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderToolStart(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const brief = (s: string): string => {
		const one = s.replace(/\s*\n\s*/g, " ⌉ ");
		return one.length > 110 ? one.slice(0, 109) + "…" : one;
	};
	const label = COLORS.dim + "⏳ " + name + COLORS.reset;
	let operand: string;
	if (name === "bash") operand = COLORS.command + "$ " + brief(String(a.command ?? "")) + COLORS.reset;
	else if (name === "read") operand = COLORS.path + brief(String(a.path ?? "")) + COLORS.reset;
	else if (name === "write") operand = COLORS.path + "write " + brief(String(a.path ?? "")) + COLORS.reset;
	else if (name === "edit") operand = COLORS.path + "edit " + brief(String(a.path ?? "")) + COLORS.reset + renderEditDiff(a.edits);
	else operand = brief(JSON.stringify(args));
	return label + " " + operand + "\n";
}




/** Hidden-input prompt: echoes nothing while typing (classic readline mute). */
function promptSecret(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	// One code path for TTY and pipes: askLine (LineQueue). No echo-muting hack:
	// wrapping rl.output.write breaks real readline terminals — readline calls
	// write(chunk, encoding, cb) and cursorTo/clearLine internally on every
	// keypress, and muting before printing swallows the prompt itself (the
	// exact "hang" users hit: no prompt, no echo, input seemingly dead).
	// The key is echoed while typing; acceptable for a local terminal.
	process.stdout.write(question);
	return askLine(rl).then((answer) => answer.trim());
}

async function printModels(credentials: FileCredentialStore, currentModel: string | undefined): Promise<void> {
	console.log("\x1b[1mModels\x1b[0m — 按已接入 provider 实时拉取（/model 切换）：");
	const usable = await discoverUsableModels(credentials);
	if (usable.length === 0) {
		console.log("  (还没有接入任何 provider — /login 接入)");
		return;
	}
	for (const { provider, models } of usable) {
		console.log("\x1b[36m" + provider.name + "\x1b[0m (" + provider.id + ") — " + models.length + " 个模型:");
		for (const id of models.slice(0, 20)) {
			const marker = id === currentModel ? "\x1b[36m●\x1b[0m " : "  ";
			console.log(marker + id);
		}
		if (models.length > 20) console.log("  … 还有 " + (models.length - 20) + " 个");
	}
}

/** pi provider/model stays as-is; claude/codex native ids are kept verbatim. */
function chosenModelOf(info: ExternalSessionInfo): string | undefined {
	return info.model;
}

/**
 * Build the canonical puck id for an external session — used by both /resume
 * (unified picker) and the import path so the same source file always maps to
 * the same puck session, making re-imports idempotent.
 */
function externalSessionId(info: ExternalSessionInfo): string {
	return `import-${info.source}-${info.id.slice(-20) || baseNameOf(info.path).slice(0, 20)}`;
}

function baseNameOf(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1];
}

/** Rows of the global session index (~/.puck/index.db) for cross-project
 * /resume discovery. Prefers the already-open store from the memory layer;
 * otherwise opens the db directly — but only when the file exists, so
 * --no-memory runs never create an index as a side effect of /resume. */
async function indexSessionRows(context: { memory?: { store: ConversationStore | null } }): Promise<Array<{ id: string; project: string }>> {
	let store = context.memory?.store ?? null;
	let opened = false;
	if (!store) {
		const dbPath = join(puckDir(), "index.db");
		if (!existsSync(dbPath)) return [];
		store = await ConversationStore.open(dbPath);
		opened = true;
	}
	if (!store) return [];
	try {
		return store.allSessions().flatMap((r) => (r.id && r.project ? [{ id: r.id, project: r.project }] : []));
	} catch {
		return [];
	} finally {
		if (opened) store.close();
	}
}

/** Project dir a session FILE belongs to, for the canonical
 * `<project>/.puck/sessions/<id>.jsonl` layout. Undefined for non-standard
 * store depths (SDK users may pass any dir) — callers then fall back to
 * process.cwd(). */
function sessionProjectOf(session: { path: string } | undefined): string | undefined {
	if (!session?.path) return undefined;
	try {
		const file = resolve(session.path);
		const sessionsDir = dirname(file); // .../<project>/.puck/sessions
		const dotPuck = dirname(sessionsDir); // .../<project>/.puck
		if (basename(dotPuck) !== ".puck" || basename(sessionsDir) !== "sessions") return undefined;
		return dirname(dotPuck);
	} catch {
		return undefined;
	}
}

/** Result of resuming an external session (used by resumePicker). */
type ResumedSession = { id: string; model?: string };

/**
 * Render the unified /resume picker.
 *
 * - Default scope: **current cwd only**. Sessions started in a different
 *   project are hidden, matching pi's default behavior so unrelated history
 *   doesn't drown out the conversation you actually want to resume.
 * - Toggle `a`: switch to "all cwds" — full cross-project browse, with each
 *   session's cwd shown in the detail row. Puck sessions from OTHER projects
 *   are discovered through the global index (~/.puck/index.db), so a folder
 *   with no local .puck/sessions still shows puck's own other-folder history
 *   alongside pi/codex/claude — not externals only.
 * - Toggle `r`: re-scan external harness stores (catches new pi/codex/claude
 *   sessions created since the last /resume).
 *
 * The picker is pipe-fallback friendly: when stdout isn't a TTY the scope
 * toggle isn't available (no keystroke input), but the pipe-mode numbered
 * list still works.
 */
async function resumePicker(
	rl: ReturnType<typeof createInterface>,
	context: {
		puck: ReturnType<typeof createPuck>;
		credentials: FileCredentialStore;
		mock: boolean;
		thinking: { get(): "off" | "low" | "medium" | "high" | undefined; set(e: "off" | "low" | "medium" | "high"): void };
		onContextTokens?: (tokens: number) => void;
		onClear?: () => void;
		onModelChange?: (id: string) => void;
		onResume?: (id: string, model: string | undefined, stats: { turns: number; compactions: number; title: string; sessionPath?: string }) => Promise<void> | void;
		memory?: { home: string; store: ConversationStore | null; sources: ContextSource[]; scheduler: IdleTaskScheduler | undefined };
	},
): Promise<boolean> {
	const cwd = process.cwd();
	const store = new SessionStore(".puck/sessions");
	const imported = new Set(store.list());
	const native = store
		.statsAll()
		.filter((s) => s.id !== context.puck.session?.id && s.turns > 0)
		// legacy back-compat: files written before headers carried `cwd` get it
		// derived from the store location. Skipped for `import-*` ids — those
		// were imported from an external harness and may belong to another
		// project (their scope must stay unknown, not assumed to be this cwd).
		.map((s) => (s.cwd || s.id.startsWith("import-") ? s : { ...s, cwd: store.projectCwd }));
	const external = scanExternalSessions().filter((i) => i.turns > 0);

	type Entry = {
		source: "puck" | ImportSource;
		id: string;
		title: string;
		turns: number;
		assistantMessages: number;
		toolCalls: number;
		compactions: number;
		/** True when /clear was invoked on this session; picker tints it yellow. */
		cleared?: boolean;
		clearedAt?: number;
		model?: string;
		updatedAt: number;
		/** Resolved working directory for display + scope match (pi/codex: raw
		 * cwd, claude: cwd slug, puck: header `cwd`, undefined: unknown). */
		cwd?: string;
		/** Absolute session-file path for puck sessions living in ANOTHER
		 * project's store — resuming must load/append the original file, not
		 * create a fresh one in the local .puck/sessions. */
		sessionPath?: string;
		externalInfo?: ExternalSessionInfo;
	};

	const seen = new Set<string>();
	const entries: Entry[] = [];
	for (const s of native) {
		if (seen.has(s.id)) continue;
		seen.add(s.id);
		entries.push({ source: "puck", id: s.id, title: s.title, turns: s.turns, assistantMessages: s.assistantMessages, toolCalls: s.toolCalls, compactions: s.compactions, cleared: s.cleared, clearedAt: s.clearedAt, model: s.model, updatedAt: s.updatedAt, cwd: s.cwd });
	}
	// Cross-project puck sessions: the local store only covers the current
	// folder, so without this scan a project with no puck sessions would show
	// ONLY pi/codex/claude history — puck's own other-folder sessions stayed
	// invisible. The global index (~/.puck/index.db) knows every session's
	// project; rows are verified against the filesystem before use.
	for (const hit of scanForeignSessions(await indexSessionRows(context), cwd)) {
		const s = hit.stats;
		if (seen.has(s.id) || s.id === context.puck.session?.id || s.turns <= 0) continue;
		seen.add(s.id);
		entries.push({
			source: "puck",
			id: s.id,
			title: s.title,
			turns: s.turns,
			assistantMessages: s.assistantMessages,
			toolCalls: s.toolCalls,
			compactions: s.compactions,
			cleared: s.cleared,
			clearedAt: s.clearedAt,
			model: s.model,
			updatedAt: s.updatedAt,
			// header cwd when the file carries one; otherwise derive from the
			// canonical `<project>/.puck/sessions/<id>.jsonl` layout
			cwd: s.cwd ?? dirname(dirname(dirname(hit.path))),
			sessionPath: hit.path,
		});
	}
	for (const e of external) {
		const id = externalSessionId(e);
		if (imported.has(id) || seen.has(id)) continue;
		seen.add(id);
		entries.push({ source: e.source, id, title: e.title, turns: e.turns, assistantMessages: e.assistantMessages, toolCalls: e.toolCalls, compactions: e.compactions, model: e.model, updatedAt: e.updatedAt, cwd: e.cwd, externalInfo: e });
	}
	entries.sort((a, b) => b.updatedAt - a.updatedAt);

	if (entries.length === 0) {
		console.log("没有其他历史会话（当前会话不列出）。每轮对话自动保存到 .puck/sessions/");
		console.log("也扫描了 ~/.puck/index.db（其它项目的 puck 会话）· ~/.claude · ~/.pi · ~/.codex — 均无可恢复会话。");
		return true;
	}

	// (externalCount is computed after the scope filter below — the title
	// suffix must reflect what's actually shown, not the total externals on
	// disk. Counting from `entries` would mislead when only some cwds match.)

	// Scope filter: only sessions that share the current cwd. A session without
	// cwd info (legacy puck files before this change, or any external source
	// that failed to expose cwd) is treated as out-of-scope in "current cwd"
	// mode — they surface only in the "all" view. This is conservative: better
	// to hide a session than risk the user accidentally resuming an old one
	// from a stale project directory.
	const inCurrentCwd = (e: Entry): boolean => {
		if (!e.cwd) return false;
		if (e.externalInfo) return cwdMatches(cwd, e.externalInfo);
		// puck-native: header cwd is the verbatim cwd (normalized to native
		// separators on read). Compare via the same normalize-on-both-sides rule.
		return e.cwd === cwd || e.cwd.replace(/[\\/]/g, "/").replace(/\/+$/, "").toLowerCase() === cwd.replace(/[\\/]/g, "/").replace(/\/+$/, "").toLowerCase();
	};

	const scoped = entries.filter(inCurrentCwd);
	const showAll = scoped.length === 0; // no cwd match → fall back to all
	const list = showAll ? entries : scoped;
	if (showAll && scoped.length === 0 && entries.some((e) => e.cwd)) {
		console.log(COLORS.dim + `(当前目录 ${shortCwd(cwd)} 下没有历史会话，显示全部目录（puck + pi/claude/codex）)` + COLORS.reset);
	} else if (showAll) {
		console.log(COLORS.dim + `(当前目录 ${shortCwd(cwd)} 下没有可识别的历史，显示全部目录（puck + pi/claude/codex）)` + COLORS.reset);
	} else if (!showAll && list.some((e) => e.source !== "puck")) {
		// cwd-scoped view that contains external sessions — one-line reminder
		// that the scan covers ~/.claude / ~/.pi / ~/.codex, so the user knows
		// the colored `[pi]` / `[claude]` / `[codex]` entries are not some
		// misclassified puck session.
		console.log(COLORS.dim + `(已合并 ~/.claude · ~/.pi · ~/.codex 中与当前项目匹配的会话)` + COLORS.reset);
	}

	const items = list.map((e) => {
		const prefix = sourcePrefix(e.source);
		// Yellow "已清空" badge for sessions the user /clear'd. They keep their
		// original timestamp ordering so the user can still find them, but the
		// visual cue makes it obvious the live conversation has moved on. The
		// badge goes in BOTH the label and the detail row: the label tag is
		// visible at a glance (TTY cursor width + pipe fallback), the detail
		// tag survives colorblindness and matches /status's "compact ×N" style.
		const clearedBadge = e.cleared ? "\x1b[33m[已清空]\x1b[0m " : "";
		const clearedDetail = e.cleared ? "\x1b[33m · 已清空\x1b[0m" : "";
		// Source tag is rendered in BOTH the label (colored `[pi]` etc.) AND
		// the detail row (plain " · 来源 pi"), so users with colorblindness or
		// a piped stdout can still tell harnesses apart.
		const srcDetail = sourceDetail(e.source);
		// cwd segment is informative only in "all" view; in cwd-scoped mode
		// every item shares the same cwd (by definition), so the tag is
		// redundant noise that eats horizontal space.
		const cwdTag = showAll && e.cwd ? ` · ${shortCwd(e.cwd)}` : "";
		const detail = `${e.turns} 轮 · ${e.assistantMessages} 条回复${e.toolCalls > 0 ? ` · ${e.toolCalls} 次工具` : ""}${e.compactions > 0 ? ` · compact ×${e.compactions}` : ""}${e.model ? " · " + e.model : ""}${cwdTag} · ${relativeTime(e.updatedAt)}${srcDetail}${clearedDetail}`;
		return { label: clearedBadge + prefix + e.title, detail };
	});
	// Picker title: in cwd-scoped mode, the count of externals matched in
	// this project gets surfaced in the hint so the user doesn't assume the
	// default view is puck-only. In `a` (all) mode, every external is shown
	// anyway, so we just label the source span. Count is taken from `list`
	// so it always matches what's visible in the picker.
	const externalCount = list.filter((e) => e.source !== "puck").length;
	const baseTitle = showAll ? "历史会话 — 全部目录" : `历史会话 — ${shortCwd(cwd)}`;
	const title = showAll || externalCount === 0 ? baseTitle : `${baseTitle}（含 ${externalCount} 条外部会话）`;
	const idx = await selectFromList(rl, title, items, {
		askLine,
		hint: showAll
			? "↑/↓ 选择 · Enter 恢复 · c 仅当前目录 · r 重新扫描 · q 取消"
			: "↑/↓ 选择 · Enter 恢复 · a 全部目录 · r 重新扫描 · q 取消",
		extraKeys: showAll ? { c: -3 } : { a: -2 },
	});
	if (idx === -2 || idx === -3) {
		// a / c → toggle the scope and re-enter the picker
		if (showAll) {
			console.log("切换为：仅当前目录");
			return resumeScopePicker(rl, context, cwd, entries, true);
		}
		console.log("切换为：全部目录");
		return resumeScopePicker(rl, context, cwd, entries, false);
	}
	if (idx < 0) {
		console.log("已取消");
		return true;
	}
	const chosen = list[idx];
	if (chosen.source !== "puck") {
		const info = chosen.externalInfo!;
		const id = chosen.id;
		try {
			const store2 = new SessionStore(".puck/sessions");
			const existing = store2.list().includes(id);
			const session = existing ? store2.load(id) : importExternalSession(info.path, ".puck/sessions", { id, model: info.model });
			console.log(existing ? "(该会话此前已导入，直接复用)" : "导入完成");
			await context.onResume?.(session.id, session.model ?? chosenModelOf(info), { turns: info.turns, compactions: info.compactions, title: info.title });
		} catch (error) {
			console.log("\x1b[31m导入失败: " + (error instanceof Error ? error.message : String(error)) + "\x1b[0m");
			console.log("（源文件可能已被删除或格式变更）");
		}
		return true;
	}
	await context.onResume?.(chosen.id, chosen.model, chosen);
	return true;
}

/**
 * Re-render the picker with the chosen scope. Kept as a thin wrapper so the
 * `a` / `c` toggle can recurse into the same loop without duplicating the
 * selection + import logic in resumePicker.
 */
async function resumeScopePicker(
	rl: ReturnType<typeof createInterface>,
	context: Parameters<typeof resumePicker>[1],
	cwd: string,
	entries: Parameters<typeof resumePicker>[0] extends never ? never : Array<{
		source: "puck" | ImportSource;
		id: string;
		title: string;
		turns: number;
		assistantMessages: number;
		toolCalls: number;
		compactions: number;
		cleared?: boolean;
		clearedAt?: number;
		model?: string;
		updatedAt: number;
		cwd?: string;
		sessionPath?: string;
		externalInfo?: ExternalSessionInfo;
	}>,
	currentOnly: boolean,
): Promise<boolean> {
	const scoped = entries.filter((e) => {
		if (currentOnly) {
			if (!e.cwd) return false;
			if (e.externalInfo) return cwdMatches(cwd, e.externalInfo);
			return e.cwd.replace(/[\\/]/g, "/").replace(/\/+$/, "").toLowerCase() === cwd.replace(/[\\/]/g, "/").replace(/\/+$/, "").toLowerCase();
		}
		return true;
	});
	const list = currentOnly && scoped.length === 0 ? entries : scoped;
	if (currentOnly && scoped.length === 0) {
		console.log(COLORS.dim + `(当前目录 ${shortCwd(cwd)} 下没有历史会话，显示全部)` + COLORS.reset);
	}
	const items = list.map((e) => {
		const prefix = sourcePrefix(e.source);
		const clearedBadge = e.cleared ? "\x1b[33m[已清空]\x1b[0m " : "";
		const clearedDetail = e.cleared ? "\x1b[33m · 已清空\x1b[0m" : "";
		const srcDetail = sourceDetail(e.source);
		const cwdTag = !currentOnly && e.cwd ? ` · ${shortCwd(e.cwd)}` : "";
		const detail = `${e.turns} 轮 · ${e.assistantMessages} 条回复${e.toolCalls > 0 ? ` · ${e.toolCalls} 次工具` : ""}${e.compactions > 0 ? ` · compact ×${e.compactions}` : ""}${e.model ? " · " + e.model : ""}${cwdTag} · ${relativeTime(e.updatedAt)}${srcDetail}${clearedDetail}`;
		return { label: clearedBadge + prefix + e.title, detail };
	});
	const externalCount = list.filter((e) => e.source !== "puck").length;
	const baseTitle = currentOnly ? `历史会话 — ${shortCwd(cwd)}` : "历史会话 — 全部目录";
	const title = currentOnly && externalCount > 0 ? `${baseTitle}（含 ${externalCount} 条外部会话）` : baseTitle;
	const idx = await selectFromList(rl, title, items, {
		askLine,
		hint: currentOnly
			? "↑/↓ 选择 · Enter 恢复 · a 全部目录 · r 重新扫描 · q 取消"
			: "↑/↓ 选择 · Enter 恢复 · c 仅当前目录 · r 重新扫描 · q 取消",
		extraKeys: currentOnly ? { a: -2 } : { c: -3 },
	});
	if (idx === -2 || idx === -3) {
		console.log(currentOnly ? "切换为：全部目录" : "切换为：仅当前目录");
		return resumeScopePicker(rl, context, cwd, entries, !currentOnly);
	}
	if (idx < 0) {
		console.log("已取消");
		return true;
	}
	const chosen = list[idx];
	if (chosen.source !== "puck") {
		const info = chosen.externalInfo!;
		const id = chosen.id;
		try {
			const store2 = new SessionStore(".puck/sessions");
			const existing = store2.list().includes(id);
			const session = existing ? store2.load(id) : importExternalSession(info.path, ".puck/sessions", { id, model: info.model });
			console.log(existing ? "(该会话此前已导入，直接复用)" : "导入完成");
			await context.onResume?.(session.id, session.model ?? chosenModelOf(info), { turns: info.turns, compactions: info.compactions, title: info.title });
		} catch (error) {
			console.log("\x1b[31m导入失败: " + (error instanceof Error ? error.message : String(error)) + "\x1b[0m");
			console.log("（源文件可能已被删除或格式变更）");
		}
		return true;
	}
	await context.onResume?.(chosen.id, chosen.model, chosen);
	return true;
}

/**
 * Render the `[source]` prefix for every row. Color is per-harness so
 * puck / pi / claude / codex are visually distinct at a glance; non-TTY
 * output falls back to plain text. The tag appears in BOTH `c` (cwd-scoped)
 * and `a` (all) views — the user needs to know which harness wrote each
 * session regardless of view.
 */
function sourcePrefix(source: "puck" | ImportSource): string {
	return SOURCE_COLORS[source] + "[" + source + "]" + COLORS.reset + " ";
}

/** Same idea, for the detail row — adds ` · 来源 X` so colorblind users (and
 * the pipe fallback that strips ANSI) can still tell harnesses apart. Color
 * stays the same as the label prefix so the two tags feel like one marker. */
function sourceDetail(source: "puck" | ImportSource): string {
	return " · 来源 " + SOURCE_COLORS[source] + source + COLORS.reset;
}

/** Pretty-shorten a cwd for the picker detail row (last 2 segments).
 * Accepts both real paths and harness slugs (pi's `--C--foo--bar--` form,
 * claude's `C--foo--bar` form). For slugs we reconstruct a readable shape —
 * decoding is ambiguous (a `-` is both a separator and a legal char in
 * directory names), so for display we just replace `-` with `\` and trust the
 * user to recognize their projects. Filtering never uses this (see
 * cwdMatches / piCwdSlug). */
function shortCwd(p: string): string {
	const isPiSlug = p.startsWith("--") && p.endsWith("--") && p.length > 4;
	const isClaudeSlug = !isPiSlug && /^[A-Za-z]--/.test(p) && !p.includes("\\") && !p.includes("/");
	let display = p;
	if (isPiSlug) {
		// strip the `--` delimiters added by pi's encodeCwd, then every `-` was
		// originally a `/`, `\`, or `:` — restoring them is approximate for
		// dirs that contain `-`, but readable enough for a hint in the list.
		const inner = p.slice(2, -2);
		// Turn the drive-letter `C` back into `C:`; the rest are segments.
		if (/^[A-Za-z]/.test(inner)) display = inner[0] + ":" + inner.slice(1).replace(/-/g, "\\");
		else display = inner.replace(/-/g, "\\");
	} else if (isClaudeSlug) {
		// claude slug has no `--` delimiters, every `-` was originally a separator
		const letter = p[0];
		display = letter + ":" + p.slice(1).replace(/-/g, "\\");
	}
	const norm = display.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
	const parts = norm.split("/");
	if (parts.length <= 3) return norm;
	return ".../" + parts.slice(-2).join("/");
}

async function handleSlashCommand(
	command: string,
	rl: ReturnType<typeof createInterface>,
	context: {
		puck: ReturnType<typeof createPuck>;
		credentials: FileCredentialStore;
		mock: boolean;
		thinking: { get(): "off" | "low" | "medium" | "high" | undefined; set(e: "off" | "low" | "medium" | "high"): void };
		onContextTokens?: (tokens: number) => void;
		onClear?: () => void;
		onModelChange?: (id: string) => void;
		onResume?: (id: string, model: string | undefined, stats: { turns: number; compactions: number; title: string; sessionPath?: string }) => Promise<void> | void;
		memory?: { home: string; store: ConversationStore | null; sources: ContextSource[]; scheduler: IdleTaskScheduler | undefined };
		skillIndex?: SkillIndex;
		args?: { noSkills: boolean };
		/** Open the rewind picker (double-ESC / /rewind share one entry). */
		onRewind?: () => Promise<void> | void;
	},
): Promise<boolean> {
	const [name, ...rest] = command.slice(1).split(/\s+/);
	const arg = rest.join(" ");
	const { puck, credentials, mock } = context;

	switch (name) {
		case "login": {
			if (mock) {
				console.log("(mock mode: no key needed)");
				return true;
			}
			const target = arg || (await pickProvider(rl, "接入 API — 选择 provider:"));
			if (!target) return true;
			const ok = await runLoginFlow(rl, target, credentials);
			if (ok) await chooseDefaultModel(rl, ok, credentials);
			return true;
		}
		case "logout": {
			const providerId = arg;
			if (!providerId) {
				console.log("usage: /logout <provider>");
				return true;
			}
			console.log(logoutProvider(providerId, credentials) ? `Removed ${providerId} key` : `No stored key for ${providerId}`);
			return true;
		}
		case "models": {
			printModels(credentials, puck.modelId);
			return true;
		}
		case "model": {
			if (mock) {
				console.log("(mock mode: model switching disabled)");
				return true;
			}
			if (!arg) {
				printModels(credentials, puck.modelId);
				console.log("usage: /model <id>   (switch this session and the default)");
				return true;
			}
			try {
				resolveModel(arg); // validate
			} catch (error) {
				console.log("\x1b[31m" + (error instanceof Error ? error.message : String(error)) + "\x1b[0m");
				return true;
			}
			puck.setModel(arg);
			setDefaultModel(arg);
			context.onModelChange?.(arg);
			console.log(`\x1b[36mSwitched to ${arg} (also saved as default)\x1b[0m`);
			return true;
		}
		case "resume": {
			// Unified picker: puck-native (.puck/sessions) + external harness history
			// (pi / codex / claude) merged into one list, sorted by recency. Default
			// view is **current cwd only** — mirrors pi's default behavior, hides
			// unrelated project history. `a` toggles "all cwds" for cross-project
			// browsing. `r` rescans external stores.
			return resumePicker(rl, context);
		}
		case "think": {
			const level = arg.toLowerCase();
			const levels = ["off", "low", "medium", "high"] as const;
			if (!level || !levels.includes(level as (typeof levels)[number])) {
				console.log(`当前 thinking 等级: ${context.thinking.get() ?? "(模型默认)"}`);
				console.log("用法: /think off|low|medium|high（下一轮生效；off 仅对支持开关的 API 生效，如 GLM）");
				return true;
			}
			context.thinking.set(level as (typeof levels)[number]);
			console.log(`\x1b[36mthinking 等级已设为 ${level}（下一轮生效）\x1b[0m`);
			return true;
		}
		case "compact": {
			if (puck.agent.isStreaming) {
				console.log("本轮还在运行，等结束后再压缩");
				return true;
			}
			const messages = puck.agent.messages;
			const before = estimateMessageTokens(messages);
			if (messages.length < 8 || before < 3000) {
				console.log(`上下文还很小（${messages.length} 条消息 / ~${before} tok），无需压缩`);
				return true;
			}
			console.log("压缩中（摘要旧对话）…");
			try {
				const result = await compactNow(messages, puck.agent.streamFn);
				if (!result) {
					console.log("没有可折叠的历史（保留窗口已覆盖全部消息）");
					return true;
			}
				puck.agent.replaceMessages(result.view);
				puck.session?.recordCompaction(result.folded);
				const after = estimateMessageTokens(result.view);
				context.onContextTokens?.(after);
				console.log(`\x1b[36m已压缩\x1b[0m 折叠 ${result.folded} 条 → 保留 ${result.keptRecent + 1} 条（~${formatTokens(before)} → ~${formatTokens(after)} tok）`);
				console.log(COLORS.dim + "摘要: " + (result.summary.replace(/\s+/g, " ").slice(0, 120) || "(空)") + "…" + COLORS.reset);
			} catch (error) {
				console.log("\x1b[31m压缩失败: " + (error instanceof Error ? error.message : String(error)) + "\x1b[0m");
			}
			return true;
		}
		case "clear": {
			if (puck.agent.isStreaming) {
				console.log("本轮还在运行，等结束后再清空");
				return true;
			}
			context.onClear?.();
			return true;
		}
		case "rewind": {
			// same picker as double-ESC — explicit entry for pipe mode & discoverability
			await context.onRewind?.();
			return true;
		}
		case "memory": {
			const mem = context.memory;
			if (!mem) {
				console.log("记忆系统未启用（--no-memory 或 config.json memory.enabled=false）");
				return true;
			}
			console.log("记忆源：");
			if (mem.sources.length === 0) console.log("  （空）— 可创建 ~/.puck/agent.md（全局指令）或项目 agent.md");
			for (const src of mem.sources) {
				const kind = src.kind === "system" ? "全局指令" : src.kind === "project" ? "项目指令" : src.kind === "longterm" ? "长期记忆" : "经验库";
				console.log(`  ${kind}  ${src.path}（${src.text.split("\n").length} 行）`);
			}
			const stats = memoryStats(mem.home);
			if (stats.longTerm) console.log(`  长期记忆  ${stats.longTerm.split("\n").length} 行 → long-term.md（每周从日总结蒸馏）`);
			console.log(`  每日总结  ${stats.summaries.length} 篇${stats.summaries.length ? "（最新 " + stats.summaries[stats.summaries.length - 1] + "）" : ""} → memories/`);
			console.log("  sqlite 索引  " + (mem.store ? mem.home + "\\index.db" : "不可用（node:sqlite 缺失）"));
			return true;
		}
		case "skills": {
			// Re-scan on every invocation so newly installed skills (in any
			// harness's skills dir) show up without a restart — same philosophy
			// as /memory reload.
			let live: SkillIndex;
			let origins = new Map<string, string[]>();
			let dups = 0;
			try {
				const indexed = await loadHarnessSkillsIndexed(homedir());
				live = indexed.index;
				origins = indexed.origins;
				dups = indexed.duplicates;
			} catch {
				live = context.skillIndex ?? { packs: [], loose: [] };
			}
			if (context.args?.noSkills) {
				console.log("技能未加载（--no-skills）");
				return true;
			}
			const total = live.packs.length + live.loose.length;
			if (total === 0) {
				console.log("未发现任何技能。放一个目录到 ~/.puck/skills/<name>/SKILL.md 即可；或建 ~/.puck/skills/<pack>/PACK.md 做成技能包（也读 ~/.claude · ~/.codex · ~/.pi）");
				return true;
			}
			const childTotal = live.packs.reduce((n, p) => n + p.children.length, 0);
			console.log(`技能（${total} 个${live.packs.length ? `，其中 ${live.packs.length} 个技能包含计 ${childTotal} 个子技能（加载包后按 包名/子技能名 下钻）` : ""}，模型用 skill 工具按需加载）：`);
			for (const p of live.packs) {
				const from = origins.get(p.name) ?? [];
				// "source:name" entries are loose skills absorbed by this pack's
				// children — summarized instead of listed inline (25 of them would
				// drown the line)
				const harnesses = from.filter((f) => !f.includes(":"));
				const absorbed = from.filter((f) => f.includes(":"));
				const parts = [];
				if (harnesses.length > 0) parts.push(harnesses.join("+"));
				if (absorbed.length > 0) parts.push(`吸收 ${absorbed.length} 个同名平铺副本`);
				const tag = parts.join(" · ");
				console.log(`  ${p.name} [包·${p.children.length} 子技能]${tag ? COLORS.dim + "（" + tag + "）" + COLORS.reset : ""}${p.description ? " — " + p.description.slice(0, 100) : ""}`);
			}
			for (const s of live.loose) {
				// origins map carries every harness that offers this skill; skills
				// installed in >1 harness show all of them (dedup kept the first)
				const from = origins.get(s.name) ?? [];
			const tag = from.length > 1 ? from.join("+") + "，已去重" : (from[0] ?? "");
			console.log(`  ${s.name}${tag ? COLORS.dim + "（" + tag + "）" + COLORS.reset : ""}${s.description ? " — " + s.description.slice(0, 100) : ""}`);
			}
			if (dups > 0) {
				console.log(COLORS.dim + `（${dups} 个重复技能已按 .puck > .claude > .codex > .pi 优先级去重）` + COLORS.reset);
			}
			return true;
		}
		case "prompt": {
			// what the model actually reads: base prompt + every auto-loaded file
			const mem = context.memory;
			const base = { label: "内置默认提示", detail: `${DEFAULT_CODING_PROMPT.length} 字`, path: "（内置，packages/sdk DEFAULT_CODING_PROMPT）", text: DEFAULT_CODING_PROMPT };
			const items = [base, ...(mem?.sources ?? []).map((src) => ({
				label: (src.kind === "system" ? "全局指令 " : src.kind === "project" ? "项目指令 " : src.kind === "longterm" ? "长期记忆 " : "经验库 ") + basename(src.path),
				detail: `${src.text.length} 字`,
				path: src.path,
				text: src.text,
			}))];
			const total = DEFAULT_CODING_PROMPT.length + (mem?.sources ?? []).reduce((n, x) => n + x.text.length, 0);
			items.push({ label: "合计（当前系统提示）", detail: `${total} 字`, path: "（无对应文件 — 各段之和）", text: "" });
			const idx = await selectFromList(rl, "系统提示组成（↑↓ 选择，Enter 查看，Esc 取消）", items);
			if (idx >= 0 && idx < items.length) {
				const it = items[idx];
				console.log(`\n${COLORS.ok}── ${it.label} · ${it.path} · ${it.detail} ──${COLORS.reset}`);
				if (!it.text) {
					for (const o of items.slice(0, -1)) console.log(COLORS.dim + `  ${o.label.padEnd(16)} ${o.detail.padStart(7)}  ${o.path}` + COLORS.reset);
				} else {
					const lines = it.text.split("\n");
				for (const l of lines.slice(0, 30)) console.log(l);
					if (lines.length > 30) console.log(COLORS.dim + `…（共 ${lines.length} 行，已截断；完整内容见 ${it.path}）` + COLORS.reset);
				}
			}
			return true;
		}
		case "tasks": {
			const mem = context.memory;
			if (!mem?.scheduler) {
				console.log("后台任务未启用（需要记忆系统开启且 index 可用）");
				return true;
			}
			console.log("后台任务（空闲时自动运行，目录 " + mem.home + "\\tasks\\catalog.json）：");
			for (const t of mem.scheduler.tasks.all()) {
				console.log(`  ${t.id}  [${t.schedule}] lastRun=${t.lastRun ?? "从未"}  ${t.state ?? ""}`);
				if (t.note) console.log(`      ${t.note}`);
			}
			return true;
		}
		case "recall": {
			const mem = context.memory;
			if (!arg) {
				console.log("usage: /recall <关键词>");
				return true;
			}
			if (!mem?.store) {
				console.log("索引不可用（sqlite 未启用）");
				return true;
			}
			const hits = mem.store.search(arg);
			if (hits.length === 0) {
				console.log(`（“${arg}” 无匹配）`);
				return true;
			}
			// step 1: arrow-select a hit — snippet in the label, project dir (tail
			// 2 segments) right-aligned so the directory is visible on every row
			const dirTail = (p: string | null): string => {
				const segs = (p ?? "").split(/[\\/]/).filter(Boolean);
				return segs.length ? segs.slice(-2).join("/") : "?";
			};
			const items = hits.map((h) => ({
				label: `${new Date(h.ts).toISOString().slice(5, 16).replace("T", " ")} ${h.role === "user" ? "你" : "AI"} ${clipCp(h.snippet.replace(/\s+/g, " "), 34)}`,
				detail: dirTail(h.project),
			}));
			const idx = await selectFromList(rl, `搜索“${arg}” — ${hits.length} 条命中（Enter 看上下文，Esc 取消）`, items);
			if (idx < 0) return true;
			// step 2: context view — full project path + messages around the hit
			const h = hits[idx];
			const ctxMsgs = mem.store.contextAround(h.sessionId, h.ts);
			console.log(`\n${COLORS.ok}── 会话「${clipCp(h.title ?? "（无标题）", 40)}」 · ${h.project ?? "?"} ──${COLORS.reset}`);
			for (const m of ctxMsgs) {
				const time = new Date(m.ts).toTimeString().slice(0, 5);
				const isHit = m.ts === h.ts && m.role === h.role;
				const mark = isHit ? COLORS.ok + " ◀" + COLORS.reset : "";
				const who = m.role === "user" ? COLORS.user + "你 ›" : COLORS.path + "puck ›";
				console.log(`${COLORS.dim}${time}${COLORS.reset} ${who}${COLORS.reset} ${clipCp(m.content.replace(/\s+/g, " "), 130)}${mark}`);
			}
			console.log(COLORS.dim + `  会话 ${h.sessionId.slice(0, 8)}… · /resume 可恢复继续对话` + COLORS.reset);
			return true;
		}
				case "status": {
			console.log(`model:    ${puck.modelId ?? "(unknown)"}`);
			console.log(`thinking: ${context.thinking.get() ?? "(模型默认)"}`);
			console.log(`keys:     ${credentials.filePath}`);
			console.log(`session:  ${puck.session?.id ?? "(in-memory)"}${puck.session ? ` (${puck.session.messages.filter((m) => m.role === "user").length} 轮 · compact ×${puck.session.compactionCount})` : ""}`);
			return true;
		}
			case "timings": {
				// quick inline summary; full options via `puck timings`
				const stats = aggregateByModel(new TimingStore().load());
			if (stats.length === 0) console.log("(尚无计时记录)");
			else for (const s of stats) {
					console.log(`${s.model}: ${s.turns}轮 TTFT avg ${formatMs(s.avgTtftMs)} / p95 ${formatMs(s.p95TtftMs)}，时长 p50 ${formatMs(s.p50DurationMs)}，${s.avgTokensPerSecond || "?"} tok/s，错误 ${s.errors}`);
				}
			console.log("完整 dashboard: puck timings --html");
			return true;
			}
		case "help":
			for (const c of SLASH_COMMANDS) console.log("/" + c.name + (c.args ? " " + c.args : "").padEnd(20) + c.desc);
			console.log(COLORS.dim + "输入 @ 触发文件选择器：继续输入按文件名过滤（模糊匹配），↑↓ 选择，Tab/Enter 插入路径，提交时自动附加文件内容" + COLORS.reset);
			console.log(COLORS.dim + "双击 Esc（或 /rewind）：回退到之前任一节点——对话、会话与代码可分别或一起恢复" + COLORS.reset);
			console.log(COLORS.dim + "运行中：Esc 停止当前回答 · 直接打字排队下一轮 · ！开头立即插队 · Ctrl+C 两次退出" + COLORS.reset);
			return true;
		default:
			console.log(`Unknown command /${name}. Try /help`);
			return true;
	}
}

/** Render the interactive provider picker. Returns provider id or "" (cancel). */
/**
 * Line-based interactive helpers.
 *
 * readline chained .question() calls stall on piped (non-TTY) stdin on
 * Windows: the second question never resolves. All interactive flows here
 * funnel through a single line listener per readline instance, which
 * behaves identically for TTY and pipes.
 */
/**
 * Persistent line queue: readline drops buffered lines when no "line" listener
 * is attached, so chained ask() calls lose input on piped stdin. This wrapper
 * attaches ONE listener for the readline's lifetime and buffers lines for
 * sequential askers (wizard, /login prompts, REPL — identical behavior on
 * TTY and pipes).
 */
class LineQueue {
	private readonly pending: string[] = [];
	private readonly waiters: Array<(line: string) => void> = [];
	/** Single ownership: the REPL's main line handler routes every line here.
	 * A waiting wizard consumes it as its answer; otherwise it is parked for
	 * replay when the wizard finishes. (No own 'line' subscription — two
	 * listeners would double-consume.) */
	handle(line: string): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter(line);
		else this.pending.push(line);
	}
	/** Park a line WITHOUT waiter consumption (replay remainder re-queue). */
	requeue(line: string): void {
		this.pending.push(line);
	}
	ask(): Promise<string> {
		const buffered = this.pending.shift();
		if (buffered !== undefined) return Promise.resolve(buffered);
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	/** True while an interactive prompt is waiting — lines belong to it. */
	hasWaiter(): boolean {
		return this.waiters.length > 0;
	}

	/** Lines parked while no wizard wanted them — replay target for the REPL. */
	drainPending(): string[] {
		return this.pending.splice(0);
	}
}

function askLine(rl: ReturnType<typeof createInterface>): Promise<string> {
	return lineQueueFor(rl).ask();
}

function lineHasWaiter(rl: ReturnType<typeof createInterface>): boolean {
	return lineQueueFor(rl).hasWaiter();
}

const lineQueues = new WeakMap<ReturnType<typeof createInterface>, LineQueue>();
function lineQueueFor(rl: ReturnType<typeof createInterface>): LineQueue {
	let queue = lineQueues.get(rl);
	if (!queue) {
		queue = new LineQueue();
		lineQueues.set(rl, queue);
	}
	return queue;
}

/**
 * THE single “line” listener per readline — attached at rl creation, before
 * any wizard can prompt. Routing (unique ownership): a waiting wizard
 * consumes the line as its answer; a running wizard parks it for replay;
 * otherwise it is a REPL line. The first-run wizard counts as “wizard”
 * until the REPL starts, so piped input that races it is never lost.
 */
function attachLineRouter(
	rl: ReturnType<typeof createInterface>,
	opts: {
		isWizard: () => boolean;
		onReplLine: (line: string) => void;
		/** Mutable hook holder — assigned later (e.g. the popup's pre-line wipe). */
		before?: { run?: () => void };
	},
): void {
	rl.on("line", (line) => {
		const queue = lineQueueFor(rl);
		if (queue.hasWaiter() || opts.isWizard()) {
			queue.handle(line);
			return;
		}
		opts.before?.run?.(); // popup wipe etc. — BEFORE the line is processed
		opts.onReplLine(line);
	});
}

/** Render the provider picker; returns provider id or "" (cancel). */
/** pi-style provider picker: every provider with its auth state. Returns provider id or "" (cancel). */
async function pickProvider(rl: ReturnType<typeof createInterface>, title: string): Promise<string> {
	const store = new FileCredentialStore();
	const items = listProviders().map((provider) => ({
		label: provider.name.padEnd(22),
		detail: store.read(provider.id) ? "\x1b[32m✓ stored\x1b[0m" : provider.apiKeyEnvs.some((name) => process.env[name]) ? "\x1b[2m~ env\x1b[0m" : "• unconfigured",
	}));
	const idx = await selectFromList(rl, title, items, { askLine });
	if (idx < 0) return "";
	return listProviders()[idx].id;
}

/** After login: fetch the provider's live model list, let the user pick a default. Returns "provider/model" or "". */
/** After login: fetch the provider's live model list, let the user pick a default. Returns "provider/model" or "". */
async function pickModelFromProvider(rl: ReturnType<typeof createInterface>, providerId: string, credentials: FileCredentialStore): Promise<string> {
	const provider = findProvider(providerId);
	if (!provider) return "";
	const key = resolveProviderApiKey(provider, credentials);
	if (!key) return "";
	process.stdout.write("正在获取 " + provider.name + " 模型列表…\n");
	let models: string[] = [];
	try {
		models = await listModels(provider, key);
	} catch (error) {
		console.log("\x1b[33m模型列表获取失败（" + (error instanceof Error ? error.message : String(error)) + "），稍后可用 /model <id> 手动指定\x1b[0m");
		return "";
	}
	if (models.length === 0) {
		console.log("该 provider 未返回模型列表；可用 /model <id> 手动指定");
		return "";
	}
	const idx = await selectFromList(rl, provider.name + " 可用模型", models.map((id) => ({ label: id })), {
		askLine,
		hint: "↑/↓ 选择默认模型 · Enter 确认 · q 跳过",
	});
	if (idx < 0) return "";
	return provider.id + "/" + models[idx];
}

/** Hidden secret input over the line channel (TTY mutes echo; pipes just read). */
async function askSecret(rl: ReturnType<typeof createInterface>, message: string): Promise<string> {
	return promptSecret(rl, message);
}

/** Interactive login flow. Returns the logged-in provider id, or "" on cancel. */
async function runLoginFlow(
	rl: ReturnType<typeof createInterface>,
	providerId: string | undefined,
	credentials: FileCredentialStore,
): Promise<string> {
	const target = providerId ?? (await pickProvider(rl, "接入 API — 选择 provider:"));
	if (!target) {
		console.log("已取消");
		return "";
	}
	try {
		await loginProvider(target, credentials, {
			promptSecret: (message) => askSecret(rl, message),
			info: (message) => console.log("\x1b[2m" + message + "\x1b[0m"),
		});
		return target;
	} catch (error) {
		console.log("\x1b[31m" + (error instanceof Error ? error.message : String(error)) + "\x1b[0m");
		return "";
	}
}

/** After login: offer the provider's live model list, save default as "provider/model". */
async function chooseDefaultModel(rl: ReturnType<typeof createInterface>, providerId: string, credentials: FileCredentialStore): Promise<string> {
	const choice = await pickModelFromProvider(rl, providerId, credentials);
	if (!choice) return "";
	setDefaultModel(choice);
	console.log("\x1b[36m默认模型已设为 " + choice + "\x1b[0m");
	return choice;
}

/** `puck login [provider]` — direct login without entering the REPL. */
async function runDirectLogin(providerArg?: string): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	// no REPL here — every line belongs to the wizard queue
	attachLineRouter(rl, { isWizard: () => true, onReplLine: () => undefined });
	const credentials = new FileCredentialStore();
	const target = providerArg ?? (await pickProvider(rl, "接入 API — 选择 provider:"));
	if (!target) {
		console.log("未选择 provider。用法: puck login <provider>");
		rl.close();
		return;
	}
	const ok = await runLoginFlow(rl, target, credentials);
	if (ok) await chooseDefaultModel(rl, ok, credentials);
	rl.close();
}

/** First-run wizard: no usable model → login → pick live model. Returns "provider/model" or "". */
async function runFirstLoginWizard(rl: ReturnType<typeof createInterface>, credentials: FileCredentialStore): Promise<string> {
	console.log("\x1b[33m还没有可用的 API key。先接入一家 provider（只需一次，之后随时 /login 添加）：\x1b[0m\n");
	const provider = await runLoginFlow(rl, undefined, credentials);
	if (!provider) return "";
	return chooseDefaultModel(rl, provider, credentials);
}

/** Read a file for @-mention attachment: existing text files under cwd, ≤256KB. */
const readMentionFile = (rel: string): ReadFileResult | undefined => {
	try {
		const full = resolve(process.cwd(), rel);
		const st = statSync(full);
		if (!st.isFile() || st.size > 262_144) return undefined;
		return { content: readFileSync(full, "utf8"), bytes: st.size };
	} catch {
		return undefined;
	}
};

async function main(): Promise<void> {
	// --- crash safety net — installed before anything can throw ----------------
	// Every observable failure lands in .puck/error.log (see errorlog.ts):
	// stray exceptions, pre-REPL rejections, API/tool errors (via onError).
	let replStarted = false; // also guards the processLine TDZ until the REPL opens (set near the end)
	process.on("uncaughtException", (error) => {
		logError("uncaught", error);
		try {
			process.stdout.write("\r\x1b[K\x1b[?25h\n"); // clear spinner residue, show cursor
		} catch {
			/* stdout already gone */
		}
		process.stderr.write(`puck 崩溃：${error instanceof Error ? error.message : String(error)}\n（详情已记录到 ${errorLogPath()}）\n`);
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => {
		logError("unhandledRejection", reason);
		if (replStarted) return; // interactive session survives a stray rejection
		// pre-REPL failure: exiting beats hanging on an open TTY stdin
		process.stderr.write(`puck: ${reason instanceof Error ? reason.message : String(reason)}\n（详情已记录到 ${errorLogPath()}）\n`);
		process.exit(1);
	});
	// CPR BEFORE the readline exists (it owns stdin afterwards). Tells the
	// chrome whether the shell left the cursor below the future scroll region.
	const startCursorRow = await queryCursorPosition().then((r) => r?.row);
	const command = process.argv[2];
	if (command === "timings") {
		await runTimingsCommand(process.argv.slice(3));
		return;
	}
	if (command === "login") {
		// `puck login [provider]` — first-run-friendly entry, same flow as /login
		await runDirectLogin(process.argv[3]);
		return;
	}

	const args = parseArgs(process.argv);
	const credentials = new FileCredentialStore();

	// --- model resolution: never hardcode a provider. -----------------------
	// Priority: --model > PUCK_MODEL > saved default > any usable key > wizard.
	// The wizard runs BEFORE the agent is created so a first-run user is
	// never greeted with a "No API key" error.
	let modelId = args.model;
	if (!args.mock && !modelId) {
		// any provider with a usable key? prefer the one matching the saved default
		const saved = getDefaultModel();
		if (saved) {
			try {
				if (resolveApiKey(resolveModel(saved), credentials)) modelId = saved;
			} catch {
				/* saved default unknown — fall through to discovery */
			}
		}
		if (!modelId) {
			const usable = PROVIDERS.find((provider) => resolveProviderApiKey(provider, credentials));
			// only when a known-good first model exists; otherwise let the wizard run
			if (usable && FALLBACK_MODEL_BY_PROVIDER[usable.id]) modelId = usable.id + "/" + FALLBACK_MODEL_BY_PROVIDER[usable.id];
		}
	}

	// One readline for the whole interactive lifetime. Creating a second
	// readline after closing the first suspends stdin on Windows (subsequent
	// rl.question never resolves), so the wizard and the REPL must share it.
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	// true while an interactive flow (first-run wizard, /login, model picker…)
	// is prompting: its lines are consumed via LineQueue and must NOT be
	// re-processed by the REPL. Starts TRUE — the first-run wizard (if any)
	// owns input until the REPL starts.
	let wizardActive = true;
	// THE line router — attached before any wizard can prompt, so piped input
	// that races the wizard is parked, never lost. onReplLine only ever runs
	// after processLine is defined (wizardActive stays true until REPL start).
	const replLines: string[] = [];
	let wizardRan = false; // first-run wizard ran → REPL repositions its cursor
	const beforeLine: { run?: () => void } = {}; // popup wipe hooks in later
	attachLineRouter(rl, {
		isWizard: () => wizardActive,
		before: beforeLine,
		onReplLine: (line) => {
			if (replStarted) processLine(line);
			else replLines.push(line); // pre-REPL stragglers — replayed at startup
		},
	});
	if (!args.mock && !modelId) {
		if (args.prompt) {
			console.log("\x1b[33m没有可用的 API key。先运行: puck login\x1b[0m");
			rl.close();
			process.exitCode = 1;
			return;
		}
		modelId = await runFirstLoginWizard(rl, credentials);
		if (!modelId) {
			console.log("未接入任何 provider。可用 /login 随时重试，或 puck --mock 离线体验。");
			rl.close();
			return;
		}
		wizardRan = true; // the wizard filled the screen — the REPL repositions below
	} else if (!args.mock && modelId) {
		try {
			const model = resolveModel(modelId);
			if (!resolveApiKey(model, credentials)) {
				console.log(`\x1b[33m${model.provider} 未配置 key — 运行 /login ${model.provider} 接入（或 puck login）\x1b[0m`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Unresolvable at startup — never let createPuck crash later: one-shot
			// exits cleanly; the REPL offers an interactive provider disambiguation.
			if (args.prompt) {
				console.log("\x1b[31m" + message + "\x1b[0m");
				rl.close();
				process.exitCode = 1;
				return;
			}
			console.log(`\x1b[33m${message}\x1b[0m`);
			const usable = PROVIDERS.filter((provider) => resolveProviderApiKey(provider, credentials));
			if (usable.length === 0) {
				modelId = await runFirstLoginWizard(rl, credentials);
				if (!modelId) {
					console.log("未接入任何 provider。可用 /login 随时重试，或 puck --mock 离线体验。");
					rl.close();
					return;
				}
			} else {
				// pick which usable provider serves this model id
				const bare = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
				const idx = await selectFromList(
					rl,
				`"${bare}" 用哪家 provider？`,
					usable.map((provider) => ({ label: provider.name.padEnd(22), detail: `${bare}` })),
					{ askLine, hint: "↑/↓ 选择 · Enter 确认 · q 退出" },
				);
				if (idx < 0) {
					rl.close();
					return;
				}
				modelId = `${usable[idx].id}/${bare}`;
				console.log(`\x1b[36m已选 ${modelId}\x1b[0m`);
			}
		}
	}

	// --- memory layer --------------------------------------------------------
	// agent.md (global + project) & experience.md → agentContext; sqlite index
	// for /recall + daily summaries; idle scheduler for background tasks.
	// Any failure here degrades to "no memory", never blocks the REPL.
	const home = puckDir();
	let memoryConfig: { enabled?: boolean; model?: string } = {};
	try {
		memoryConfig = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { enabled?: boolean; model?: string };
	} catch {
		/* no config — defaults */
	}
	const memoryEnabled = !args.noMemory && !(memoryConfig.enabled === false);
	let conversationStore: ConversationStore | null = null;
	let agentContext = "";
	let memorySources: ContextSource[] = [];
	if (memoryEnabled) {
		const ctx = loadAgentContext(process.cwd(), home);
		agentContext = ctx.text;
		memorySources = ctx.sources;
		try {
			conversationStore = await ConversationStore.open(join(home, "index.db"));
		} catch {
			conversationStore = null;
		}
	}

	// --- skills layer -------------------------------------------------------
	// Every harness on this machine gets a chance: ~/.puck/skills first, then
	// ~/.claude, ~/.codex, ~/.pi — so a skill installed for Claude Code or Codex
	// works in puck with zero copying. Two tiers: a PACK.md directory is a
	// *skill pack* (one prompt line, children addressed as "pack/child"),
	// everything else stays a loose skill. Descriptions live in the system
	// prompt; full instructions load through the `skill` tool on demand.
	// Failures degrade to "no skills"; they never block the REPL.
	let skillIndex: SkillIndex = { packs: [], loose: [] };
	let skillDupCount = 0;
	if (!args.noSkills) {
		try {
			const indexed = await loadHarnessSkillsIndexed(homedir());
			skillIndex = indexed.index;
			skillDupCount = indexed.duplicates;
		} catch {
			skillIndex = { packs: [], loose: [] };
		}
	}
	const skillTool = createIndexedSkillTool(skillIndex);
	const skillPrompt = skillsIndexToPrompt(skillIndex);
	const skillCount = skillIndex.packs.length + skillIndex.loose.length;
	const packedChildren = skillIndex.packs.reduce((n, p) => n + p.children.length, 0);
	if (skillCount > 0) {
		const dupNote = skillDupCount > 0 ? `，含 ${skillDupCount} 个跨 harness 重名去重` : "";
		const packNote = skillIndex.packs.length > 0 ? `（含 ${skillIndex.packs.length} 个技能包，内即 ${packedChildren} 个子技能，加载包后按 包名/子技能名 寻址）` : "";
		console.log(COLORS.dim + `技能: ${skillCount} 个${packNote}${dupNote}（来自 ~/.puck · ~/.claude · ~/.codex · ~/.pi 的 skills 目录，/skills 查看）` + COLORS.reset);
	}
	const fullAgentContext = agentContext + skillPrompt;

	// Mutable runtime: /resume swaps the puck instance (agent + session) while
	// the REPL, renderer, chrome and collectors stay alive.
	const SESSIONS_DIR = ".puck/sessions";
	// agent-touched file trail (bottom row above the status bar)
	const fileTrail = new FileTrail();
	const repaintTrail = (): void => chrome.setTrail(renderTrail(fileTrail.list(), process.stdout.columns || 80));
	const renderer = renderEvents({
		onFileTouched: (path) => {
			fileTrail.record(path);
			repaintTrail();
		},
		onTurnSummary: (summary) => {
			barState.summary = summary.oneLine;
			repaintSummary();
		},
		// every observable error → .puck/error.log (see errorlog.ts)
		onError: (info) => logError(info.kind, info.error, { model: args.mock ? "mock" : (modelId || "mock"), ...info.context }),
	});
	const timingStore = new TimingStore();
	// coding tools + the `skill` loader tool (skill tool is added even with zero
	// skills — it answers "no skills available" instead of the model hallucinating
	// a tool that isn't wired)
	const cliTools = [...createCodingTools(), skillTool];
	// --- rewind checkpoints (double-ESC, Claude Code style) ------------------
	// Every chat prompt opens a checkpoint BEFORE its run: the transcript view
	// + the session-log position + copy-on-first-touch snapshots of every file
	// the run's write/edit tools modify (captured in beforeToolCall, i.e. BEFORE
	// the tool executes). Double-ESC / /rewind picks a node and restores
	// conversation / code / both. Persisted under .puck/checkpoints/<sessionId>/
	// so a resumed session can still rewind.
	const CHECKPOINTS_DIR = ".puck/checkpoints";
	const rewindStore = new RewindStore(CHECKPOINTS_DIR);
	const rewindHook: LoopHooks = {
		beforeToolCall: (info): undefined => {
			if (info.toolCall.name !== "write" && info.toolCall.name !== "edit") return;
			const raw = (info.args as { path?: unknown } | undefined)?.path;
			if (typeof raw !== "string") return;
			// mirror the tools' cwd confinement: only in-project files are rewindable
			const base = resolve(process.cwd());
			const abs = resolve(base, raw);
			if (abs !== base && !abs.startsWith(base + sep)) return;
			rewindStore.captureFile(abs);
			return;
		},
	};
	const runtime = {
		puck: createPuck({
			model: args.mock ? "mock" : (modelId || "mock"),
			streamFn: args.mock ? createMockStreamFn(MOCK_SCRIPT) : undefined,
			tools: cliTools,
			// cwd does double duty: tool paths resolve against it AND the session
			// header records it, which is what /resume's cwd filter keys on
			cwd: process.cwd(),
			session: { dir: SESSIONS_DIR, id: args.sessionId },
			credentials,
			agentContext: fullAgentContext,
			hooks: rewindHook,
		}),
	};
	runtime.puck.subscribe(renderer);
	// checkpoints are per-session: (re)bind on every agent swap so /resume
	// reloads that session's persisted nodes and /clear starts clean
	rewindStore.bind(runtime.puck.session?.id ?? "nosession", runtime.puck.agent.messages);
	/** Load a puck session file by absolute path (cross-project /resume).
	 * Returns undefined when no path is given or the file vanished — the
	 * caller then falls back to the local store. */
	const foreignSession = (sessionPath: string | undefined): Session | undefined => {
		if (!sessionPath) return undefined;
		try {
			return Session.load(sessionPath);
		} catch {
			console.log(COLORS.dim + `会话文件已不存在（${basename(sessionPath)}），改为本地会话` + COLORS.reset);
			return undefined;
		}
	};

	/** Rebuild agent+session (e.g. /resume) and reattach renderer/collector/bar.
	 * `sessionPath` resumes a puck session file from ANOTHER project (found via
	 * the global index): the original file is loaded and appends keep flowing
	 * back to it, so the session stays whole wherever it lives. */
	const rebuildPuck = (sessionId: string, model?: string, sessionPath?: string): void => {
		// Imported sessions may carry models outside puck's provider registry
		// (e.g. zai-coding-cn/glm-5.3) — fall back to the current model, and say so.
		let effective = model;
		if (!args.mock && effective) {
			try {
				resolveModel(effective);
			} catch {
				console.log(COLORS.dim + `导入会话的模型 "${effective}" 不在 puck 注册表中，沿用当前模型（可用 /model 重选）` + COLORS.reset);
				effective = undefined;
			}
		}
		const next = createPuck({
			model: args.mock ? "mock" : (effective ?? modelId ?? "mock"),
			streamFn: args.mock ? createMockStreamFn(MOCK_SCRIPT) : undefined,
			tools: cliTools,
			// a foreign session file is loaded from its own path (falling back to
			// the local store when it disappeared mid-flight); local resumes keep
			// the {dir,id} form so new-session creation semantics stay unchanged
			session: foreignSession(sessionPath) ?? { dir: SESSIONS_DIR, id: sessionId },
			// new session files created by /clear get the same cwd stamp as fresh
			// starts, so they stay findable by /resume's cwd filter
			cwd: process.cwd(),
			credentials,
			agentContext: fullAgentContext,
			hooks: rewindHook,
		});
		next.subscribe(renderer);
		attachCollector(next);
		runtime.puck = next;
		rewindStore.bind(next.session?.id ?? "nosession", next.agent.messages);
		barState.model = args.mock ? "mock" : (next.modelId ?? barState.model);
		try {
			barState.ctxWindow = args.mock ? 128_000 : !barState.model ? 0 : resolveModel(barState.model).contextWindow;
		} catch {
			barState.ctxWindow = 0;
		}
		barState.ctxTokens = estimateMessageTokens(next.agent.messages);
		repaintBar();
		repaintTrail();
		applyThinkingEffort();
	};

	// thinking effort — applies to the live agent's streamOptions (next run).
	// Re-applied after rebuildPuck so /resume keeps the setting.
	let thinkingEffort: "off" | "low" | "medium" | "high" | undefined;
	const applyThinkingEffort = (): void => {
		const agent = runtime.puck.agent;
		agent.streamOptions = { ...agent.streamOptions, thinkingEffort };
	};

	// Timing: every turn is recorded to ~/.puck/timings.jsonl for the dashboard.
	// --- status bar (bottom line, pi-style) ---------------------------------
	const barState = {
		model: args.mock ? "mock" : (runtime.puck.modelId ?? modelId ?? ""),
		/** Final system-prompt chars: base prompt + auto-loaded memory files. */
		sysChars: DEFAULT_CODING_PROMPT.length + (agentContext ? 2 + agentContext.length : 0),
		inTokens: 0,
		outTokens: 0,
		ctxTokens: 0,
		ctxWindow: 0,
		/** One-line summary of the last turn (set at run_end, cleared by /clear). */
		summary: "",
	};
	if (args.mock) {
		barState.ctxWindow = 128_000; // nominal window so --mock demos show ctx% too
	} else if (barState.model) {
		try {
			barState.ctxWindow = resolveModel(barState.model).contextWindow;
		} catch {
			/* unknown model → ctx% hidden */
		}
	}
	const chrome = new TerminalChrome();
	const repaintBar = (): void => chrome.setBar(renderBar(buildBar({ ...barState, cwd: process.cwd(), home: homedir() }), process.stdout.columns || 80));
	const repaintSummary = (): void => chrome.setSummary(barState.summary);

	let detachCollector: (() => void) | undefined;
	let detachRecorder: (() => void) | undefined;
	// mirror every finished message into the sqlite index (user+assistant text)
	const attachRecorder = (p: typeof runtime.puck): void => {
		detachRecorder?.();
		detachRecorder = undefined;
		if (!conversationStore || !p.session) return;
		const store = conversationStore;
		const sid = p.session.id;
		// The index row must keep pointing at the project the FILE lives in, not
		// the cwd it was resumed from — otherwise a cross-project resume would
		// re-stamp the row to the new folder and the session would turn invisible
		// to /resume's foreign scan (its file never moved).
		const project = sessionProjectOf(p.session) ?? process.cwd();
		store.touchSession(sid, { model: p.modelId ?? undefined, project });
		let titled = false;
		detachRecorder = p.subscribe((event) => {
			if (event.type !== "message_end") return;
			const m = event.message;
			if (m.role === "user") {
				const text = typeof m.content === "string" ? m.content : m.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
				if (!titled && text.trim()) {
					store.touchSession(sid, { title: text.split("\n")[0].slice(0, 80), project });
					titled = true;
				}
				store.record({ sessionId: sid, ts: m.timestamp ?? Date.now(), role: "user", content: text });
			} else if (m.role === "assistant") {
				const text = m.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("");
				if (text.trim()) store.record({ sessionId: sid, ts: m.timestamp ?? Date.now(), role: "assistant", content: text, tokens: m.usage?.totalTokens });
			}
		});
	};
	const attachCollector = (p: typeof runtime.puck): void => {
		detachCollector?.();
		attachRecorder(p);
		const collector = new TimingCollector({
			sessionId: p.session?.id,
			modelId: p.modelId,
			onTurn: (record) => {
				timingStore.append(record);
				barState.inTokens += record.inputTokens;
				barState.outTokens += record.outputTokens;
				barState.ctxTokens = record.inputTokens;
				repaintBar();
				repaintTrail();
			},
		});
		detachCollector = collector.attach(p.agent);
	};

	attachCollector(runtime.puck);
	// ctx% must reflect the hydrated transcript immediately (resumed/seeded sessions)
	barState.ctxTokens = estimateMessageTokens(runtime.puck.agent.messages);

	if (args.prompt) {
		// one-shot: @file tokens expand the same way as the REPL (no picker —
		// there is no interactive line to complete on)
		const oneShot = expandFileMentions(args.prompt, readMentionFile);
		if (oneShot.attached.length > 0) {
			console.log(COLORS.dim + `📎 已附加 @引用文件 ${oneShot.attached.length} 个：${oneShot.attached.map((f) => f.path).join("、")}` + COLORS.reset);
		}
		const result = await runtime.puck.run(oneShot.text);
		if (!result.text) {
			const failed = result.messages.find((m) => m.role === "assistant" && m.stopReason === "error");
			if (failed?.role === "assistant") console.error(`error: ${failed.errorMessage}`);
		}
		rl.close(); // one-shot: readline would keep the TTY process alive forever
		return;
	}

	// Terminal chrome FIRST: the region must exist before the banner prints,
	// otherwise a bottom-row cursor puts the banner outside the region forever.
	// After the first-run wizard the screen is full: a cursor at the region
	// boundary desyncs ConPTY's re-encoding of the bar/trail paints (its cursor
	// drifts onto the bar row; the banner/prompt render onto the bar and get
	// painted over). Reposition to a mid-screen row for clean clearance.
	// Fresh terminals skip this — the banner stays near the top.
	if (wizardRan) {
		process.stdout.write(`\x1b[${Math.max(1, (process.stdout.rows || 24) - 6)};1H\x1b[K`);
	}
	chrome.enable(wizardRan ? undefined : startCursorRow); // clamp only when no reposition
	repaintBar();
	repaintTrail();
	repaintBar();
	repaintTrail();
	console.log(`puck · ${args.mock ? "mock" : (runtime.puck.modelId ?? modelId)} · /help for commands · exit to quit`);
	if (memoryEnabled) {
		const bits: string[] = [];
		if (memorySources.some((x) => x.kind === "system")) bits.push("agent.md·全局");
		const nProject = memorySources.filter((x) => x.kind === "project").length;
		if (nProject) bits.push(`agent.md·项目×${nProject}`);
		if (memorySources.some((x) => x.kind === "longterm")) bits.push("long-term");
		if (memorySources.some((x) => x.kind === "experience")) bits.push("experience");
		bits.push(conversationStore ? "index.db" : "index不可用");
		console.log(COLORS.dim + "记忆: " + bits.join(" · ") + "  (/memory 查看 · /tasks 后台任务)" + COLORS.reset);
	} else {
		console.log(COLORS.dim + "记忆系统已停用（--no-memory 或 config.memory.enabled=false）" + COLORS.reset);
	}

	let activeRun: Promise<void> | undefined;
	// Lines queued while a run is streaming (QueuedInput Enter) — drained one
	// at a time as runs settle, preserving order.
	const pendingInputs: string[] = [];
	// Pinned queued-input view: live typing + queue list, painted into the
	// chrome's reserved rows above the summary — it never scrolls with the AI's
	// streaming output, and the AI can never visually cover the user's typing.
	const queueView: QueueViewState = { active: false, typing: "", queued: [], interjected: 0 };
	const repaintQueue = (): void => chrome.setQueue(renderQueueRows(queueView, process.stdout.columns || 80));
	// double-ESC (Claude Code rewind): shared detector for the idle keypress
	// listener and the QueuedInput escape path — a press during a run and the
	// confirming press after it settles land in the same window.
	const escDetector = new DoubleEscDetector(600);
	// set when the second ESC arrives while a run is still streaming: the run
	// was already aborted by the first press; open the picker when it settles
	let rewindAfterRun = false;
	const queuedInput = new QueuedInput({
		onQueue: (line) => {
			queueView.typing = "";
			// "!"/“！” prefix → interject into the RUNNING conversation (steering);
			// default → wait in line for the run to settle, then run in order.
			const { interject, text } = parseInterject(line);
			if (!text) {
				repaintQueue(); // Enter on blanks/prefix-only — just clear the typing row
				return;
			}
			if (interject && runtime.puck.agent.isStreaming) {
				runtime.puck.agent.queue(steeringMessage(text)); // injects before the next LLM call
				queueView.interjected++;
				rememberHistory(text);
			} else {
				pendingInputs.push(text);
			}
			queueView.queued = [...pendingInputs];
			repaintQueue();
		},
		onSigint: () => sigintDuringRun(),
		// ESC-while-streaming is handled at the byte level (watchStandaloneEsc
		// above): immediate abort + double-press rewind detection. The keypress
		// path here stays as a defensive backstop for exotic terminals whose
		// lone-ESC bytes never surface as data chunks (the abort is idempotent).
		onEscape: () => {
			if (!activeRun) return;
			if (runtime.puck.agent.isStreaming) runtime.puck.agent.abort();
		},
		onEcho: (_str, buf) => {
			queueView.typing = buf;
			repaintQueue();
		},
	});
	const drainQueued = (): void => {
		const next = pendingInputs.shift();
		if (next !== undefined) {
			queueView.queued = [...pendingInputs];
			repaintQueue();
			processLine(next, { fromQueue: true }); // starts a new run; its settle() re-enters drainQueued
			return;
		}
		queueView.active = false;
		queueView.typing = "";
		queueView.interjected = 0;
		repaintQueue();
		popup.setEnabled(true);
		mention.setEnabled(true);
		promptWithBar();
		scheduler?.nudge(); // idle point: arm a delayed check for due background tasks
	};
	// --- rewind picker (double-ESC / /rewind, Claude Code style) -------------
	/** Display a restored path relative to cwd when inside it. */
	const shortRel = (p: string): string => {
		const cwdFwd = process.cwd().replace(/\\/g, "/").replace(/\/$/, "");
		const f = p.replace(/\\/g, "/");
		if (f.toLowerCase().startsWith(cwdFwd.toLowerCase() + "/")) return f.slice(cwdFwd.length + 1);
		return f;
	};
	/** Apply one checkpoint: conversation (transcript + session log) and/or code. */
	const applyRewind = (cp: Checkpoint, mode: number): void => {
		const parts: string[] = [];
		if (mode === 0 || mode === 1) {
			const p = runtime.puck;
			p.agent.replaceMessages(cp.messages);
			p.session?.rewind(cp.sessionCount);
			// queued lines belong to the abandoned future — drop them with it
			pendingInputs.length = 0;
			queueView.queued = [];
			repaintQueue();
			barState.ctxTokens = estimateMessageTokens(p.agent.messages);
			repaintBar();
			// last-turn summary + title + file trail mirror the kept transcript
			const msgs = p.agent.messages;
			let lastUser = -1;
			for (let i = 0; i < msgs.length; i++) if (msgs[i].role === "user") lastUser = i;
			if (lastUser >= 0) {
				const s = summarizeTurn(msgs.slice(lastUser));
				barState.summary = s.oneLine;
				renderer.setIdleTitle(s.short ? `puck · ${s.short}` : "puck");
			} else {
				barState.summary = "";
				renderer.setIdleTitle();
			}
			repaintSummary();
			fileTrail.clear();
			for (const m of msgs) {
				if (m.role !== "assistant") continue;
				for (const block of m.content) {
					if (block.type === "toolCall" && (block.name === "write" || block.name === "edit") && typeof block.arguments?.path === "string") fileTrail.record(block.arguments.path);
				}
			}
			repaintTrail();
			parts.push(`对话已回退（保留 ${cp.messages.length} 条消息）`);
		}
		if (mode === 0 || mode === 2) {
			const ops = rewindStore.restoreTo(cp.serial);
			const { restored, deleted, skipped } = applyFileOps(ops);
			const names = [...restored, ...deleted];
			for (const n of names) fileTrail.record(n);
			repaintTrail();
			parts.push(names.length > 0 ? `代码已恢复 ${names.length} 个文件（${names.slice(0, 3).map(shortRel).join("、")}${names.length > 3 ? " 等" : ""}）` : "代码无变化");
			if (skipped.length > 0) parts.push(`${skipped.length} 个文件无法恢复（快照缺失/过大）`);
		}
		console.log(COLORS.ok + "↩ " + parts.join(" · ") + COLORS.reset);
	};
	/**
	 * The rewind picker: node list → restore-mode choice → apply. Shared by
	 * double-ESC (idle), double-ESC (run settles after abort) and /rewind.
	 */
	const openRewindPicker = async (): Promise<void> => {
		if (runtime.puck.agent.isStreaming || activeRun) {
			console.log(COLORS.dim + "本轮还在运行，等结束后再回退" + COLORS.reset);
			return;
		}
		const cps = [...rewindStore.list()].reverse(); // newest first — ↑/↓ starts at the nearest node
		if (cps.length === 0) {
			console.log(COLORS.dim + "没有可回退的节点（每轮对话发出前会自动记录一个，含代码快照）" + COLORS.reset);
			return;
		}
		// readline folds the double-ESC into an escape-code prefix; its ~500ms
		// timeout later emits a GHOST escape keypress that would instantly
		// cancel the picker (Esc = cancel in selectFromList). Let it expire
		// unobserved before the picker starts listening.
		await new Promise((r) => setTimeout(r, 550));
		wizardActive = true;
		popup.setEnabled(false);
		mention.setEnabled(false);
		try {
			const items = cps.map((cp) => ({
				label: `${COLORS.user}你 ›${COLORS.reset} ${clipCp(cp.userText.split("\n")[0] || "(空)", 44)}`,
				detail: `${relativeTime(cp.at)} · 保留 ${cp.agentCount} 条消息${cp.files.length > 0 ? ` · 改动 ${cp.files.length} 个文件` : ""}`,
			}));
			const idx = await selectFromList(rl, "回退到哪个节点？（选中一条消息 = 回到它发出之前）", items, { askLine, hint: "↑/↓ 选择 · Enter 确认 · q 取消" });
			if (idx < 0) return;
			const cp = cps[idx];
			const brief = clipCp(cp.userText.split("\n")[0] || "空", 20);
			const mode = await selectFromList(rl, `恢复什么？（回到「${brief}」之前）`, [
				{ label: "对话 + 代码", detail: "上下文回退，文件一并恢复" },
				{ label: "仅对话", detail: "只回退上下文（文件保持现状）" },
				{ label: "仅代码", detail: "只恢复文件（上下文保持现状）" },
			], { askLine, hint: "↑/↓ 选择 · Enter 确认 · q 取消" });
			if (mode < 0) return;
			applyRewind(cp, mode);
		} finally {
			wizardActive = false;
			popup.setEnabled(true);
			mention.setEnabled(true);
			promptWithBar();
		}
	};
	// --- background tasks (daily summary & friends) --------------------------
	// Run only when the REPL is interactive and idle; never blocks input.
	let scheduler: IdleTaskScheduler | undefined;
	if (memoryEnabled && conversationStore) {
		let memoryStreamFn: import("@puckguo123/core").StreamFn | undefined;
		if (args.mock) memoryStreamFn = createMockStreamFn(MOCK_SCRIPT);
		else if (memoryConfig.model || modelId) {
			try {
				memoryStreamFn = createStreamFn(resolveModel(memoryConfig.model || modelId || ""), credentials);
			} catch {
				/* no usable model — task reports skip */
			}
		}
		scheduler = new IdleTaskScheduler({
			home,
			// tests shrink the window via env; default 20s keeps background LLM
			// calls from surprising a user mid-thought
			idleMs: Number(process.env.PUCK_TASK_IDLE_MS) || 20_000,
			isIdle: () => replStarted && !wizardActive && !activeRun && pendingInputs.length === 0 && !scheduler?.running,
			runTask: async (id) => {
				if (!memoryStreamFn) return "skip: 无可用模型";
				if (id === "daily-summary") return runDailySummary({ home, store: conversationStore, streamFn: memoryStreamFn });
				if (id === "weekly-distill") return runLongTermDistill({ home, streamFn: memoryStreamFn });
				return "skip: 未知任务";
			},
			log: (line) => {
				process.stdout.write("\r\x1b[K" + COLORS.dim + line + COLORS.reset + "\n");
				if (replStarted && !activeRun) promptWithBar();
			},
		});
		scheduler.register("daily-summary", "daily", "空闲时总结当天全部对话 → memories/，并合并 experience.md");
		scheduler.register("weekly-distill", "weekly", "每周将近期日总结蒸馏为长期记忆 long-term.md（用户偏好/项目事实/工作流）");
	}
	rl.setPrompt("\x1b[36myou ›\x1b[0m ");
	// popup hides on line submit; its 'line' listener must be registered BEFORE
	// the main handler below so the popup is cleared before command output prints
	const popup = new SlashPopup(rl, SLASH_COMMANDS, "\x1b[36myou ›\x1b[0m ", repaintBar);
	popup.attach();
	// @-mention file picker (codex-style): typing "@" opens a live file menu —
	// the project tree is indexed asynchronously (progressive, cached) and the
	// query after "@" fuzzy-filters it; ↑/↓ pick, Tab/Enter insert the path.
	// While open it shadows history ↑/↓ and disables the slash popup (the two
	// menus are mutually exclusive: "/" lines never open the mention popup).
	const fileIndex = new FileIndex(process.cwd());
	const mention = new MentionPopup(rl, fileIndex, {
		prompt: "\x1b[36myou ›\x1b[0m ",
		isEnabled: () => replStarted && !wizardActive && !activeRun,
		onActiveChange: (on) => popup.setEnabled(!on),
	});
	mention.attach();
	// ESC semantics live at the raw-byte level (see watchStandaloneEsc): the
	// keypress parser folds a quick double-ESC into a meta prefix and only
	// emits after its ~500ms timeout, so keypress events can't drive this.
	//   idle:  double-ESC → rewind picker (Claude Code)
	//   run:  first ESC aborts immediately (no timeout lag); a second press
	//         inside the window flags rewindAfterRun → picker opens when the
	//         aborted run settles
	watchStandaloneEsc((rl as unknown as { input: NodeJS.ReadableStream }).input, () => {
		if (activeRun) {
			if (escDetector.press()) rewindAfterRun = true;
			if (runtime.puck.agent.isStreaming) {
				runtime.puck.agent.abort();
				process.stdout.write("\n" + COLORS.dim + "⏹ 已停止（Esc）— 输入继续，或 /resume 回看" + COLORS.reset + "\n");
			}
			return;
		}
		if (!replStarted || wizardActive) return;
		if (escDetector.press()) void openRewindPicker();
	});
	beforeLine.run = () => {
		popup.onLineSubmit(); // wipe BEFORE the line is processed
		mention.onLineSubmit();
	};
	// rl.prompt() clears below the prompt row (wipes the bar) — always repaint
	const promptWithBar = (): void => {
		rl.prompt();
		repaintSummary();
		repaintBar();
		repaintTrail(); // readline's prompt/echo clears below the prompt — all pinned rows must be repainted
	};
	promptWithBar();

	// Input history (↑/↓ recall), persisted across sessions like pi/codex.
	const historyFile = join(puckDir(), "history");
	try {
		const saved = JSON.parse(readFileSync(historyFile, "utf8")) as unknown;
		const hist = (rl as unknown as { history?: string[] }).history;
		if (Array.isArray(saved) && hist) for (const h of saved) if (typeof h === "string") hist.push(h);
	} catch {
		/* first run — no history yet */
	}
	let historyFlush: NodeJS.Timeout | undefined;
	let latestHistory: string[] = [];
	const saveHistory = (): void => {
		try {
			mkdirSync(puckDir(), { recursive: true });
			writeFileSync(historyFile, JSON.stringify(latestHistory));
		} catch {
			/* best-effort persistence */
		}
	};
	const rememberHistory = (line: string): void => {
		if (!line || line.startsWith(" ")) return; // skip blanks & secrets-prefixed
		const hist = (rl as unknown as { history: string[] }).history ?? [];
		if (hist[hist.length - 1] === line) return;
		hist.push(line);
		while (hist.length > 500) hist.shift();
		latestHistory = hist;
		clearTimeout(historyFlush);
		historyFlush = setTimeout(saveHistory, 250);
	};

	// Ctrl+C: during an active run the first press only warns (prevent accidental
	// kills — the streaming response would be cut); the second press within 3s
	// exits. While idle, Ctrl+C exits like "exit".
	let lastSigintAt = 0;
	// QueuedInput forwards raw ctrl+c here (readline's SIGINT detection is
	// suspended while the queued-input owns the keyboard).
	const sigintDuringRun = (): void => {
		if (Date.now() - lastSigintAt < 3000) {
			chrome.disable();
			process.exit(0);
		}
		lastSigintAt = Date.now();
		process.stdout.write("\n" + COLORS.dim + "运行中 — 再按一次 Ctrl+C 退出" + COLORS.reset + "\n");
	};
	rl.on("SIGINT", () => {
		if (activeRun) {
			sigintDuringRun();
			// no rl.prompt() here: the run is still going and the spinner owns the
			// next line; the prompt is restored when the run settles
			return;
		}
		void (activeRun ?? Promise.resolve()).then(() => {
			chrome.disable();
			rl.close();
		});
	});

	// Main REPL input loop. Lines arriving while a wizard (login/model/resume
	// picker) is prompting are parked in the shared LineQueue and replayed here
	// when the wizard finishes — dropping them lost pasted/piped input.
	const processLine = (line: string, opts: { fromQueue?: boolean } = {}): void => {
		const input = line.trim();
		if (!input) {
			promptWithBar();
			return;
		}
		if (input === "exit" || input === "quit") {
			// wait for any in-flight run to settle before tearing the process down;
			// otherwise process.exit would cut the streaming response mid-flight
			void (activeRun ?? Promise.resolve()).then(() => {
				chrome.disable();
				rl.close();
			});
			return;
		}
		rememberHistory(input);
		if (input.startsWith("/")) {
			popup.setEnabled(false);
			wizardActive = true;
			void handleSlashCommand(input, rl, {
				puck: runtime.puck,
				credentials,
				mock: args.mock,
				memory: { home, store: conversationStore, sources: memorySources, scheduler },
				skillIndex,
				args,
				onRewind: () => openRewindPicker(),
				thinking: {
					get: () => thinkingEffort,
					set: (e) => {
						thinkingEffort = e;
						applyThinkingEffort();
					},
				},
				onContextTokens: (tokens) => {
					barState.ctxTokens = tokens;
					repaintBar();
				},
				onModelChange: (id) => {
					barState.model = id;
					try {
						barState.ctxWindow = resolveModel(id).contextWindow;
					} catch {
						barState.ctxWindow = 0;
					}
					barState.ctxTokens = 0;
					repaintBar();
				},
				onClear: () => {
					// fresh session file — the live context starts empty while the old
					// transcript stays on disk for /resume. Mark the old one as cleared
					// so the picker can tint it (the user can still resume it).
					const previous = runtime.puck.session;
					previous?.recordCleared();
					rebuildPuck(randomUUID(), args.mock ? "mock" : barState.model);
					barState.summary = "";
					repaintSummary();
					repaintBar();
					renderer.setIdleTitle();
					console.log(COLORS.ok + `上下文已清空，开始新对话（原会话 ${previous ? previous.id.slice(0, 8) + "… " : ""}保留，/resume 可找回）` + COLORS.reset);
				},
				onResume: async (id, model, stats) => {
					rebuildPuck(id, model ?? (args.mock ? "mock" : undefined), stats.sessionPath);
					const compact = stats.compactions > 0 ? ` · 历史压缩 ×${stats.compactions}` : "";
					// replay the hydrated transcript into scrollback — same rendering as
					// live, so the resumed context is visible in the terminal again
					const messages = runtime.puck.session?.messages ?? [];
					process.stdout.write("\n" + COLORS.dim + `── 已恢复会话「${stats.title}」 · ${stats.turns} 轮${compact} · 以下是历史回放 ──` + COLORS.reset + "\n");
					renderHistory(messages);
					// rehydrate chrome from history: file trail + last-turn summary (title & bar)
					for (const m of messages) {
						if (m.role !== "assistant") continue;
						for (const block of m.content) {
							if (block.type === "toolCall" && (block.name === "write" || block.name === "edit") && typeof block.arguments?.path === "string") fileTrail.record(block.arguments.path);
						}
					}
					repaintTrail();
					let lastUser = -1;
					for (let i = 0; i < messages.length; i++) if (messages[i].role === "user") lastUser = i;
					if (lastUser >= 0) {
						const s = summarizeTurn(messages.slice(lastUser));
						barState.summary = s.oneLine;
						repaintSummary();
						renderer.setIdleTitle(s.short ? `puck · ${s.short}` : "puck");
					}
				},
			}).then(() => {
				wizardActive = false;
				popup.setEnabled(true);
				// replay parked lines (paste/pipe that raced the wizard); a replayed
				// line may open a new wizard — re-queue the rest for ITS drain
				const drained = lineQueueFor(rl).drainPending();
				for (let i = 0; i < drained.length; i++) {
					if (wizardActive) {
						for (const l of drained.slice(i)) lineQueueFor(rl).requeue(l);
						break;
					}
					processLine(drained[i]);
				}
				if (!wizardActive) promptWithBar();
			});
			return;
		}
		popup.setEnabled(false);
		mention.setEnabled(false);
		// queued lines bypassed readline's own echo — show which ask this run answers
		if (opts.fromQueue) process.stdout.write(COLORS.user + "you ›" + COLORS.reset + " " + input + "\n");
		// turn divider (session border) — separates runs in scrollback
		process.stdout.write(COLORS.dim + "─".repeat(Math.min(process.stdout.columns || 80, 80)) + COLORS.reset + "\n");
		// @file tokens → file content is appended to the user message (the model
		// sees the file without a read round-trip); raw input keeps echoing above
		const expansion = expandFileMentions(input, readMentionFile);
		if (expansion.attached.length > 0) {
			process.stdout.write(COLORS.dim + `📎 已附加 @引用文件 ${expansion.attached.length} 个：${expansion.attached.map((f) => f.path).join("、")}` + COLORS.reset + "\n");
		}
		const runPrefix = COLORS.user + "puck ›" + COLORS.reset + " ";
		renderer.beginRun(runPrefix); // anchor the inline stats at Enter
		process.stdout.write(runPrefix);
		// Take the keyboard: readline's line-refresh would fight the streaming
		// output. QueuedInput echoes typed text into the pinned queue rows and
		// Enter'ed lines either wait in the queue or interject (! prefix).
		queueView.active = true;
		queueView.typing = ""; // QueuedInput.attach() drops its buffer — mirror it
		queueView.interjected = 0; // per-run counter — the previous run's interjections are done
		repaintQueue();
		// rewind checkpoint opens NOW: transcript view + session-log position as
		// they are just BEFORE this prompt runs (files snapshot lazily on first
		// write/edit via the beforeToolCall hook). Recorded even if the run aborts.
		rewindStore.begin(input, runtime.puck.agent.messages, runtime.puck.session?.messages.length ?? runtime.puck.agent.messages.length);
		queuedInput.attach(rl);
		activeRun = runtime.puck
			.run(expansion.text)
			.catch((error: unknown) => {
				logError("run", error);
				console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
			})
			.then(() => {
				activeRun = undefined;
				queuedInput.detach(rl);
				rewindStore.finish(); // checkpoint complete — files captured so far are restorable
				// double-ESC during the run: first ESC aborted it, the second asked for
			// the picker — open it now, then drain whatever is still queued
				if (rewindAfterRun) {
					rewindAfterRun = false;
					void openRewindPicker().then(() => drainQueued());
					return;
				}
				drainQueued();
			});
	};
	// the router owns line dispatch now — no direct 'line' handler here
	// start the REPL: hand parked pre-REPL lines (pipe that raced the wizard)
	// to the normal path, then open the prompt
	wizardActive = false;
	replStarted = true;
	scheduler?.nudge(); // catch-up: missed daily tasks fire once idle
	// blank parked lines (Enter keystrokes from selectors) would only re-print the
	// prompt — and a duplicate prompt write at the region boundary hits a
	// ConPTY re-encoding glitch that swallows the prompt text. Skip them.
	for (const l of [...replLines, ...lineQueueFor(rl).drainPending()]) {
		if (l.trim()) processLine(l);
	}
	// stdin end (pipe/EOF) or explicit exit: wait for the WHOLE deferred chain
	// (slash-command replay → chat run), not just activeRun — a piped
	// "/cmd\nchat\nexit" races its replay microtasks against stdin EOF.
	// A wizard parked on askLine with stdin exhausted can never resolve: bail.
	const settleAndExit = (): void => {
		const waitingForDeadInput = wizardActive && lineHasWaiter(rl);
		if ((activeRun !== undefined || wizardActive) && !waitingForDeadInput) {
			setTimeout(settleAndExit, 50);
			return;
		}
		clearTimeout(historyFlush);
		saveHistory(); // debounced save may not have fired yet
		chrome.disable();
		process.exit(0);
	};
	rl.on("close", settleAndExit);
}

void main();

/** `puck timings [--html [file]] [--analyze] [--model <id>] [--clear] [--last N]` */
async function runTimingsCommand(argv: string[]): Promise<void> {
	const store = new TimingStore();
	let htmlPath: string | undefined;
	let analyze = false;
	let model: string | undefined;
	let clear = false;
	let last: number | undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--html") htmlPath = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "puck-dashboard.html" : argv[++i];
		else if (arg === "--analyze") analyze = true;
		else if (arg === "--model" || arg === "-m") model = argv[++i];
		else if (arg === "--clear") clear = true;
		else if (arg === "--last") last = Number(argv[++i]);
		else if (arg === "--help" || arg === "-h") {
			console.log("usage: puck timings [--html [file]] [--analyze] [--model <id>] [--last N] [--clear]");
			return;
		}
	}

	if (clear) {
		store.clear();
		console.log(`Cleared ${store.path}`);
		return;
	}

	let records = store.load();
	if (records.length === 0) {
		console.log(`尚无计时记录（${store.path}）。先跑几轮对话再来看。`);
		return;
	}
	if (model) records = records.filter((r) => r.model === model || r.agentModelId === model);
	if (last !== undefined) records = records.slice(-last);

	// terminal summary
	const stats = aggregateByModel(records);
	console.log(`\x1b[1m计时统计\x1b[0m — ${records.length} 轮 · 来源 ${store.path}\n`);
	for (const s of stats) {
		console.log(`\x1b[36m${s.model}\x1b[0m`);
		console.log(`  轮数 ${s.turns}（错误 ${s.errors}，${Math.round(s.errorRate * 100)}%） · tokens 入 ${s.totalInputTokens} / 出 ${s.totalOutputTokens}`);
		console.log(`  TTFT   avg ${formatMs(s.avgTtftMs)} · p50 ${formatMs(s.p50TtftMs)} · p95 ${formatMs(s.p95TtftMs)}`);
		console.log(`  时长   avg ${formatMs(s.avgDurationMs)} · p50 ${formatMs(s.p50DurationMs)} · p95 ${formatMs(s.p95DurationMs)}`);
		console.log(`  速率   ${s.avgTokensPerSecond || "?"} tok/s · 带工具轮 ${s.toolTurns}（工具 avg ${formatMs(s.avgToolMs)}）`);
	}

	for (const anomaly of detectAnomalies(records)) {
		console.log(`\x1b[33m⚠ ${anomaly.kind}\x1b[0m ${anomaly.model}: ${anomaly.detail}`);
	}

	if (htmlPath !== undefined) {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(htmlPath, generateDashboard(records, { title: "puck timing dashboard" }), "utf8");
		console.log(`\nDashboard 已生成: ${htmlPath}（浏览器打开即用，离线自包含）`);
	}

	if (analyze) {
		const { createStreamFn, resolveModel: resolve } = await import("@puckguo123/llm");
		// pick the default model if usable, else any usable provider/model
		const credentials = new FileCredentialStore();
		let modelId = getDefaultModel() ?? "";
		try {
			if (modelId && !resolveApiKey(resolve(modelId), credentials)) modelId = "";
		} catch {
			modelId = "";
		}
		if (!modelId) {
			const usable = await discoverUsableModels(credentials);
			if (usable.length === 0) {
				console.error("分析需要一个可用的模型 key（先 /login）");
				process.exitCode = 1;
				return;
			}
			modelId = usable[0].provider.id + "/" + usable[0].models[0];
			console.log("（默认模型无 key，回退到 " + modelId + "）");
		}
		try {
			const report = await analyzeTimings(records, createStreamFn(resolve(modelId), credentials));
			console.log(report);
		} catch (error) {
			console.error(`分析失败: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
	}
}
