/**
 * puck sessions — append-only JSONL transcripts, inspired by dsh's
 * "the log is the source of truth" principle.
 *
 * A session file is a header line followed by one JSON object per message:
 *
 *   {"type":"header","id":"...","createdAt":...,"model":"..."}
 *   {"type":"message","seq":1,"message":{...}}
 *   {"type":"message","seq":2,"message":{...}}
 *
 * Simple to tail, grep, diff, and replay. Corrupt trailing lines (crashes
 * mid-write) are skipped on load.
 */

import type { Message } from "@puckguo123/core";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface HeaderEntry {
	type: "header";
	id: string;
	createdAt: number;
	model?: string;
	systemPrompt?: string;
	/** Working directory the session was started in. Recorded on creation so
	 * /resume can filter by cwd without re-deriving it. */
	cwd?: string;
}

interface MessageEntry {
	type: "message";
	seq: number;
	message: Message;
}

/** History of context compactions — powers "compact ×N" in /resume. */
interface CompactionEntry {
	type: "compaction";
	seq: number;
	at: number;
	/** Tokens/messages folded into the summary, for future dashboards. */
	prefixMessages?: number;
}

/**
 * Marker written by `/clear` so the picker knows the session is no longer
 * live — the user moved on to a fresh session but the transcript is kept on
 * disk (see docs/usage.md §/clear). Powers the "已清空" tag in /resume.
 */
interface ClearedEntry {
	type: "cleared";
	seq: number;
	at: number;
}

type Entry = HeaderEntry | MessageEntry | CompactionEntry | ClearedEntry;

/** Session summary for pickers (computed by scanning the log; no index file). */
export interface SessionStats {
	id: string;
	/** First user message, single-lined and clipped — serves as the title. */
	title: string;
	createdAt: number;
	updatedAt: number;
	/** User messages = conversation turns (matches the REPL "本轮" notion). */
	turns: number;
	assistantMessages: number;
	toolCalls: number;
	compactions: number;
	/**
	 * True if a `cleared` entry was appended by `/clear` — the transcript is
	 * kept on disk but the live context was reset. The /resume picker tints
	 * these so the user sees them without mistaking them for live sessions.
	 */
	cleared: boolean;
	/** Timestamp of the latest `cleared` entry, if any. */
	clearedAt?: number;
	/** Working directory the session was started in, if known (header `cwd`). */
	cwd?: string;
	model?: string;
}

export class Session {
	readonly id: string;
	readonly path: string;
	readonly createdAt: number;
	model: string | undefined;
	systemPrompt: string | undefined;
	/** Working directory the session was started in (header `cwd`). */
	cwd: string | undefined;

	private entries: Message[] = [];
	private nextSeq = 1;
	/** Compaction entries seen on load; live ones counted separately. */
	private loadedCompactions = 0;
	private liveCompactions = 0;
	/** Timestamp of the latest `cleared` entry from disk (0 = none seen). */
	private loadedClearedAt = 0;
	/** Timestamp of a `cleared` entry written this process (unflushed-to-disk counts). */
	private liveClearedAt = 0;

	private constructor(header: { id: string; path: string; createdAt: number; model?: string; systemPrompt?: string; cwd?: string }) {
		this.id = header.id;
		this.path = header.path;
		this.createdAt = header.createdAt;
		this.model = header.model;
		this.systemPrompt = header.systemPrompt;
		this.cwd = header.cwd;
	}

	/** Create a new session file inside a directory. */
	static create(dir: string, options: { id?: string; model?: string; systemPrompt?: string; cwd?: string } = {}): Session {
		mkdirSync(dir, { recursive: true });
		const id = options.id ?? randomUUID();
		const path = join(dir, `${id}.jsonl`);
		const session = new Session({ id, path, createdAt: Date.now(), model: options.model, systemPrompt: options.systemPrompt, cwd: options.cwd });
		session.flushHeader();
		return session;
	}

