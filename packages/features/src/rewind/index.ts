/**
 * Rewind — Claude-Code-style double-ESC checkpoints.
 *
 * Every user prompt opens a checkpoint BEFORE its run starts:
 *
 *   - `messages`     snapshot of the agent transcript (the live context view)
 *   - `sessionCount` position in the append-only session log
 *   - `files`        copy-on-first-touch byte snapshots of every file the
 *                    run's write/edit tools modify (recorded by a
 *                    beforeToolCall hook, so the capture happens BEFORE the
 *                    tool executes — including the "file did not exist yet"
 *                    case, recorded as `absent`)
 *
 * Rewinding to checkpoint N restores the state "just before prompt N was
 * sent": the transcript truncates, and every file modified in runs N..latest
 * goes back to its earliest recorded pre-run content (for a file first
 * touched in run M ≥ N, its content just-before-M IS its content at N — it
 * was untouched in between). Selectively rewinding code only is therefore
 * exact, no full working-tree snapshot needed.
 *
 * Persistence (so a resumed session can still rewind):
 *
 *   .puck/checkpoints/<sessionId>/log.jsonl       one entry per checkpoint
 *   .puck/checkpoints/<sessionId>/snapshots/<serial>/<sha1(path)>.raw
 *
 * Limitations (by design, documented): only write/edit tool modifications
 * are tracked — files changed by the bash tool (or by hand) are not
 * rewindable; files larger than maxFileBytes are skipped with a warning.
 */

import type { Message } from "@puckguo123/core";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Recorded pre-modification state of one file within one run. */
interface FileRecord {
	/** Absolute path (native separators, as resolved at capture time). */
	path: string;
	/** Snapshot file path relative to the session dir (raw bytes). */
	snap?: string;
	/** The file did not exist before this run first touched it (restore = delete). */
	absent?: boolean;
	/** Not snapshottable (too big / unreadable / snapshot write failed) — restore skips it. */
	skipped?: boolean;
}

/** One checkpoint as persisted to log.jsonl. */
interface CheckpointEntry {
	type: "checkpoint";
	serial: number;
	at: number;
	userText: string;
	agentCount: number;
	sessionCount: number;
	files: FileRecord[];
}

/** A usable checkpoint (loaded or in-memory), with the transcript view. */
export interface Checkpoint {
	serial: number;
	at: number;
	/** The user prompt that opened this checkpoint (display text). */
	userText: string;
	/** Transcript length (agent view) before the run. */
	agentCount: number;
	/** Session-log message count before the run (rewind marker target). */
	sessionCount: number;
	messages: Message[];
	files: FileRecord[];
}

/** One code-restore operation computed by `restoreTo`. */
export interface FileOp {
	path: string;
	/** Raw bytes to write back (mutual exclusive with delete/skipped). */
	bytes?: Buffer;
	/** Delete the file — it did not exist at the target state. */
	delete?: boolean;
	/** Could not be restored (snapshot missing / too big when recorded). */
	skipped?: boolean;
}

export interface RewindStoreOptions {
	/** Skip snapshotting files larger than this (default 32 MiB). */
	maxFileBytes?: number;
	/** Keep at most this many checkpoints per session (default 50). */
	maxCheckpoints?: number;
}

export class RewindStore {
	private sessionId = "";
	private checkpoints: Checkpoint[] = [];
	private active: Checkpoint | undefined;
	/** Paths already recorded for the ACTIVE checkpoint (copy-on-first-touch). */
	private readonly seen = new Set<string>();
	private readonly maxFileBytes: number;
	private readonly maxCheckpoints: number;

	constructor(private readonly root: string, options: RewindStoreOptions = {}) {
		this.maxFileBytes = options.maxFileBytes ?? 32 * 1024 * 1024;
		this.maxCheckpoints = options.maxCheckpoints ?? 50;
	}

