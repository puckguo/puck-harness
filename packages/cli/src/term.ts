/**
 * Terminal chrome for the REPL — pi-inspired, readline-compatible:
 *
 * 1. TerminalChrome: a persistent status bar pinned to the last terminal row.
 *    Implemented with a DECSTBM scroll region covering rows 1..rows-1: all
 *    normal output (console.log, agent streaming, readline echo) scrolls
 *    inside the region, so the bar never moves. Repaint uses absolute cursor
 *    addressing wrapped in DECSC/DECRC save-restore, invisible to readline.
 *
 * 2. SlashPopup: a live slash-command menu rendered while the input line
 *    starts with "/" (filter narrows as you type, first match highlighted).
 *    Rendered bash-tab-complete style: move up to the popup top, clear to end
 *    of screen, write popup rows, rewrite the prompt+buffer row, place the
 *    cursor. Output above is never touched, no insert/delete-line bookkeeping
 *    is needed, and when the prompt sits at the region bottom the terminal
 *    just scrolls — every case degrades to the same code path.
 *
 * Both are no-ops unless stdin/stdout are TTYs (pipe mode stays byte-clean).
 */

import type { Interface } from "node:readline";

// ---------------------------------------------------------------------------
// slash commands
// ---------------------------------------------------------------------------

export interface SlashCommand {
	name: string;
	args?: string;
	desc: string;
}

/** Prefix match on the query (the text after "/"), in definition order. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
	return commands.filter((c) => c.name.startsWith(query));
}

/** Render popup rows for the filtered matches (≤ maxRows; no pagination yet). */
export function buildPopupRows(matches: SlashCommand[], cols: number): string[] {
	const rows: string[] = [];
	const labelLen = Math.max(...matches.map((m) => (m.name + " " + (m.args ?? "")).trimEnd().length));
	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		const label = (m.name + " " + (m.args ?? "")).trimEnd().padEnd(labelLen);
		const marker = i === 0 ? "\x1b[36m→\x1b[0m " : "  ";
		rows.push(marker + label + "  " + clip(m.desc, Math.max(10, cols - labelLen - 6)));
	}
	rows.push("\x1b[2m" + "─".repeat(Math.max(8, Math.min(cols - 2, 64))) + "\x1b[0m");
	return rows;
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + "…";
}

// ---------------------------------------------------------------------------
// status bar
// ---------------------------------------------------------------------------

export interface BarInput {
	cwd: string;
	home: string;
	model: string;
	inTokens: number;
	outTokens: number;
	/** Tokens in the context at the last request (≈ its input tokens). */
	ctxTokens: number;
	ctxWindow: number;
	/** Final system-prompt char count (base + auto-loaded memory files). */
	sysChars?: number;
}

export interface BarData {
	cwd: string;
	stats: string[];
	model: string;
	ctxSeverity: "ok" | "warn" | "hot";
}

/** Pure: plain-text segments + context severity (colors applied in renderBar). */
export function buildBar(input: BarInput): BarData {
	let cwd = input.cwd;
	if (input.home && (cwd === input.home || cwd.startsWith(input.home + "\\") || cwd.startsWith(input.home + "/"))) {
		cwd = "~" + cwd.slice(input.home.length).replace(/\\/g, "/");
	} else {
		cwd = cwd.replace(/\\/g, "/");
	}
	const stats: string[] = [];
	if (input.inTokens > 0 || input.outTokens > 0) {
		stats.push(`↑${formatTokens(input.inTokens)} ↓${formatTokens(input.outTokens)}`);
	}
	if (input.ctxWindow > 0) {
		const pct = (input.ctxTokens / input.ctxWindow) * 100;
		stats.push(`${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%/${formatTokens(input.ctxWindow)}`);
	}
	if (input.sysChars && input.sysChars > 0) {
		stats.push(`sys ${formatTokens(input.sysChars)}`);
	}
	const ctxSeverity = input.ctxWindow > 0 && input.ctxTokens / input.ctxWindow > 0.9 ? "hot" : input.ctxWindow > 0 && input.ctxTokens / input.ctxWindow > 0.7 ? "warn" : "ok";
	return { cwd, stats, model: input.model, ctxSeverity };
}

/** Colorize + fit to cols (drop cwd, then stats; model always survives). */
export function renderBar(data: BarData, cols: number): string {
	const sep = "  ";
	const ctxColor = data.ctxSeverity === "hot" ? "\x1b[31m" : data.ctxSeverity === "warn" ? "\x1b[33m" : "";
	// keep-order: model (always) > stats > cwd — drop from the front until it fits
	const segs: Array<{ text: string; color: string }> = [];
	if (data.cwd) segs.push({ text: data.cwd, color: "\x1b[2m" });
	if (data.stats.length > 0) segs.push({ text: data.stats.join(sep), color: ctxColor });
	if (data.model) segs.push({ text: data.model, color: "\x1b[36m" });

	const total = () => segs.map((s) => s.text).join(sep).length;
	while (segs.length > 1 && total() > cols - 2) segs.shift();
	if (segs.length === 0) return "";
	if (total() > cols - 2) {
		// clip the front of the first (only) segment — keep the newest info visible
		const overflow = total() - (cols - 3);
		segs[0] = { text: "…" + segs[0].text.slice(overflow + 1), color: segs[0].color };
	}
	return segs.map((s) => (s.color ? s.color + s.text + "\x1b[0m" : s.text)).join(sep);
}

/**
 * Clip a colored line to `max` display cells. ANSI escapes (SGR) are copied
 * through untouched and never count toward the width — clipping by raw
 * .length would truncate colored bars mid-escape and eat real text.
 */
