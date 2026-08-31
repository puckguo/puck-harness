/**
 * @file-mention — codex-style "@path" file picker for the readline REPL.
 *
 * Flow (mirrors codex CLI's file-search crate, in ~zero-dep TypeScript):
 *
 * 1. FileIndex walks cwd + subfolders asynchronously (progressive — batches
 *    stream into the popup while the walk is still running), skipping heavy
 *    dirs (node_modules, .git, …) and honoring a practical .gitignore subset
 *    (nested rules, dir-only, negation, ** globs). Result is cached with a
 *    TTL so the second "@" in a session is instant.
 *
 * 2. While the cursor sits inside an "@token", every keystroke re-filters the
 *    index with a fuzzy scorer: exact basename substring > fuzzy basename >
 *    path substring > fuzzy path, shallower/shorter paths preferred. Sorted
 *    by score desc then path asc (same tiebreak as codex's
 *    cmp_by_score_desc_then_path_asc).
 *
 * 3. MentionPopup owns the keyboard while open (readline's keypress handlers
 *    are suspended and manually forwarded — the same trick QueuedInput and
 *    selectFromList use), so ↑/↓ move the selection instead of walking the
 *    input history, and Tab/Enter insert the selected path into the line.
 *
 * 4. On submit, expandFileMentions() appends the content of every existing
 *    "@path" token to the user message — the model sees the file without a
 *    read round-trip (what @-mention means in codex).
 *
 * Rendering follows SlashPopup: rows above the prompt row, bounded per-row
 * wipes, no CSI J (bar-safe). No-op unless stdin/stdout are TTYs.
 */

import type { Interface } from "node:readline";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// file index: walk + gitignore subset
// ---------------------------------------------------------------------------

export interface FileIndexEntry {
	/** Relative path from the index root, forward slashes, no leading "./". */
	path: string;
	/** True when the entry is a directory (codex lets you @ directories too). */
	dir: boolean;
}

/**
 * Hard skip list — dirs that are never worth suggesting regardless of
 * gitignore (dependency caches, VCS state, build artifacts). Deliberately
 * narrower than a lint ignore: build/dist stay indexable when the project
 * has no gitignore for them (some projects DO have source under build/).
 */
const SKIP_DIR_NAMES = new Set([
	"node_modules", ".git", ".hg", ".svn", // deps + VCS
	".cache", ".turbo", ".next", ".nuxt", ".output", // framework caches
	"coverage", "__pycache__", ".pytest_cache", ".mypy_cache", // test/tool caches
	".venv", "venv", ".idea", ".gradle", ".pnpm-store", ".yarn", // envs + IDEs
	"target", // rust/cargo build (huge, never source)
	".puck", // puck session transcripts (internal state, not project files)
]);

/** One compiled .gitignore line. `regex` tests paths relative to the walk root. */
interface GitignoreRule {
	negated: boolean;
	/** Trailing-slash rule — only matches directories. */
	dirOnly: boolean;
	regex: RegExp;
}

/**
 * Compile .gitignore text into match rules. Covers the patterns that matter
 * for a file picker: comments, blank lines, `!` negation, trailing `/`
 * (dir-only), leading `/` or embedded `/` (root-anchored), `*` (within one
 * segment), `?`, and `**`. Character classes and escapes are out of scope —
 * an over-matching rule only costs a missing suggestion, never a crash.
 *
 * `scope` is the rule file's directory relative to the walk root
 * ("" for the root .gitignore, "docs/" for docs/.gitignore) — git scopes a
 * nested pattern to its own subtree.
 */