	/** Load (replay) an existing session file. The in-memory list mirrors the log. */
	static load(path: string): Session {
		const raw = readFileSync(path, "utf8");
		let header: HeaderEntry | undefined;
		const messages: Message[] = [];
		let nextSeq = 1;
		let compactions = 0;
		let clearedAt = 0;

		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let entry: Entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue; // tolerate a torn trailing line
			}
			if (entry.type === "header" && !header) {
				header = entry;
			} else if (entry.type === "message") {
				messages.push(entry.message);
				nextSeq = Math.max(nextSeq, entry.seq + 1);
			} else if (entry.type === "compaction") {
				compactions++;
				nextSeq = Math.max(nextSeq, entry.seq + 1);
			} else if (entry.type === "cleared") {
				clearedAt = Math.max(clearedAt, entry.at);
				nextSeq = Math.max(nextSeq, entry.seq + 1);
			}
		}

		if (!header) throw new Error(`Not a puck session file (missing header): ${path}`);
		const session = new Session({
			id: header.id,
			path,
			createdAt: header.createdAt,
			model: header.model,
			systemPrompt: header.systemPrompt,
			cwd: header.cwd,
		});
		session.entries = messages;
		session.nextSeq = nextSeq;
		session.loadedCompactions = compactions;
		session.loadedClearedAt = clearedAt;
		return session;
	}

	/** All messages in order. */
	get messages(): Message[] {
		return this.entries;
	}

	/** Total compactions recorded in this session's log (loaded + live). */
	get compactionCount(): number {
		return this.loadedCompactions + this.liveCompactions;
	}

	/** Latest `cleared` marker seen for this session (0 = none). */
	get clearedAt(): number {
		return Math.max(this.loadedClearedAt, this.liveClearedAt);
	}

	/** True if `/clear` was invoked on this session. */
	get cleared(): boolean {
		return this.clearedAt > 0;
	}

	/** Record that a context compaction folded the prefix into a summary. */
	recordCompaction(prefixMessages?: number): void {
		const entry: CompactionEntry = { type: "compaction", seq: this.nextSeq++, at: Date.now(), prefixMessages };
		this.liveCompactions++;
		appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
	}

	/**
	 * Record that `/clear` was invoked on this session. The transcript stays on
	 * disk so the user can recover it via /resume, but the picker tints it so
	 * the user sees it is no longer the live context. Multiple clears within
	 * the same session keep the latest timestamp (oldest is uninteresting).
	 */
	recordCleared(): void {
		const at = Date.now();
		const entry: ClearedEntry = { type: "cleared", seq: this.nextSeq++, at };
		this.liveClearedAt = Math.max(this.liveClearedAt, at);
		appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
	}

	/** Append a message to the log (flushed immediately). */
	append(message: Message): void {
		const entry: MessageEntry = { type: "message", seq: this.nextSeq++, message };
		this.entries.push(message);
		appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
	}

	/**
	 * Fork: create a new session whose log starts as a full copy of this one
	 * (same header metadata; the id differs).
	 */
	fork(dir: string, options: { id?: string; model?: string; cwd?: string } = {}): Session {
		const forked = Session.create(dir, {
			id: options.id,
			model: options.model ?? this.model,
			systemPrompt: this.systemPrompt,
			cwd: options.cwd ?? this.cwd,
		});
		for (const message of this.entries) forked.append(message);
		return forked;
	}

	private flushHeader(): void {
		const header: HeaderEntry = {
			type: "header",
			id: this.id,
			createdAt: this.createdAt,
			model: this.model,
			systemPrompt: this.systemPrompt,
			cwd: this.cwd,
		};
		writeFileSync(this.path, `${JSON.stringify(header)}\n`, "utf8");
	}
}

/** Directory of session files. */
export class SessionStore {
	constructor(readonly dir: string) {
		mkdirSync(dir, { recursive: true });
	}

	/**
	 * Working directory this store is scoped to, for the canonical
	 * `<cwd>/.puck/sessions` layout the CLI and web server use (project root =
	 * two levels up from the sessions dir). Used as a fallback for legacy
	 * session files written before headers carried `cwd` — they are otherwise
	 * invisible to cwd-scoped pickers like /resume, even though they live in
	 * this project's store. Derived from the store location, never written
	 * back to the files. Returns undefined for non-standard store depths (the
	 * caller then treats the session's scope as unknown, as before).
	 */
	get projectCwd(): string | undefined {
		try {
			return dirname(dirname(resolve(this.dir)));
		} catch {
			return undefined;
		}
	}

	create(options: { id?: string; model?: string; systemPrompt?: string; cwd?: string } = {}): Session {
		return Session.create(this.dir, options);
	}

	load(id: string): Session {
		return Session.load(join(this.dir, `${id}.jsonl`));
	}

	/** List session ids (files that parse with a header). */
	list(): string[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => name.slice(0, -6))
			.sort();
	}

	/**
	 * Summarize every session for pickers — scans each log once:
	 * title (first user message), turns (user messages), compactions, model,
	 * and recency (file mtime; the last message timestamp when parseable).
	 */
	statsAll(): SessionStats[] {
		const stats: SessionStats[] = [];
		for (const id of this.list()) {
			let s: SessionStats;
			try {
				s = scanStats(join(this.dir, `${id}.jsonl`));
			} catch {
				continue; // unreadable/torn file — skip, never break the picker
			}
			stats.push(s);
		}
		return stats.sort((a, b) => b.updatedAt - a.updatedAt); // most recent first
	}
}

function scanStats(path: string): SessionStats {
	const raw = readFileSync(path, "utf8");
	const lines = raw.split("\n");
	let id = "";
	let createdAt = 0;
	let updatedAt = 0;
	let model: string | undefined;
	let cwd: string | undefined;
	let title = "(空会话)";
	let turns = 0;
	let assistantMessages = 0;
	let toolCalls = 0;
	let compactions = 0;
	let clearedAt = 0;
	let lastAt = 0;

	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: Entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "header") {
			id = entry.id;
			createdAt = entry.createdAt;
			model = entry.model;
			cwd = entry.cwd;
			lastAt = entry.createdAt;
		} else if (entry.type === "message") {
			const m = entry.message;
			lastAt = m.timestamp ?? lastAt;
			if (m.role === "user") {
				turns++;
				const text = typeof m.content === "string" ? m.content : "";
				if (title === "(空会话)" && text.trim() && !text.startsWith("[Context compaction]")) {
					title = text.replace(/\s+/g, " ").trim().slice(0, 40);
				}
			} else if (m.role === "assistant") {
				assistantMessages++;
				toolCalls += m.content.filter((c) => c.type === "toolCall").length;
			}
		} else if (entry.type === "compaction") {
			compactions++;
			lastAt = entry.at;
		} else if (entry.type === "cleared") {
			clearedAt = Math.max(clearedAt, entry.at);
			lastAt = entry.at;
		}
	}
	updatedAt = lastAt || statMtime(path);
	return { id, title, createdAt, updatedAt, turns, assistantMessages, toolCalls, compactions, cleared: clearedAt > 0, clearedAt: clearedAt > 0 ? clearedAt : undefined, model, cwd };
}

function statMtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