function clipAnsiAware(text: string, max: number): string {
	let width = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\x1b") {
			const end = text.indexOf("m", i);
			if (end === -1) break; // not SGR — emit the rest untouched
			i = end; // loop's i++ lands after 'm'
			continue;
		}
		if (width >= max - 1) return text.slice(0, i) + "…";
		width++;
	}
	return text;
}

/** 999 → "999", 1234 → "1.2k", 1_500_000 → "1.5M" */
export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
	return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

// ---------------------------------------------------------------------------
// last-turn summary (title + bottom bar) — pure, unit-testable
// ---------------------------------------------------------------------------

export interface TurnSummary {
	/** A few words for the terminal title (≤ 10 code points — title bars are tiny). */
	short: string;
	/** One line for the pinned summary rows (≤ ~120 code points; wraps by display width). */
	oneLine: string;
}

/** Clip by Unicode code points — never splits a surrogate pair (CJK/emoji safe). */
export function clipCp(s: string, max: number): string {
	const cps = Array.from(s);
	return cps.length <= max ? s : cps.slice(0, Math.max(1, max - 1)).join("") + "…";
}

/** Display width of one code point: CJK / fullwidth / emoji take 2 terminal cells. */
export function charWidth(cp: number): 1 | 2 {
	if (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK radicals..Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
		(cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms
		(cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1faff) || // emoji blocks
		(cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
	)
		return 2;
	return 1;
}

/** Total display width in terminal cells. */
export function displayWidth(s: string): number {
	let w = 0;
	for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
	return w;
}

/** Clip a string to at most `cells` display cells (never splits a pair). */
function clipCells(s: string, cells: number): string {
	let out = "";
	let w = 0;
	for (const ch of s) {
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (w + cw > cells) break;
		out += ch;
		w += cw;
	}
	return out;
}

/**
 * Wrap text into lines of at most `maxCells` terminal cells (CJK-aware), up to
 * `maxLines`; anything past that is clipped onto the last line with an
 * ellipsis. This is what the pinned summary rows use — no mid-character
 * breaks, no invisible overflow.
 */
export function wrapByWidth(text: string, maxCells: number, maxLines = 2): string[] {
	if (maxCells < 2) return [""];
	const lines: string[] = [];
	let cur = "";
	let width = 0;
	for (const ch of text) {
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (width + cw > maxCells) {
			lines.push(cur);
			if (lines.length === maxLines) {
				// overflow: keep the last line readable with an ellipsis
				lines[maxLines - 1] = clipCells(lines[maxLines - 1], maxCells - 2) + "…";
				return lines;
			}
			cur = "";
			width = 0;
		}
		cur += ch;
		width += cw;
	}
	if (cur || lines.length === 0) lines.push(cur);
	return lines;
}

function basenameOf(p: string): string {
	const segs = p.replace(/\\/g, "/").split("/");
	return segs[segs.length - 1] || p;
}

/**
 * Distill a finished turn into a few words (terminal title, Claude-Code-style
 * glanceability) + one line (bottom bar). Pure derivation from the run's
 * messages: the user's ask states the intent, write/edit paths state the
 * action. No extra LLM call — instant, free, deterministic.
 */
export function summarizeTurn(messages: ReadonlyArray<{ role?: string; content?: unknown }>): TurnSummary {
	let userFirstLine = "";
	const files: string[] = [];
	let bashCount = 0;
	let answered = false;
	for (const m of messages) {
		if (m.role === "user" && !userFirstLine) {
			const text =
				typeof m.content === "string"
					? m.content
					: Array.isArray(m.content)
						? (m.content as Array<{ type?: string; text?: string }>).filter((b) => b?.type === "text").map((b) => b.text ?? "").join(" ")
						: "";
			const line = text.split("\n").map((t) => t.trim()).find(Boolean);
			if (line) userFirstLine = line.replace(/\s+/g, " ");
		} else if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content as Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }>) {
				if (block?.type === "toolCall") {
					const path = typeof block.arguments?.path === "string" ? block.arguments.path : undefined;
					if ((block.name === "write" || block.name === "edit") && path) {
						if (!files.includes(path)) files.push(path);
					} else if (block.name === "bash") bashCount++;
				}
			}
			if ((m.content as Array<{ type?: string; text?: string }>).some((b) => b?.type === "text" && b.text)) answered = true;
		}
	}
	const fileNames = files.map(basenameOf);
	const action =
		fileNames.length > 0
			? `改动 ${fileNames.slice(0, 2).join("、")}${fileNames.length > 2 ? ` 等${fileNames.length}个文件` : ""}`
			: bashCount > 0
				? `执行命令 ×${bashCount}`
				: answered
					? "回答"
					: "";
	const short = userFirstLine ? clipCp(userFirstLine, 10) : fileNames[0] ? clipCp(fileNames[0], 10) : clipCp(action, 10);
	const oneLine = clipCp(action && userFirstLine ? `${userFirstLine} → ${action}` : userFirstLine || action, 120);
	return { short, oneLine };
}

// ---------------------------------------------------------------------------
// chrome: scroll region + pinned bar
// ---------------------------------------------------------------------------

/**
 * Ask the terminal for the cursor position (CPR). Resolves undefined when the
 * terminal doesn't answer (pipe, non-VT, slow ConPTY). Must run BEFORE any
 * readline owns stdin — it reads raw stdin for the reply.
 */