export function parseGitignoreRules(text: string, scope: string): GitignoreRule[] {
	const rules: GitignoreRule[] = [];
	for (let raw of text.split(/\r?\n/)) {
		// trailing spaces are ignored unless escaped (git rule); leading too
		raw = raw.replace(/^\s+/, (m) => (m.includes("\\") ? m : ""));
		raw = raw.replace(/\s+$/, (m) => (m.includes("\\") ? m : ""));
		if (!raw || raw.startsWith("#")) continue;
		let negated = false;
		if (raw.startsWith("!")) {
			negated = true;
			raw = raw.slice(1);
		}
		if (!raw || raw === "/") continue;
		if (raw === "**") {
			// bare "**" ignores everything below the rule file's scope
			rules.push({ negated, dirOnly: false, regex: new RegExp("(?:^|/)" + globLit(scope) + ".") });
			continue;
		}
		let dirOnly = false;
		if (raw.endsWith("/")) {
			dirOnly = true;
			raw = raw.slice(0, -1);
		}
		// anchored: a slash anywhere (after stripping the trailing one) pins
		// the pattern to the rule file's directory; otherwise it matches the
		// final path segment at any depth
		const anchored = raw.includes("/");
		if (raw.startsWith("/")) raw = raw.slice(1);
		if (!raw) continue;
		const body = escapeGlob(raw);
		const prefix = anchored ? "^" + globLit(scope) : "(?:^|.*/)" + (scope ? globLit(scope) + "(?:.*/)?" : "");
		rules.push({ negated, dirOnly, regex: new RegExp(prefix + body + "$") });
	}
	return rules;
}

/** Glob → regex: `**` spans separators, `*`/`?` stay within one segment. */
function escapeGlob(pattern: string): string {
	// pre-pass: `**/` (zero or more dirs — git: a/**/b matches a/b too) and
	// trailing `/**` (everything below) get sentinels; then one pass escapes
	// regex metachars, maps * → marker and ? → single-segment; finally ** pairs
	// → .* and single * → [^/]* (a single * must never cross a separator)
	const pre = pattern.replace(/\*\*\//g, "\u0002").replace(/\/\*\*/g, "\u0003");
	const escaped = pre.replace(/[.+^${}()|[\]\\*?]/g, (ch) => (ch === "?" ? "[^/]" : ch === "*" ? "\u0000" : "\\" + ch));
	return escaped
		.replace(/\u0002/g, "(?:.*/)?")
		.replace(/\u0003/g, "/.*")
		.replace(/\u0000\u0000/g, ".*")
		.replace(/\u0000/g, "[^/]*");
}

/** Escape scope/prefix fragments literally (they are plain path text). */
function globLit(text: string): string {
	return text.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
}


/**
 * Decide whether `path` is ignored. Last matching rule wins (git order);
 * dir-only rules never match files. Non-anchored patterns match any segment.
 */
export function isIgnored(path: string, isDir: boolean, rules: readonly GitignoreRule[]): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (rule.dirOnly && !isDir) continue;
		if (rule.regex.test(path)) ignored = !rule.negated;
	}
	return ignored;
}

export interface WalkOptions {
	/** Progressive callback — fired every ~80ms with the entries so far. */
	onBatch?: (entries: FileIndexEntry[], truncated: boolean) => void;
	/** Hard entry cap — larger trees are marked truncated (like codex's limit). */
	maxEntries?: number;
	maxDepth?: number;
	/** Wall-clock budget; exceeded → truncated, partial index serves the popup. */
	timeoutMs?: number;
}

/**
 * Breadth-first walk of `cwd`. BFS (not depth-first) so shallow files — the
 * ones users @ most — reach the popup first while deep trees still stream in.
 * Symlinks are listed as files but never followed (cycle safety).
 */
