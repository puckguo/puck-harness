/**
 * puck conversation index — a single sqlite file in the system dir (~/.puck/index.db).
 *
 * The JSONL session logs in each project stay the source of truth (tail/grep
 * friendly, crash-tolerant). This index exists for what per-project files
 * cannot do: cross-project queries — "what did I do today", /recall search,
 * and feeding the daily summary task.
 *
 * Zero dependency: node:sqlite (DatabaseSync, Node >= 22.5). If the runtime
 * lacks it, open() returns null and every memory feature degrades gracefully.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionRow {
	id: string;
	title: string | null;
	model: string | null;
	project: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface MessageInsert {
	sessionId: string;
	ts: number;
	role: string; // user | assistant | tool
	content: string;
	tokens?: number;
	toolName?: string;
}

export interface SearchHit {
	sessionId: string;
	title: string | null;
	project: string | null;
	ts: number;
	role: string;
	snippet: string;
}

export interface DayConversation {
	id: string;
	title: string | null;
	project: string | null;
	model: string | null;
	messages: Array<{ ts: number; role: string; content: string }>;
}

interface DatabaseSyncLike {
	exec(sql: string): void;
	prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(
	id TEXT PRIMARY KEY,
	title TEXT,
	model TEXT,
	project TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages(
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL,
	ts INTEGER NOT NULL,
	role TEXT NOT NULL,
	content TEXT NOT NULL,
	tokens INTEGER,
	tool_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(ts);
`;

export class ConversationStore {
	private constructor(private readonly db: DatabaseSyncLike) {}

	/** Opens (creating if needed) the index. Returns null when node:sqlite is unavailable. */
	static async open(dbPath: string): Promise<ConversationStore | null> {
		let DatabaseSync: new (path: string) => DatabaseSyncLike;
		try {
			// silence the one-time experimental warning — it would clobber the CLI
			// banner. The warning is EMITTED asynchronously (nextTick after module
			// load), so the suppression window must span one macrotask boundary.
			const listeners = process.listeners("warning");
			process.removeAllListeners("warning");
			try {
				({ DatabaseSync } = (await import("node:sqlite")) as unknown as {
					DatabaseSync: new (path: string) => DatabaseSyncLike;
				});
				await new Promise((r) => setImmediate(r)); // let the queued warning drop
			} finally {
				for (const l of listeners) process.on("warning", l);
			}
		} catch {
			return null;
		}
		mkdirSync(dirname(dbPath), { recursive: true });
		const db = new DatabaseSync(dbPath);
		db.exec(SCHEMA);
		return new ConversationStore(db);
	}

	/** Insert or refresh a session row (safe to call before every message). */
	touchSession(id: string, patch: { title?: string; model?: string; project?: string }, now = Date.now()): void {
		const existing = this.db.prepare("SELECT id, title, model, project FROM sessions WHERE id = ?").get(id) as
			| { title: string | null; model: string | null; project: string | null }
			| undefined;
		const row = {
			title: patch.title ?? existing?.title ?? null,
			model: patch.model ?? existing?.model ?? null,
			project: patch.project ?? existing?.project ?? null,
		};
		this.db
			.prepare(
				`INSERT INTO sessions(id, title, model, project, created_at, updated_at) VALUES(?,?,?,?,?,?)
				 ON CONFLICT(id) DO UPDATE SET title=excluded.title, model=excluded.model, project=excluded.project, updated_at=excluded.updated_at`,
			)
			.run(id, row.title, row.model, row.project, existing ? Number((this.db.prepare("SELECT created_at FROM sessions WHERE id = ?").get(id) as { created_at: number }).created_at) : now, now);
	}

	record(msg: MessageInsert): void {
		this.db
			.prepare("INSERT INTO messages(session_id, ts, role, content, tokens, tool_name) VALUES(?,?,?,?,?,?)")
			.run(msg.sessionId, msg.ts, msg.role, msg.content, msg.tokens ?? null, msg.toolName ?? null);
		this.touchSession(msg.sessionId, {}, msg.ts);
	}

	/** Cross-project substring search (LIKE — zero-dep, no FTS dependency). */
	search(query: string, limit = 8): SearchHit[] {
		const like = `%${query.replace(/[%_]/g, (c) => "\\" + c)}%`;
		const rows = this.db
			.prepare(
				`SELECT m.session_id, m.ts, m.role, m.content, s.title, s.project
				 FROM messages m JOIN sessions s ON s.id = m.session_id
				 WHERE m.content LIKE ? ESCAPE '\\' AND m.role IN ('user','assistant')
				 ORDER BY m.ts DESC LIMIT ?`,
			)
			.all(like, limit * 3) as Array<{ session_id: string; ts: number; role: string; content: string; title: string | null; project: string | null }>;
		const hits: SearchHit[] = [];
		for (const r of rows) {
			if (hits.filter((h) => h.sessionId === r.session_id).length >= 2) continue; // ≤2 hits per session
			const at = r.content.indexOf(query);
			const start = Math.max(0, at - 40);
			hits.push({
				sessionId: r.session_id,
				title: r.title,
				project: r.project,
				ts: r.ts,
				role: r.role,
				snippet: (start > 0 ? "…" : "") + r.content.slice(start, start + 120).replace(/\s+/g, " ") + "…",
			});
			if (hits.length >= limit) break;
		}
		return hits;
	}

	/** The N user/assistant messages around a timestamp — context view for /recall. */
	contextAround(sessionId: string, ts: number, before = 4, after = 4): Array<{ ts: number; role: string; content: string }> {
		const rows = this.db
			.prepare("SELECT ts, role, content FROM messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY ts")
			.all(sessionId) as Array<{ ts: number; role: string; content: string }>;
		if (rows.length === 0) return [];
		let idx = rows.findIndex((r) => r.ts >= ts);
		if (idx < 0) idx = rows.length - 1;
		const from = Math.max(0, idx - before);
		const to = Math.min(rows.length, idx + after + 1);
		return rows.slice(from, to).map((r) => ({ ts: r.ts, role: r.role, content: r.content }));
	}

	/** All conversations that had activity on the given local date — daily-summary input. */
	dayConversations(dateStr: string, opts: { maxCharsPerMessage?: number; maxTotalChars?: number } = {}): DayConversation[] {
		const maxPer = opts.maxCharsPerMessage ?? 400;
		const maxTotal = opts.maxTotalChars ?? 24_000;
		const start = new Date(dateStr + "T00:00:00").getTime();
		const end = start + 86_400_000;
		const sessions = this.db
			.prepare("SELECT id, title, project, model FROM sessions WHERE updated_at >= ? AND updated_at < ? ORDER BY updated_at")
			.all(start, end) as Array<{ id: string; title: string | null; project: string | null; model: string | null }>;
		const out: DayConversation[] = [];
		let budget = maxTotal;
		for (const s of sessions) {
			const rows = this.db
				.prepare("SELECT ts, role, content FROM messages WHERE session_id = ? AND ts >= ? AND ts < ? AND role IN ('user','assistant') ORDER BY ts")
				.all(s.id, start, end) as Array<{ ts: number; role: string; content: string }>;
			if (rows.length === 0) continue;
			const messages = [];
			for (const r of rows) {
				const clipped = r.content.length > maxPer ? r.content.slice(0, maxPer) + "…" : r.content;
				budget -= clipped.length;
				if (budget <= 0) break;
				messages.push({ ts: r.ts, role: r.role, content: clipped });
			}
			if (messages.length > 0) out.push({ id: s.id, title: s.title, project: s.project, model: s.model, messages });
			if (budget <= 0) break;
		}
		return out;
	}

	close(): void {
		try {
			(this.db as unknown as { close(): void }).close();
		} catch {
			/* ignore */
		}
	}
}