export function queryCursorPosition(timeoutMs = 400): Promise<{ row: number; col: number } | undefined> {
	const input = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
	if (!input.isTTY || !process.stdout.isTTY) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const wasRaw = input.isRaw;
		try {
			input.setRawMode(true);
		} catch {
			resolve(undefined);
			return;
		}
		let buf = "";
		const cleanup = (): void => {
			clearTimeout(timer);
			input.removeListener("data", onData);
			try {
				input.setRawMode(wasRaw);
			} catch {
				/* best effort */
			}
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve(undefined);
		}, timeoutMs);
		const onData = (chunk: Buffer): void => {
			buf += chunk.toString("latin1");
			const match = buf.match(/\x1b\[(\d+);(\d+)R/);
			if (match) {
				cleanup();
				resolve({ row: Number(match[1]), col: Number(match[2]) });
			}
		};
		input.on("data", onData);
		process.stdout.write("\x1b[6n");
	});
}

export class TerminalChrome {
	private active = false;
	private barText = "";
	private trailText = "";
	private summaryText = "";
	private queueRows: string[] = [];

	/**
	 * Pinned bottom layout (top→bottom, 1-indexed rows):
	 *   rows-5, rows-4  queued input (live typing + queue list) — only rows ≥ 9
	 *   rows-3, rows-2  summary (last turn, wraps to ≤2 lines by display width)
	 *   rows-1          file trail
	 *   rows            status bar (cwd · stats · model)
	 * The scroll region is FIXED per layout (never resized on content
	 * appear/disappear) — a moving region desyncs ConPTY mid-output.
	 */
	private get summaryTop(): number {
		const { rows } = this.size();
		return rows - 3;
	}

	private get queueTop(): number {
		const { rows } = this.size();
		return rows - 5;
	}

	/** True when the terminal is tall enough for the queued-input rows. */
	get queueSupported(): boolean {
		return this.size().rows >= 9;
	}

	get isActive(): boolean {
		return this.active;
	}

	/**
	 * @param cursorRow screen row the cursor was on at startup (CPR).
	 * When the shell was scrolled to the bottom the cursor sits BELOW the
	 * region: output there never scrolls the region, and the prompt lands on
	 * the pinned bar row (typing overwrites the bar). Clamp it inside.
	 */
	enable(cursorRow?: number): void {
		if (this.active || !process.stdout.isTTY) return;
		this.active = true;
		this.applyRegion();
		const { rows } = this.size();
		const bottom = this.regionBottom();
		if (cursorRow !== undefined && cursorRow > bottom) {
			process.stdout.write(`\x1b[${bottom};1H`);
		}
		process.stdout.on("resize", this.onResize);
		// The shell would inherit the scroll region otherwise — always reset.
		process.on("exit", this.disable);
	}

	disable = (): void => {
		if (!this.active) return;
		this.active = false;
		process.stdout.off("resize", this.onResize);
		// Reset the region (DECSTBM homes the cursor → save/restore), then clear
		// ALL pinned rows so the next shell prompt is clean.
		process.stdout.write("\x1b7\x1b[r\x1b8");
		process.stdout.write(`\x1b[${Math.max(1, this.pinnedTop())};1H\x1b[J`);
	};

	/** Topmost pinned row for the current layout (start of disable's clear). */
	private pinnedTop(): number {
		const { rows } = this.size();
		return rows >= 9 ? rows - 5 : rows >= 6 ? rows - 3 : rows >= 4 ? rows - 2 : rows - 1;
	}

	setBar(text: string): void {
		this.barText = text;
		if (!this.active) return;
		const { rows, cols } = this.size();
		this.paint(rows, text, cols);
	}

	/** File-trail row, pinned directly above the status bar. */
	setTrail(text: string): void {
		this.trailText = text;
		if (!this.active) return;
		const { rows, cols } = this.size();
		if (rows < 4) return;
		this.paint(rows - 1, text, cols);
	}

	/**
	 * Queued-input rows, pinned above the summary: live typing echo + the
	 * waiting queue. Fixed 2-row reservation — the queue never scrolls with
	 * the agent's streaming output. Empty strings clear both rows.
	 */
	setQueue(rows: string[]): void {
		this.queueRows = rows;
		if (!this.active || !this.queueSupported) return;
		const { cols } = this.size();
		for (let i = 0; i < 2; i++) this.paint(this.queueTop + i, rows[i] ?? "", cols);
	}

	/** Last-turn summary, pinned above the trail. Wraps by DISPLAY width
	 * (CJK = 2 cells) across the two reserved rows, bottom-aligned — no
	 * ellipsis unless it overflows two full lines. Empty text clears both rows.
	 */
	setSummary(text: string): void {
		this.summaryText = text;
		if (!this.active) return;
		const { rows, cols } = this.size();
		if (rows < 6) return; // too short to afford summary rows
		const lines = this.summaryText ? wrapByWidth(this.summaryText, cols - 1, 2) : [];
		for (let i = 0; i < 2; i++) {
			// i=0 → top reserved row, i=1 → bottom (adjacent to the trail)
			const line = lines.length ? lines[lines.length - 2 + i] ?? "" : "";
			this.paint(this.summaryTop + i, line, cols);
		}
	}

	get summary(): string {
		return this.summaryText;
	}

	private paint(row: number, text: string, cols: number): void {
		const line = clipAnsiAware(text, cols - 1);
		process.stdout.write("\x1b7"); // save cursor
		process.stdout.write(`\x1b[${row};1H\x1b[2K${line}`);
		process.stdout.write("\x1b8"); // restore cursor
	}

	private onResize = (): void => {
		this.applyRegion();
		this.setBar(this.barText);
		this.setTrail(this.trailText);
		this.setSummary(this.summaryText);
		this.setQueue(this.queueRows);
	};