export async function walkProjectFiles(cwd: string, opts: WalkOptions = {}): Promise<{ entries: FileIndexEntry[]; truncated: boolean }> {
	const maxEntries = opts.maxEntries ?? 20_000;
	const maxDepth = opts.maxDepth ?? 16;
	const deadline = Date.now() + (opts.timeoutMs ?? 3500);
	const entries: FileIndexEntry[] = [];
	let truncated = false;
	let lastNotify = 0;
	const notify = (force = false): void => {
		const now = Date.now();
		if (!force && now - lastNotify < 80) return;
		lastNotify = now;
		opts.onBatch?.(entries, truncated);
	};
	type DirItem = { dir: string; rel: string; depth: number; rules: GitignoreRule[] };
	const queue: DirItem[] = [{ dir: cwd, rel: "", depth: 0, rules: [] }];
	while (queue.length > 0) {
		if (entries.length >= maxEntries || Date.now() > deadline) {
			truncated = true;
			break;
		}
		const item = queue.shift()!;
		// the dir's own .gitignore governs entries INSIDE it — read lazily at
		// dequeue time and layer it on top of the inherited rules
		let rules = item.rules;
		try {
			const text = await readFile(join(item.dir, ".gitignore"), "utf8");
			const own = parseGitignoreRules(text, item.rel ? item.rel + "/" : "");
			if (own.length > 0) rules = [...item.rules, ...own];
		} catch {
			/* no .gitignore here — inherited rules only */
		}
		let dirents: Dirent[];
		try {
			dirents = await readdir(item.dir, { withFileTypes: true });
		} catch {
			continue; // unreadable (permissions, raced deletion) — skip subtree
		}
		for (const d of dirents) {
			if (entries.length >= maxEntries) {
				// hard cap enforced per entry — one huge directory must not blow past it
				truncated = true;
				break;
			}
			const rel = item.rel ? item.rel + "/" + d.name : d.name;
			if (d.isDirectory()) {
				if (SKIP_DIR_NAMES.has(d.name)) continue;
				if (isIgnored(rel, true, rules)) continue;
				entries.push({ path: rel, dir: true });
				if (item.depth < maxDepth) queue.push({ dir: join(item.dir, d.name), rel, depth: item.depth + 1, rules });
			} else if (d.isFile() || d.isSymbolicLink()) {
				if (isIgnored(rel, false, rules)) continue;
				entries.push({ path: rel, dir: false });
			}
		}
		notify();
	}
	notify(true);
	return { entries, truncated };
}

/**
 * Cached project file index. One walk per refresh; entries stream to
 * listeners via onBatch while walking (the popup re-filters live). A walk
 * completed within `maxAgeMs` is reused — instant popup on repeat "@" — and
 * a later "@" past the TTL picks up files created mid-session.
 */
export class FileIndex {
	private entries: FileIndexEntry[] = [];
	private state: "idle" | "walking" | "ready" = "idle";
	private readyAt = 0;
	private truncatedFlag = false;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly cwd: string = process.cwd()) {}

	get walking(): boolean {
		return this.state === "walking";
	}
	get ready(): boolean {
		return this.state === "ready";
	}
	get truncated(): boolean {
		return this.truncatedFlag;
	}
	get size(): number {
		return this.entries.length;
	}
	list(): readonly FileIndexEntry[] {
		return this.entries;
	}

	/** Progressive updates — the callback fires on every batch and at settle. */
	onUpdate(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private notify(): void {
		for (const l of [...this.listeners]) {
			try {
				l();
			} catch {
				/* a broken listener must never kill the walk */
			}
		}
	}

	/** Start a fresh walk unless one is running or the cache is young enough. */
	refreshIfStale(maxAgeMs = 30_000): void {
		if (this.state === "walking") return;
		if (this.state === "ready" && Date.now() - this.readyAt < maxAgeMs) return;
		this.state = "walking";
		this.entries = [];
		this.truncatedFlag = false;
		this.notify();
		void walkProjectFiles(this.cwd, {
			onBatch: (entries, truncated) => {
				this.entries = entries;
				this.truncatedFlag = truncated;
				this.notify();
			},
		})
			.then(({ entries, truncated }) => {
				this.entries = entries;
				this.truncatedFlag = truncated;
			})
			.catch(() => {
				/* walk failed — keep whatever partial entries streamed in */
			})
			.finally(() => {
				this.state = "ready";
				this.readyAt = Date.now();
				this.notify();
			});
	}
}

// ---------------------------------------------------------------------------
// mention token + fuzzy matching
// ---------------------------------------------------------------------------

/** Chars that may continue an @token (word chars, path/dot/dash, CJK…). */
const isTokenChar = (ch: string): boolean => /[\w.\-/\\\u00c0-\uffff]/.test(ch);

export interface MentionToken {
	/** Index of the "@" in the line. */
	at: number;
	/** Text between "@" and the cursor (the live query, may be ""). */
	query: string;
}