	/**
	 * Bind to a session: fresh sessions start empty, resumed sessions reload
	 * their persisted checkpoints. `messages` is the session's replayed
	 * transcript — used to rebuild each checkpoint's view (`sessionCount`
	 * prefix). Note the documented divergence: compaction is view-level and
	 * not in the log, so a checkpoint created mid-process after a /compact
	 * reloads with the fuller pre-compaction transcript.
	 */
	bind(sessionId: string, messages: Message[]): void {
		this.finish(); // close any dangling checkpoint of the previous session
		this.sessionId = sessionId;
		this.checkpoints = this.load(sessionId, messages);
	}

	/** Available checkpoints, oldest → newest. */
	list(): Checkpoint[] {
		return [...this.checkpoints];
	}

	/**
	 * Open the checkpoint for a new run: the state just before this prompt.
	 * `agentMessages` is copied (slice), so later transcript surgery
	 * (compaction, rewind, abort) cannot mutate the captured view.
	 */
	begin(userText: string, agentMessages: Message[], sessionCount: number): void {
		this.finish(); // a crashed run without finish() settles here
		const serial = (this.checkpoints[this.checkpoints.length - 1]?.serial ?? 0) + 1;
		this.active = {
			serial,
			at: Date.now(),
			userText,
			agentCount: agentMessages.length,
			sessionCount,
			messages: agentMessages.slice(),
			files: [],
		};
		this.seen.clear();
	}

	/**
	 * Record the pre-modification content of `path` (absolute) for the active
	 * checkpoint. First touch in the run wins — later modifications of the
	 * same file must not overwrite the original snapshot. No-op when no run
	 * is active. ENOENT records `absent` (restore deletes); any other read
	 * failure records `skipped` (never delete a file we could not read).
	 */
	captureFile(path: string): void {
		const cp = this.active;
		if (!cp || this.seen.has(path)) return;
		this.seen.add(path);

		let bytes: Buffer | undefined;
		try {
			const st = statSync(path);
			if (st.size > this.maxFileBytes) {
				cp.files.push({ path, skipped: true });
				return;
			}
			bytes = readFileSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				cp.files.push({ path, absent: true });
				return;
			}
			cp.files.push({ path, skipped: true }); // unreadable — do not guess
			return;
		}