	/** Scroll region covers everything above ALL pinned rows (queue + summary + trail + bar). */
	private applyRegion(): void {
		const bottom = this.regionBottom();
		if (bottom >= 2) process.stdout.write(`\x1b7\x1b[1;${bottom}r\x1b8`);
	}

	private regionBottom(): number {
		const { rows } = this.size();
		return rows >= 9 ? rows - 6 : rows >= 6 ? rows - 4 : rows >= 4 ? rows - 2 : rows - 1;
	}

	private size(): { rows: number; cols: number } {
		return { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 };
	}
}

// ---------------------------------------------------------------------------
// slash popup
// ---------------------------------------------------------------------------

/**
 * Live slash-command menu (pi-style) for a readline REPL.
 *
 * Rendering rules (all bounded, bar-safe — no CSI J, which would wipe the
 * status bar row below the scroll region; readline's prompt()/line-echo also
 * clear below the prompt, so the bar must be repainted after those, wired via
 * onLineExtra/promptWithBar in the CLI):
 * - popup rows sit directly above the prompt row
 * - wipes are per-row \x1b[K bounded by the tracked shown count
 * - newlines at the region bottom scroll the region, never the bar row
 */
export class SlashPopup {
	private shown = 0;
	private enabled = true;
	private readonly isTty: boolean;

	constructor(
		private readonly rl: Interface,
		private readonly commands: SlashCommand[],
		/** Prompt exactly as passed to rl.setPrompt (ANSI included). */
		private readonly prompt: string,
		/** Called on every submitted line (the echo wipes the bar — repaint). */
		private readonly onLineExtra?: () => void,
	) {
		const io = rl as unknown as { input?: { isTTY?: boolean }; output?: { isTTY?: boolean } };
		this.isTty = Boolean(io.input?.isTTY && (io.output ?? process.stdout).isTTY);
	}

	attach(): void {
		// keypress fires AFTER readline's own handler (registered at
		// createInterface), so rl.line/rl.cursor already reflect the key.
		(this.rl as unknown as { input: NodeJS.ReadableStream }).input.on("keypress", this.onKey as (...args: unknown[]) => void);
		// no own 'line' listener: the CLI's line router calls onLineSubmit()
		// before processing the line (single-owner line dispatch)
	}

	/** Wipe the popup + repaint pinned rows. Called by the line router on submit. */
	onLineSubmit(): void {
		this.wipeAbove(true);
		this.onLineExtra?.();
	}

	setEnabled(on: boolean): void {
		this.enabled = on;
		if (!on) this.wipeAbove();
	}

	private get output(): NodeJS.WriteStream {
		return (this.rl as unknown as { output?: NodeJS.WriteStream }).output ?? process.stdout;
	}

	/**
	 * Clear the popup rows above the prompt; leave the prompt row to the echo.
	 * fromEcho: readline echoes the submit \n BEFORE emitting 'line' (verified
	 * empirically), so the cursor is one row below the prompt by then.
	 */
	private wipeAbove(fromEcho = false): void {
		if (this.shown === 0) return;
		const out = this.output;
		const up = this.shown + (fromEcho ? 1 : 0);
		out.write(`\x1b[${up}A`);
		for (let i = 0; i < this.shown; i++) {
			out.write("\r\x1b[K");
			if (i < this.shown - 1) out.write("\n");
		}
		// land back on the prompt row (may scroll the region if it is the last row — fine)
		out.write("\n");
		this.shown = 0;
	}

	private onKey = (): void => {
		if (!this.enabled || !this.isTty) {
			if (this.shown > 0) this.wipeAbove();
			return;
		}
		const line = this.rl.line;
		if (!line.startsWith("/")) {
			if (this.shown > 0) this.render([]);
			return;
		}
		const matches = filterSlashCommands(this.commands, line.slice(1));
		this.render(matches.length > 0 ? buildPopupRows(matches, process.stdout.columns || 80) : []);
	};

	/**
	 * Full render: wipe max(old,new) rows from the popup top (bounded — old
	 * popup remnants below the new one are erased too), rewrite popup rows,
	 * rewrite the prompt+buffer row, place the cursor at its column.
	 */
	private render(rows: string[]): void {
		const out = this.output;
		const wipe = Math.max(this.shown, rows.length);
		if (wipe === 0) return;
		if (this.shown > 0) out.write(`\x1b[${this.shown}A`); // → popup top
		for (let i = 0; i < wipe; i++) {
			out.write("\r\x1b[K");
			if (i < wipe - 1) out.write("\n");
		}
		if (wipe > 1) out.write(`\x1b[${wipe - 1}A`); // back to popup top
		for (const row of rows) out.write(row + "\x1b[K\n");
		out.write(this.prompt + this.rl.line);
		const back = this.rl.line.length - this.rl.cursor;
		if (back > 0) out.write(`\x1b[${back}D`);
		this.shown = rows.length;
	}
}

// ---------------------------------------------------------------------------
// spinner (silent-period feedback)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u2807"];

/**
 * Single-line spinner shown while the LLM produces nothing (wait feedback).
 * Rewrites only its own line (`\r\x1b[K` — bounded, bar-safe); on stop the line
 * is cleared and an optional prefix (e.g. the "puck › " prompt) is re-emitted
 * so streaming text continues exactly where it would have. No-op when piped.
 */
export class Spinner {
	private timer: NodeJS.Timeout | undefined;
	private startedAt = 0;
	private frame = 0;
	private visible = false;
	private prefix = "";
	private label = "";

	constructor(private readonly isTty: boolean) {}