/**
 * Find the mention token the cursor sits in: scan left from the cursor while
 * token chars continue, then require the char just before the run to be "@".
 * Returns null when the cursor is outside any token (codex: popup follows the
 * cursor — moving out of the token dismisses it).
 */
export function parseMentionToken(line: string, cursor: number): MentionToken | null {
	let i = cursor;
	while (i > 0 && isTokenChar(line[i - 1] ?? "")) i--;
	if (i === 0 || line[i - 1] !== "@") return null;
	return { at: i - 1, query: line.slice(i, cursor) };
}

/** What the scorer produces per path (entry kind is added by filterFiles). */
export interface FileScore {
	path: string;
	score: number;
	/** Matched char positions in the BASENAME (for highlighting); [] for path-level matches. */
	indices: number[];
}

/** A scored, sorted match — FileScore plus the entry kind (dir/file). */
export interface FileMatchResult extends FileScore {
	/** True when the match is a directory (rendered with a trailing "/"). */
	dir: boolean;
}

const WORD_START = /[._\-/ ]/;

/**
 * Fuzzy-score one indexed path against the query (case-insensitive; query
 * backslashes normalized to "/"). Tier ladder, best first:
 *
 *   400s  exact substring of the basename (start-of-name > word-start > mid)
 *   200s  fuzzy subsequence of the basename (consecutive runs rewarded)
 *   100s  exact substring anywhere in the path
 *    40s  fuzzy subsequence across the whole path
 *
 * Depth penalizes every tier (shallow files are usually what you mean); null
 * = no match at any tier. Empty query matches everything at depth-based
 * score so the bare "@" popup lists shallow files first, alphabetical.
 */
export function matchFileEntry(path: string, query: string): FileScore | null {
	const norm = (s: string): string => s.replace(/\\/g, "/").toLowerCase();
	const p = norm(path);
	const q = norm(query);
	const slash = p.lastIndexOf("/");
	const base = slash >= 0 ? p.slice(slash + 1) : p;
	const depth = slash < 0 ? 0 : p.slice(0, slash).split("/").length;
	if (q === "") return { path, score: -depth * 10, indices: [] };

	// tier 1: exact substring in basename
	const idx = base.indexOf(q);
	if (idx >= 0) {
		const startBonus = idx === 0 ? 60 : WORD_START.test(base[idx - 1] ?? "") ? 30 : 0;
		const score = 400 + startBonus - depth * 8 - (base.length - q.length) * 2;
		const indices: number[] = [];
		for (let i = idx; i < idx + q.length; i++) indices.push(i);
		return { path, score, indices };
	}
	// tier 2: fuzzy subsequence in basename
	const fuzzy = fuzzySubseq(base, q);
	if (fuzzy) {
		const score = 200 + fuzzy.consecutive * 8 + (fuzzy.positions[0] === 0 ? 30 : WORD_START.test(base[fuzzy.positions[0] - 1] ?? "") ? 12 : 0) - depth * 8 - base.length;
		return { path, score, indices: fuzzy.positions };
	}
	// tier 3: exact substring in the full path
	const pidx = p.indexOf(q);
	if (pidx >= 0) return { path, score: 100 - depth * 8 - (p.length - q.length), indices: [] };
	// tier 4: fuzzy subsequence across the full path
	const pfuzzy = fuzzySubseq(p, q);
	if (pfuzzy) return { path, score: 40 + pfuzzy.consecutive * 4 - depth * 8, indices: [] };
	return null;
}

/** Greedy left-to-right subsequence match; consecutive runs counted for bonus. */
function fuzzySubseq(hay: string, needle: string): { positions: number[]; consecutive: number } | null {
	const positions: number[] = [];
	let hi = 0;
	let consecutive = 0;
	for (const ch of needle) {
		const found = hay.indexOf(ch, hi);
		if (found === -1) return null;
		if (found === hi) consecutive++;
		positions.push(found);
		hi = found + 1;
	}
	return { positions, consecutive };
}