		const snap = this.writeSnapshot(cp.serial, path, bytes);
		// snapshot write failed but bytes exist → cannot mark absent (would
		// delete a real file on restore): degrade to skipped
		cp.files.push(snap ? { path, snap } : { path, skipped: true });
	}

	/** Close the active checkpoint and persist it. Safe to call when idle. */
	finish(): void {
		const cp = this.active;
		this.active = undefined;
		if (!cp) return;
		this.checkpoints.push(cp);
		try {
			mkdirSync(this.sessionDir, { recursive: true });
			appendFileSync(this.logPath, JSON.stringify(this.toEntry(cp)) + "\n", "utf8");
		} catch {
			/* best-effort persistence — in-memory checkpoints still work */
		}
		this.enforceCap();
	}

	/**
	 * Compute the file operations that restore the working tree to the state
	 * just before checkpoint `serial`, prune the voided checkpoints (≥ serial:
	 * the timeline moved, redo is not supported — same as Claude Code) and
	 * return the ops for the host to apply (or inspect) via `applyFileOps`.
	 */
	restoreTo(serial: number): FileOp[] {
		// earliest record per path across all voided runs = its content at the target state
		const earliest = new Map<string, FileRecord>();
		for (const cp of this.checkpoints) {
			if (cp.serial < serial) continue;
			for (const f of cp.files) if (!earliest.has(f.path)) earliest.set(f.path, f);
		}
		const voided = this.checkpoints.filter((cp) => cp.serial >= serial);
		this.checkpoints = this.checkpoints.filter((cp) => cp.serial < serial);
		this.persist();

		// materialize the ops BEFORE dropping the voided snapshot dirs — the
		// restore bytes live in exactly those snapshots (older checkpoints' dirs
		// stay for further rewinds)
		const ops: FileOp[] = [];
		for (const [path, rec] of earliest) {
			if (rec.skipped) ops.push({ path, skipped: true });
			else if (rec.absent) ops.push({ path, delete: true });
			else if (rec.snap) {
				try {
					ops.push({ path, bytes: readFileSync(join(this.sessionDir, rec.snap)) });
				} catch {
					ops.push({ path, skipped: true });
				}
			}
		}
		for (const cp of voided) this.dropSnapshots(cp.serial);
		return ops;
	}

	// --- internals -----------------------------------------------------------

	private get sessionDir(): string {
		return join(this.root, this.sessionId.replace(/[^A-Za-z0-9._-]/g, "_"));
	}

	private get logPath(): string {
		return join(this.sessionDir, "log.jsonl");
	}

	private load(sessionId: string, messages: Message[]): Checkpoint[] {
		let raw: string;
		try {
			raw = readFileSync(join(this.root, sessionId.replace(/[^A-Za-z0-9._-]/g, "_"), "log.jsonl"), "utf8");
		} catch {
			return []; // fresh session (or unreadable) — starts clean
		}
		const out: Checkpoint[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as CheckpointEntry;
				if (entry?.type !== "checkpoint" || typeof entry.serial !== "number") continue;
				out.push({
					serial: entry.serial,
					at: entry.at ?? 0,
					userText: entry.userText ?? "",
					agentCount: entry.agentCount ?? entry.sessionCount ?? 0,
					sessionCount: entry.sessionCount ?? 0,
					messages: messages.slice(0, Math.max(0, entry.sessionCount ?? 0)),
					files: Array.isArray(entry.files) ? entry.files : [],
				});
			} catch {
				continue; // torn line — skip, keep the rest
			}
		}
		return out;
	}

	private toEntry(cp: Checkpoint): CheckpointEntry {
		return {
			type: "checkpoint",
			serial: cp.serial,
			at: cp.at,
			userText: cp.userText,
			agentCount: cp.agentCount,
			sessionCount: cp.sessionCount,
			files: cp.files,
		};
	}

	/** Rewrite the whole log (cap enforcement, prune after rewind). */
	private persist(): void {
		try {
			mkdirSync(this.sessionDir, { recursive: true });
			const body = this.checkpoints.map((cp) => JSON.stringify(this.toEntry(cp)));
			writeFileSync(this.logPath, body.length > 0 ? body.join("\n") + "\n" : "", "utf8");
		} catch {
			/* best-effort persistence */
		}
	}

	private enforceCap(): void {
		let dropped = false;
		while (this.checkpoints.length > this.maxCheckpoints) {
			this.dropSnapshots(this.checkpoints.shift()!.serial);
			dropped = true;
		}
		if (dropped) this.persist();
	}

	private writeSnapshot(serial: number, path: string, bytes: Buffer): string | undefined {
		try {
			const rel = join("snapshots", String(serial), createHash("sha1").update(path).digest("hex") + ".raw");
			const abs = join(this.sessionDir, rel);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, bytes);
			return rel;
		} catch {
			return undefined;
		}
	}

	private dropSnapshots(serial: number): void {
		try {
			rmSync(join(this.sessionDir, "snapshots", String(serial)), { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

/** Apply file operations from `restoreTo`. Returns what happened, for display. */
export function applyFileOps(ops: FileOp[]): { restored: string[]; deleted: string[]; skipped: string[] } {
	const restored: string[] = [];
	const deleted: string[] = [];
	const skipped: string[] = [];
	for (const op of ops) {
		try {
			if (op.skipped) {
				skipped.push(op.path);
				continue;
			}
			if (op.delete) {
				if (existsSync(op.path)) {
					rmSync(op.path);
					deleted.push(op.path);
				}
				continue;
			}
			if (!op.bytes) continue;
			mkdirSync(dirname(op.path), { recursive: true });
			writeFileSync(op.path, op.bytes);
			restored.push(op.path);
		} catch {
			skipped.push(op.path);
		}
	}
	return { restored, deleted, skipped };
}