	get active(): boolean {
		return this.timer !== undefined;
	}

	start(prefix: string, label: string): void {
		if (!this.isTty) return;
		this.stop(prefix); // restart cleanly if already running
		this.prefix = prefix;
		this.label = label;
		this.startedAt = Date.now();
		this.frame = 0;
		this.paint(prefix, label);
		this.timer = setInterval(() => this.paint(prefix, label), 100);
		// keep the loop responsive while the LLM stream is pending
		this.timer.unref?.();
	}

	/** Clear the spinner line; `restore` is re-emitted (e.g. "puck › "). */
	stop(restore = ""): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (this.visible) {
			process.stdout.write("\r\x1b[K" + restore);
			this.visible = false;
		}
	}

	private paint(prefix: string, label: string): void {
		const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
		const glyph = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
		this.frame++;
		process.stdout.write("\r\x1b[K" + prefix + "\x1b[2m" + glyph + " " + label + " \u2026 " + seconds + "s\x1b[0m ");
		this.visible = true;
	}
}
// ---------------------------------------------------------------------------
// tool renderers (pure — unit-testable)
// ---------------------------------------------------------------------------

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Red/green preview of an edit's first change — pure coloring, no diff algorithm. */
export function renderEditDiff(edits: unknown): string {
	if (!Array.isArray(edits) || edits.length === 0) return "";
	const first = (edits[0] ?? {}) as { oldText?: unknown; newText?: unknown };
	// Model args may arrive malformed (oldText/newText as object/array/number);
	// the renderer must never crash on them.
	const lines = (s: unknown): string[] => {
		if (s == null) return [];
		if (typeof s === "string") return s.split("\n").slice(0, 3);
		try {
			const json = JSON.stringify(s);
			return json === undefined ? [] : [json];
		} catch {
			// BigInt / circular structures → skip
			return [];
		}
	};
	let out = "";
	for (const l of lines(first.oldText)) out += "\n" + RED + "  - " + clipLine(l, 100) + RESET;
	for (const l of lines(first.newText)) out += "\n" + GREEN + "  + " + clipLine(l, 100) + RESET;
	return out;
}

/**
 * Tool result preview: first `fold` lines with a dim left bar (bordered-block
 * feel), then `└─ +M more` — big outputs stay scannable.
 */