/** Filter + sort the index for a query: score desc, then path asc (codex tiebreak). */
export function filterFiles(entries: readonly FileIndexEntry[], query: string, limit = 200): FileMatchResult[] {
	const matches: FileMatchResult[] = [];
	for (const e of entries) {
		const m = matchFileEntry(e.path, query);
		if (m) matches.push({ ...m, dir: e.dir });
	}
	matches.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return matches.slice(0, limit);
}

// ---------------------------------------------------------------------------
// popup rows (pure — unit-testable)
// ---------------------------------------------------------------------------

export interface MentionRowOptions {
	cols: number;
	/** Matched-char highlight positions per row (aligned with `visible`). */
	indices?: number[][];
	/** True while the index walk is still streaming in. */
	walking?: boolean;
	/** Total matches (rows may be a window). */
	total: number;
	moreUp?: boolean;
	moreDown?: boolean;
}

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * Render popup rows: one per visible match (dim dir + basename, matched
 * chars magenta, selected row cyan marker like the slash popup) + a hint
 * footer. Paths clip from the LEFT (the basename — the discriminating part —
 * stays visible), mirroring codex's ellipsis style.
 */
export function buildMentionRows(visible: readonly FileMatchResult[], selected: number, opts: MentionRowOptions): string[] {
	const cols = Math.max(20, opts.cols);
	const rows: string[] = [];
	for (let i = 0; i < visible.length; i++) {
		const m = visible[i];
		const isSel = i === selected;
		const marker = isSel ? CYAN + "→" + RESET + " " : "  ";
		const slash = m.path.lastIndexOf("/");
		const dir = slash >= 0 ? m.path.slice(0, slash + 1) : "";
		const base = slash >= 0 ? m.path.slice(slash + 1) : m.path;
		// budget: cols - marker(2) - dir-dots prefix(≥3 when clipped)
		const budget = cols - 4;
		let dirText = dir;
		let baseText = base;
		if (dir.length + base.length > budget) {
			const keep = Math.max(1, budget - 4 - base.length);
			dirText = keep < dir.length ? "…" + dir.slice(dir.length - keep) : dir;
			baseText = base.slice(0, Math.max(1, budget - dirText.length));
		}
		// matched-char highlight (magenta) inside the basename
		const idxSet = new Set(opts.indices?.[i] ?? []);
		let painted = "";
		if (idxSet.size > 0) {
			painted = MAGENTA;
			for (let c = 0; c < baseText.length; c++) painted += (idxSet.has(c) ? BOLD + baseText[c] + RESET + MAGENTA : baseText[c]);
			painted += RESET;
		} else painted = baseText;
		const label = isSel ? dirText + CYAN + BOLD + painted + RESET : DIM + dirText + RESET + painted;
		rows.push(marker + label + (m.dir ? DIM + "/" + RESET : ""));
	}
	const bits = ["↑/↓ 选择", "Tab/Enter 插入", "Esc 关闭"];
	if (opts.walking) bits.push("索引中…");
	bits.push(`${opts.total} 项`);
	if (opts.moreUp || opts.moreDown) bits.push(`${opts.moreUp ? "↑更多" : ""}${opts.moreUp && opts.moreDown ? "·" : ""}${opts.moreDown ? "↓更多" : ""}`);
	rows.push(DIM + clipPlain(bits.join(" · "), cols - 1) + RESET);
	return rows;
}

/** Clip plain (uncolored) text by code points, ellipsis on overflow. */
function clipPlain(text: string, max: number): string {
	const cps = Array.from(text);
	return cps.length <= max ? text : cps.slice(0, Math.max(1, max - 1)).join("") + "…";
}

// ---------------------------------------------------------------------------
// MentionPopup — interactive, readline-compatible
// ---------------------------------------------------------------------------

interface MentionPopupOptions {
	/** Prompt exactly as passed to rl.setPrompt (ANSI included). */
	prompt: string;
	/** Host gate — popup only opens while the REPL idles (no wizard, no run). */
	isEnabled?: () => boolean;
	/** Fires on open/close; the host disables the slash popup while open. */
	onActiveChange?: (active: boolean) => void;
	/** Max visible rows (terminal-height aware default). */
	maxRows?: number;
}

/**
 * Live @-file menu for a readline REPL.
 *
 * Keyboard ownership: while OPEN, readline's keypress handlers are suspended
 * and every key is either consumed (↑/↓ move, Tab/Enter accept, Esc close)
 * or manually forwarded to the suspended handlers (typing, backspace, cursor
 * motion…). That keeps readline's line editing intact — history ↑/↓ is the
 * only behavior intentionally shadowed, exactly while the selection is live.
 *
 * Rendering matches SlashPopup: rows above the prompt, bounded wipes, prompt
 * row rewritten after the rows, cursor re-placed (bar-safe, no CSI J).
 */
export class MentionPopup {
	private enabled = true;
	private active = false;
	private shown = 0;
	private matches: FileMatchResult[] = [];
	private selected = 0;
	private windowStart = 0;
	private query = "";
	private tokenAt = -1;
	private suspended: Array<(...args: unknown[]) => void> = [];
	private lastQuery = "\u0000";
	private renderPending = false;
	private readonly isTty: boolean;
	private unsubscribeIndex: (() => void) | undefined;

	constructor(
		private readonly rl: Interface,
		private readonly index: FileIndex,
		private readonly opts: MentionPopupOptions,
	) {
		const io = rl as unknown as { input?: { isTTY?: boolean }; output?: { isTTY?: boolean } };
		this.isTty = Boolean(io.input?.isTTY && (io.output ?? process.stdout).isTTY);
	}

	private get output(): NodeJS.WriteStream {
		return (this.rl as unknown as { output?: NodeJS.WriteStream }).output ?? process.stdout;
	}

	private get input(): NodeJS.ReadableStream {
		return (this.rl as unknown as { input: NodeJS.ReadableStream }).input;
	}

	attach(): void {
		// passive listener (registered AFTER readline's own — fires with
		// rl.line/rl.cursor already reflecting the key): opens the popup when
		// the cursor lands inside an @token
		this.input.on("keypress", this.passiveKey as (...args: unknown[]) => void);
		this.unsubscribeIndex = this.index.onUpdate(() => this.scheduleProgressiveRender());
	}

	/** Wipe the popup on line submit (defensive — Enter is normally consumed). */
	onLineSubmit(): void {
		if (this.active) this.close();
		else if (this.shown > 0) this.wipeAbove();
	}

	setEnabled(on: boolean): void {
		this.enabled = on;
		if (!on && this.active) this.close();
	}

	get isOpen(): boolean {
		return this.active;
	}

	// --- passive: watch for the token to appear ----------------------------

	private passiveKey = (): void => {
		if (this.active || !this.enabled || !this.isTty) return;
		if (typeof this.opts.isEnabled === "function" && !this.opts.isEnabled()) return;
		const line = this.rl.line;
		if (line.startsWith("/")) return; // slash-command mode owns "/" lines
		const token = parseMentionToken(line, this.rl.cursor);
		if (!token) return;
		this.open(token);
	};

	// --- active: own the keyboard -------------------------------------------

	private open(token: MentionToken): void {
		this.active = true;
		this.tokenAt = token.at;
		this.query = token.query;
		this.selected = 0;
		this.windowStart = 0;
		this.lastQuery = token.query;
		this.index.refreshIfStale(); // instant if cached, else streams in
		this.suspended = this.input.listeners("keypress") as Array<(...args: unknown[]) => void>;
		for (const l of this.suspended) this.input.removeListener("keypress", l);
		this.input.on("keypress", this.activeKey as (...args: unknown[]) => void);
		this.recompute();
		this.render();
		this.opts.onActiveChange?.(true);
	}

	private close(): void {
		if (!this.active) return;
		this.active = false;
		this.input.removeListener("keypress", this.activeKey as (...args: unknown[]) => void);
		for (const l of this.suspended) this.input.on("keypress", l);
		this.suspended = [];
		this.wipeAbove();
		this.redrawLine();
		this.matches = [];
		this.selected = 0;
		this.opts.onActiveChange?.(false);
	}