export function renderToolEnd(result: { content?: Array<{ type?: string; text?: string }> }, fold = 3, width = 100): string {
	const text = (result.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
		.replace(/\s+$/, "");
	if (!text) return "";
	const lines = text.split("\n");
	let out = "";
	for (const l of lines.slice(0, fold)) out += DIM + "│ " + clipLine(l, width - 2) + RESET + "\n";
	if (lines.length > fold) out += DIM + "└─ +" + (lines.length - fold) + " more" + RESET + "\n";
	return out;
}

function clipLine(line: string, max: number): string {
	return line.length > max ? line.slice(0, Math.max(1, max - 1)) + "…" : line;
}

// ---------------------------------------------------------------------------
// file trail (agent-touched files, newest first)
// ---------------------------------------------------------------------------

/**
 * Tracks files the agent created/modified via the write/edit tools this run.
 * Newest first; re-touching a path moves it to the front. Paths are
 * normalized to forward slashes and relativized against cwd when inside it.
 */
export class FileTrail {
	private readonly paths: string[] = [];

	record(path: string, cwd = process.cwd()): void {
		let p = path.replace(/\\/g, "/");
		const cwdFwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
		if (p === cwdFwd) p = ".";
		else if (p.toLowerCase().startsWith(cwdFwd.toLowerCase() + "/")) p = p.slice(cwdFwd.length + 1);
		const idx = this.paths.indexOf(p);
		if (idx >= 0) this.paths.splice(idx, 1);
		this.paths.unshift(p);
		while (this.paths.length > 30) this.paths.pop();
	}

	/** Drop everything (rewind re-derives the trail from the kept transcript). */
	clear(): void {
		this.paths.length = 0;
	}

	/** Newest first snapshot. */
	list(): string[] {
		return [...this.paths];
	}
}

const DIM_COLOR = "\x1b[2m";
const RESET_COLOR = "\x1b[0m";

/**
 * One dim line: `✎ newest ← older ← oldest…` — the leftmost file is the most
 * recently touched. Oldest entries are dropped first to fit `cols`.
 */
export function renderTrail(paths: string[], cols: number, colored = Boolean(process.stdout.isTTY)): string {
	if (paths.length === 0) return "";
	const sep = " ← ";
	let shown = [...paths];
	const plain = (): string => "✎ " + shown.join(sep);
	while (shown.length > 1 && plain().length > cols - 1) shown.pop();
	let text = plain();
	if (text.length > cols - 1) text = text.slice(0, Math.max(0, cols - 2)) + "…";
	return colored ? DIM_COLOR + text + RESET_COLOR : text;
}

// ---------------------------------------------------------------------------
// interactive list selector (arrow-key)
// ---------------------------------------------------------------------------

export interface SelectItem {
	/** Primary label. */
	label: string;
	/** Right-aligned status/detail (e.g. "✓ stored"). */
	detail?: string;
}

export interface SelectOptions {
	/** Pipe mode: read a line via this callback (LineQueue askLine). */
	askLine?: (rl: Interface) => Promise<string>;
	/** Hint line under the list (TTY). Defaults to the arrow hint. */
	hint?: string;
	/** Extra hotkeys: char → result value (e.g. { i: -2 } for "import"). */
	extraKeys?: Record<string, number>;
	/** Result returned when the user cancels (q/Esc/invalid pipe input). */
	cancelResult?: number;
}

/**
 * Interactive single-choice list.
 *   TTY:  ↑/↓ move · Enter select · 1-9 quick select · q/Esc cancel
 *   pipe: numeric line input (back-compat with scripted flows)
 * Resolves: selected index, or cancelResult (-1 default), or an extraKeys value.
 */
// ---------------------------------------------------------------------------
// double-ESC detection (rewind trigger, Claude Code style)
// ---------------------------------------------------------------------------

/**
 * Two ESC keypresses within a short window → one "double press" event.
 * Pure (injectable clock) so the trigger window is unit-testable. Feeding a
 * non-ESC key is the host's business — this class only timestamps presses.
 */
export class DoubleEscDetector {
	private lastAt = 0;

	constructor(
		private readonly windowMs = 600,
		private readonly now: () => number = Date.now,
	) {}

	/** Register one ESC press; true when the previous press landed inside the window. */
	press(): boolean {
		const t = this.now();
		if (this.lastAt > 0 && t - this.lastAt <= this.windowMs) {
			this.lastAt = 0; // consumed — a third press starts a fresh window
			return true;
		}
		this.lastAt = t;
		return false;
	}

	/** Forget the pending press (e.g. a run started — don't chain across it). */
	reset(): void {
		this.lastAt = 0;
	}
}

/**
 * Detect standalone ESC keypresses at the raw-byte level.
 *
 * Why not keypress events: readline's keypress parser folds a lone ESC into
 * an escape-code prefix — a quick double press emits NO escape event (the
 * second ESC is swallowed and the next char would turn meta), and a slow
 * double press only emits after the ~500ms escapeCodeTimeout. The byte level
 * sees every ESC the terminal delivers, immediately.
 *
 * A chunk that is exactly "\x1b" counts as one press. Any following bytes
 * within `seqGraceMs` cancel it — a split escape sequence ("\x1b" + "[A")
 * must not register as an ESC press. Returns a detach function.
 */
export function watchStandaloneEsc(
	input: NodeJS.ReadableStream,
	onPress: () => void,
	seqGraceMs = 50,
): () => void {
	let timers: NodeJS.Timeout[] = [];
	const onData = (chunk: string | Buffer): void => {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
		const alone = bytes.length === 1 && bytes[0] === 0x1b;
		if (alone) {
			const timer = setTimeout(() => {
				timers = timers.filter((t) => t !== timer);
				onPress();
			}, seqGraceMs);
			timers.push(timer);
		} else if (timers.length > 0) {
			// a split sequence's tail — the pending ESC was its first byte
			for (const t of timers) clearTimeout(t);
			timers = [];
		}
	};
	input.on("data", onData);
	return () => {
		input.off("data", onData);
		for (const t of timers) clearTimeout(t);
	};
}

// ---------------------------------------------------------------------------
// queued-input view (pinned rows) — pure, unit-testable
// ---------------------------------------------------------------------------

/** Prefixes that mark a queued line as an interjection (steering) request —
 *  ASCII "!" and the full-width "！" (Chinese IME), so the user never has to
 *  switch input methods to interject. */
export const QUEUE_INTERJECT_PREFIXES = ["!", "！"] as const;

/**
 * Split an Enter'ed line into { interject, text }: lines starting with "!" or
 * "！" request an interjection (steering); the prefix is stripped and the rest
 * trimmed. Pure — shared by the REPL wiring and tests.
 */
export function parseInterject(line: string): { interject: boolean; text: string } {
	for (const prefix of QUEUE_INTERJECT_PREFIXES) {
		if (line.startsWith(prefix)) return { interject: true, text: line.slice(prefix.length).trim() };
	}
	return { interject: false, text: line };
}

export interface QueueViewState {
	/** True while a run is streaming and the queue UI owns the keyboard. */
	active: boolean;
	/** Text typed during the run, not yet submitted (live echo). */
	typing: string;
	/** Lines waiting for the run to settle (drained in order). */
	queued: string[];
	/** Lines already injected into the running conversation (steering). */
	interjected: number;
}

/**
 * Render the two pinned queued-input rows (upper = queue list, lower = live
 * typing / mode hint). Pure — no ANSI when colored=false; both rows clip to
 * `cols` display cells so long queues degrade to an ellipsis instead of
 * wrapping over the pinned rows below.
 */
export function renderQueueRows(view: QueueViewState, cols: number, colored = true): string[] {
	const max = Math.max(0, cols - 1);
	const clip = (s: string): string => (displayWidth(s) <= max ? s : clipCells(s, Math.max(1, max - 1)) + "…");
	// upper row: waiting queue (+ interjected count); count stays visible even
	// when the line list clips
	let top = "";
	if (view.queued.length > 0 || view.interjected > 0) {
		const parts: string[] = [];
		if (view.queued.length > 0) parts.push(`已排队${view.queued.length}`);
		if (view.interjected > 0) parts.push(`已插队${view.interjected}`);
		top = view.queued.length > 0 ? `⏳ ${parts.join(" · ")}: ${view.queued.join(" | ")}` : `⏳ ${parts.join(" · ")}`;
	}
	// lower row: live typing (cyan, prompt-style) or the mode hint
	let bottom = "";
	if (view.typing) bottom = "you › " + view.typing;
	else if (view.active)
		bottom = view.queued.length > 0 || view.interjected > 0 ? `继续输入排队 · !/！ 开头 = 立即插队` : `运行中输入将排队 · !/！ 开头 = 立即插队`;
	return [
		colored && top ? DIM_COLOR + clip(top) + RESET_COLOR : clip(top),
		colored && bottom
			? view.typing
				? "\x1b[36m" + clip(bottom) + RESET_COLOR
				: DIM_COLOR + clip(bottom) + RESET_COLOR
			: clip(bottom),
	];
}

/**
 * QueuedInput — owns the keyboard while a run is streaming.
 *
 * Why: readline assumes it owns the current line, but during a run our own
 * streamed output advances the cursor — readline's per-keypress refresh
 * would clear the streaming text, and our deltas would swallow the user's
 * echoed input (the "typed text disappears under AI output" bug).
 *
 * Instead we SUSPEND readline's keypress handlers (same trick as
 * selectFromList) and hand every keystroke to the host: printable chars
 * update a buffer the host echoes in its pinned queue rows (never inline in
 * the streaming area, where AI output would visually cover it); Enter
 * submits the buffer to onQueue (the host decides queue vs interject).
 * Ctrl+C is forwarded so the two-press-to-exit guard keeps working
 * (readline's SIGINT detection is dead while its handlers are detached).
 */
export class QueuedInput {
	private buf = "";
	private suspended: Array<(...args: unknown[]) => void> = [];
	private attached = false;

	constructor(
		private readonly handlers: {
			/** Submitted line (Enter). May be empty/whitespace — host decides (and filters). */
			onQueue: (line: string) => void;
			onSigint: () => void;
			/** ESC key — host semantics (stop the streaming run when active). */
			onEscape?: () => void;
			/** Typed-text echo: the host renders the live buffer in its pinned queue rows. */
			onEcho: (str: string, buf: string) => void;
		},
	) {}

	attach(rl: Interface): void {
		if (this.attached) return;
		this.attached = true;
		this.buf = "";
		const input = (rl as unknown as { input: NodeJS.ReadableStream & { isTTY?: boolean } }).input;
		this.suspended = input.listeners("keypress") as Array<(...args: unknown[]) => void>;
		for (const l of this.suspended) input.removeListener("keypress", l);
		input.on("keypress", this.onKey);
	}

	detach(rl: Interface): void {
		if (!this.attached) return;
		this.attached = false;
		const input = (rl as unknown as { input: NodeJS.ReadableStream }).input;
		input.removeListener("keypress", this.onKey);
		for (const l of this.suspended) input.on("keypress", l);
		this.suspended = [];
		// the in-flight buffer dies here — the host already echoed the
		// queued line; an unfinished buffer is dropped (matches what the user saw)
		this.buf = "";
	}

	private onKey = (str: string, key?: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }): void => {
		if (key?.ctrl && key.name === "c") {
			this.handlers.onSigint();
			return;
		}
		// ESC during a run: stop the AI gracefully (the run settles with an
		// aborted assistant message; the transcript stays resumable). Handled by
		// the host — this class only forwards the keystroke.
		if (key?.name === "escape") {
			this.handlers.onEscape?.();
			return;
		}
		if (key?.name === "enter" || key?.name === "return") {
			const line = this.buf;
			this.buf = "";
			// always forward — the host clears its typing row and filters blanks
			this.handlers.onQueue(line);
			return;
		}
		if (key?.name === "backspace") {
			// the typing lives in the host's pinned row (not inline in the stream),
			// so backspace simply updates the buffer and the row repaints live
			this.buf = Array.from(this.buf).slice(0, -1).join("");
			this.handlers.onEcho("", this.buf);
			return;
		}
		// printable only (spaces included — they used to be trimmed away)
		if (str && str >= " " && !key?.ctrl && !key?.meta) {
			this.buf += str;
			this.handlers.onEcho(str, this.buf);
		}
	};
}
export function selectFromList(rl: Interface, title: string, items: SelectItem[], opts: SelectOptions = {}): Promise<number> {
	const cancel = opts.cancelResult ?? -1;
	if (items.length === 0) return Promise.resolve(cancel);

	const isTty = Boolean((rl as unknown as { input?: { isTTY?: boolean } }).input?.isTTY && process.stdout.isTTY);
	if (!isTty) {
		// pipe fallback: numbered list + one line of input
		console.log("\x1b[1m" + title + "\x1b[0m");
		items.forEach((item, i) => {
			const detail = item.detail ? "  " + item.detail : "";
			console.log(`  ${i + 1}. ${item.label}${detail}`);
		});
		if (!opts.askLine) return Promise.resolve(cancel);
		process.stdout.write("选择编号: ");
		return opts.askLine(rl).then((answer) => {
			const trimmed = answer.trim();
			// extraKeys work in pipe mode too (single-char answers like `m` for
			// "load more" or `a`/`c` for scope toggles) — the TTY hotkeys and the
			// pipe fallback stay feature-equal
			if (opts.extraKeys && Object.prototype.hasOwnProperty.call(opts.extraKeys, trimmed)) {
				return opts.extraKeys[trimmed];
			}
			if (/^\d+$/.test(trimmed)) {
				const n = Number(trimmed);
				if (n >= 1 && n <= items.length) return n - 1;
			}
			return cancel;
		});
	}

	// --- TTY: arrow-key selection -------------------------------------------
	const out = process.stdout;
	const hint = opts.hint ?? "↑/↓ 选择 · Enter 确认 · q 取消";
	let cursor = 0;
	let done = false;

	// Window: lists longer than the screen must not scroll — a scrolled redraw
	// misaligns with the terminal's scroll region. Pinned bottom layout is
	// queue (2) + bar + trail + 2 summary rows → the usable region is rows-6;
	// the list must fit ABOVE the prompt row inside it (title + visible + hint
	// + prompt ≤ region).
	const screenRows = process.stdout.rows || 24;
	const maxVisible = Math.max(3, Math.min(items.length, screenRows - 9));
	let windowStart = 0;

	const moreHint = (): string => {
		const up = windowStart > 0;
		const down = windowStart + Math.min(items.length, maxVisible) < items.length;
		return up || down ? ` (${up ? "↑更多" : ""}${up && down ? " · " : ""}${down ? "↓更多" : ""})` : "";
	};

	const render = (): void => {
		const visible = items.slice(windowStart, windowStart + maxVisible);
		out.write(`\x1b[${visible.length + 1}A`);
		for (let i = 0; i < visible.length; i++) {
			const item = visible[i];
			const marker = i === cursor - windowStart ? "\x1b[36m→\x1b[0m " : "  ";
			const detail = item.detail ? "  " + item.detail : "";
			out.write("\r\x1b[K" + marker + item.label + detail + "\n");
		}
		out.write("\r\x1b[K" + DIM_COLOR + hint + moreHint() + RESET_COLOR + "\n");
	};

	return new Promise<number>((resolve) => {
		const input = (rl as unknown as { input: NodeJS.ReadableStream }).input;
		// Suspend readline's own key handling while the selector owns input:
		// otherwise ↑/↓ walk the input history and echo stray text over the list.
		// (SlashPopup's listener stays — it is disabled via setEnabled.)
		const suspended = input.listeners("keypress") as Array<(...args: unknown[]) => void>;
		for (const listener of suspended) input.removeListener("keypress", listener);

		const finish = (result: number): void => {
			if (done) return;
			done = true;
			input.removeListener("keypress", asListener);
			// restore readline's handlers (original registration order)
			for (const listener of suspended) input.on("keypress", listener);
			resolve(result);
		};

		const onKey = (str: string, key: { name?: string } | undefined): void => {
			if (done) return;
			if (key?.name === "up" || key?.name === "k") {
				cursor = (cursor - 1 + items.length) % items.length;
				if (cursor < windowStart) windowStart = cursor;
				else if (cursor >= windowStart + maxVisible) windowStart = Math.max(0, items.length - maxVisible);
				render();
				return;
			}
			if (key?.name === "down" || key?.name === "j") {
				cursor = (cursor + 1) % items.length;
				if (cursor >= windowStart + maxVisible) windowStart = cursor - maxVisible + 1;
				else if (cursor < windowStart) windowStart = 0;
				render();
				return;
			}
			if (key?.name === "enter" || key?.name === "return") {
				finish(cursor);
				return;
			}
			if (key?.name === "escape" || str === "q") {
				finish(cancel);
				return;
			}
			const ch = (str ?? "").trim();
			if (opts.extraKeys && Object.prototype.hasOwnProperty.call(opts.extraKeys, ch)) {
				finish(opts.extraKeys[ch]);
				return;
			}
			if (/^[1-9]$/.test(ch)) {
				const n = Number(ch) - 1;
				if (n < items.length) finish(n);
				return;
			}
			// other printable chars are ignored (nothing echoes — readline is suspended)
		};

		const asListener = onKey as (...args: unknown[]) => void;

		// initial paint: title (kept) + window + hint — cursor marker included so the
		// selection state is visible before any keypress
		const visible = items.slice(windowStart, windowStart + maxVisible);
		out.write("\x1b[1m" + title + "\x1b[0m\n");
		for (let i = 0; i < visible.length; i++) {
			const item = visible[i];
			const marker = i === cursor - windowStart ? "\x1b[36m→\x1b[0m " : "  ";
			const detail = item.detail ? "  " + item.detail : "";
			out.write(marker + item.label + detail + "\n");
		}
		out.write(DIM_COLOR + hint + moreHint() + RESET_COLOR + "\n");
		// Defer attaching: a selector opened synchronously from a 'line' handler
		// would otherwise receive the SAME Enter keypress that submitted the
		// command and instantly "select" index 0.
		setImmediate(() => {
			if (!done) input.on("keypress", asListener);
		});
	});
}