	/** Forward a key to the suspended handlers (readline edits the line). */
	private forward(str: string, key: unknown): void {
		for (const l of [...this.suspended]) l(str, key);
	}

	private activeKey = (str: string, key?: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void => {
		if (!this.active) return;
		const name = key?.name ?? "";
		// Ctrl+C: restore readline's flow FIRST (SIGINT → exit guard), then
		// forward — the popup must never swallow the interrupt
		if (key?.ctrl && name === "c") {
			this.close();
			this.forward(str, key);
			return;
		}
		// ↑/↓ (+ emacs ^P/^N): selection moves, history does NOT
		if (name === "up" || (key?.ctrl && name === "p")) {
			this.move(-1);
			return;
		}
		if (name === "down" || (key?.ctrl && name === "n")) {
			this.move(1);
			return;
		}
		// Tab / Enter: accept the selection. With zero matches Enter falls
		// through to readline (submits the line as typed) — codex behavior.
		if (name === "tab") {
			this.accept();
			return;
		}
		if (name === "enter" || name === "return") {
			if (this.matches.length > 0) this.accept();
			else {
				this.close();
				this.forward(str, key);
			}
			return;
		}
		if (name === "escape") {
			this.close();
			return;
		}
		// anything else belongs to readline's editor — forward, then re-sync
		// the popup with the (possibly changed) line
		this.forward(str, key);
		this.syncFromLine();
	};

	private move(delta: number): void {
		if (this.matches.length === 0) return;
		this.selected = (this.selected + delta + this.matches.length) % this.matches.length;
		const maxVisible = this.maxVisible();
		if (this.selected < this.windowStart) this.windowStart = this.selected;
		else if (this.selected >= this.windowStart + maxVisible) this.windowStart = this.selected - maxVisible + 1;
		this.render();
	}

	private accept(): void {
		const m = this.matches[this.selected];
		if (!m) {
			this.close();
			return;
		}
		const line = this.rl.line;
		const cursor = this.rl.cursor;
		const insert = "@" + m.path + " ";
		// rl.line/rl.cursor are readonly in @types/node — mutate through a view
		const mutable = this.rl as unknown as { line: string; cursor: number };
		mutable.line = line.slice(0, this.tokenAt) + insert + line.slice(cursor);
		mutable.cursor = this.tokenAt + insert.length;
		this.close(); // wipes rows + redraws the line with the inserted path
	}

	/** Re-read the line after a forwarded key: re-filter, or close when the token is gone. */
	private syncFromLine(): void {
		const token = parseMentionToken(this.rl.line, this.rl.cursor);
		if (!token) {
			this.close();
			return;
		}
		this.tokenAt = token.at;
		this.query = token.query;
		this.recompute();
		this.render();
	}

	private recompute(): void {
		if (this.query !== this.lastQuery) {
			this.selected = 0;
			this.windowStart = 0;
			this.lastQuery = this.query;
		}
		this.matches = filterFiles(this.index.list(), this.query, 200);
	}

	/** Index streamed a batch — coalesce re-filters into one render per tick. */
	private scheduleProgressiveRender(): void {
		if (!this.active || this.renderPending) return;
		this.renderPending = true;
		setImmediate(() => {
			this.renderPending = false;
			if (!this.active) return;
			this.recompute();
			this.render();
		});
	}

	private maxVisible(): number {
		if (this.opts.maxRows) return this.opts.maxRows;
		const rows = this.output.rows || 24;
		return Math.max(3, Math.min(10, rows - 10));
	}

	// --- rendering (SlashPopup-compatible, bar-safe) ------------------------

	private render(): void {
		const out = this.output;
		const maxVisible = this.maxVisible();
		const visible = this.matches.slice(this.windowStart, this.windowStart + maxVisible);
		if (visible.length === 0 && this.shown === 0 && !this.index.walking) return;
		const rows =
			visible.length > 0
				? buildMentionRows(visible, this.selected - this.windowStart, {
						cols: out.columns || 80,
						indices: visible.map((m) => m.indices),
						walking: this.index.walking,
						total: this.matches.length,
						moreUp: this.windowStart > 0,
						moreDown: this.windowStart + visible.length < this.matches.length,
					})
				: [DIM + (this.index.walking ? "索引中…" : "无匹配文件") + RESET, DIM + "Esc 关闭 · 继续输入过滤" + RESET];
		const wipe = Math.max(this.shown, rows.length);
		if (wipe === 0) return;
		if (this.shown > 0) out.write(`\x1b[${this.shown}A`);
		for (let i = 0; i < wipe; i++) {
			out.write("\r\x1b[K");
			if (i < wipe - 1) out.write("\n");
		}
		if (wipe > 1) out.write(`\x1b[${wipe - 1}A`);
		for (const row of rows) out.write(row + "\x1b[K\n");
		this.redrawLine();
		this.shown = rows.length;
	}

	/** Rewrite prompt+buffer and place the cursor (readline's row). */
	private redrawLine(): void {
		const out = this.output;
		out.write(this.opts.prompt + this.rl.line);
		const back = this.rl.line.length - this.rl.cursor;
		if (back > 0) out.write(`\x1b[${back}D`);
	}

	/** Clear the rows above the prompt (SlashPopup.wipeAbove logic). */
	private wipeAbove(): void {
		if (this.shown === 0) return;
		const out = this.output;
		const up = this.shown;
		out.write(`\x1b[${up}A`);
		for (let i = 0; i < this.shown; i++) {
			out.write("\r\x1b[K");
			if (i < this.shown - 1) out.write("\n");
		}
		out.write("\n"); // land back on the prompt row
		this.shown = 0;
	}
}

// ---------------------------------------------------------------------------
// submit-time expansion: attach @file content to the user message
// ---------------------------------------------------------------------------

export interface AttachedFile {
	path: string;
	lines: number;
	/** True when content was clipped to maxBytes. */
	truncated: boolean;
}

export interface MentionExpansion {
	/** The line, plus one appended block per attachable @file. */
	text: string;
	attached: AttachedFile[];
}

export interface ReadFileResult {
	content: string;
	bytes: number;
}

/**
 * Expand "@path" tokens in a submitted line: existing readable text files
 * get their content appended as a reference block (codex attaches context
 * the same way — the model sees the file without a read round-trip).
 * Missing paths / binaries / oversize files are silently skipped: the token
 * text survives verbatim, so the model can still ask for it via tools.
 */
export function expandFileMentions(
	line: string,
	readFile: (path: string) => ReadFileResult | undefined,
	opts: { maxFileBytes?: number; maxFiles?: number } = {},
): MentionExpansion {
	const maxFileBytes = opts.maxFileBytes ?? 65_536;
	const maxFiles = opts.maxFiles ?? 8;
	const attached: Array<AttachedFile & { content: string }> = [];
	const seen = new Set<string>();
	const re = /@([A-Za-z0-9_.\-\\/]+)/g;
	for (const m of line.matchAll(re)) {
		const raw = m[1]!.replace(/\\/g, "/");
		if (seen.has(raw)) continue;
		const file = readFile(raw);
		if (!file) continue; // missing / oversize / unreadable — keep token text
		if (file.content.slice(0, 4096).includes("\0")) continue; // binary
		seen.add(raw);
		const truncated = file.bytes > maxFileBytes;
		const content = truncated ? file.content.slice(0, maxFileBytes) : file.content;
		attached.push({ path: raw, lines: content.split("\n").length, truncated, content });
		if (attached.length >= maxFiles) break;
	}
	if (attached.length === 0) return { text: line, attached };
	let suffix = "\n\n【@文件引用】以下内容来自用户消息中 @ 提及的文件，已自动附加：";
	for (const f of attached) {
		suffix += `\n────── ${f.path}（${f.lines} 行${f.truncated ? "，已截断" : ""}）──────\n${f.content.replace(/\s+$/, "")}`;
	}
	return { text: line + suffix, attached: attached.map(({ content: _content, ...rest }) => rest) };
}