// ---------------------------------------------------------------------------
// working title (terminal tab/title, Claude Code style)
// ---------------------------------------------------------------------------

/** OSC 0 title sequence (BEL-terminated; Windows Terminal & co pass it through). */
export function setTerminalTitle(title: string): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write(`\x1b]0;${title}\x07`);
}

const WORKING_FRAMES = ["✻", "✽", "✶", "✳"];

/**
 * Animates the terminal TITLE while the agent works: "✻ Working…" →
 * "✽ Working…" … (Claude Code style). Independent from the in-buffer spinner:
 * the title spans the whole run (LLM turns + tools), stops at run_end.
 */
export class WorkingTitle {
	private timer: NodeJS.Timeout | undefined;
	private frame = 0;

	constructor() {
		// whatever happened mid-run, the shell gets a clean title back
		process.on("exit", () => {
			if (this.timer !== undefined) setTerminalTitle("puck");
		});
	}

	start(label = "Working"): void {
		if (!process.stdout.isTTY) return;
		if (this.timer !== undefined) return; // idempotent: multi-turn runs keep animating
		this.paint(label);
		this.timer = setInterval(() => this.paint(label), 180);
		this.timer.unref?.();
	}

	stop(idleTitle = "puck"): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		setTerminalTitle(idleTitle);
	}

	private paint(label: string): void {
		const glyph = WORKING_FRAMES[this.frame % WORKING_FRAMES.length];
		this.frame++;
		process.stdout.write(`\x1b]0;${glyph} ${label}…\x07`);
	}
}
