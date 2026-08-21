/**
 * errorlog — crash/error persistence for the puck CLI.
 *
 * Every error the CLI can observe lands in `<cwd>/.puck/error.log` (next to
 * `.puck/sessions/`): process crashes (uncaughtException / unhandledRejection),
 * agent run failures, API turn errors and failed tool calls — including the
 * exact (possibly malformed) model args behind them.
 *
 * Format: one JSON line per entry, greppable and machine-parseable:
 *
 *   {"t":"…","kind":"uncaught","message":"…","stack":"…","cwd":"…","context":{…}}
 *
 * Rotation: past `maxBytes` (512 KB by default) the file is renamed to
 * `error.log.1` (previous backup dropped), so the log can never grow
 * unbounded. The logger itself must NEVER throw — it runs on the crash path,
 * where the only thing left to do is write the file.
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Cap per field (message/stack/context values) — one entry must not dominate the file. */
const MAX_FIELD = 4000;
const DEFAULT_MAX_BYTES = 512 * 1024;

export interface LogErrorOptions {
	/** Directory holding `.puck/` — defaults to `process.cwd()`. */
	dir?: string;
	/** Rotate the log past this size — injectable for tests. */
	maxBytes?: number;
}

/** Path of the error log (public so the crash banner can print it). */
export function errorLogPath(dir: string = process.cwd()): string {
	return join(dir, ".puck", "error.log");
}

const clip = (s: string, max: number = MAX_FIELD): string => (s.length > max ? s.slice(0, max - 1) + "…" : s);

/** Serialize any value into something JSON-safe and size-capped. */
function safeValue(value: unknown): unknown {
	if (typeof value === "string") return clip(value);
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	try {
		const json = JSON.stringify(value);
		return json === undefined ? String(value) : clip(json);
	} catch {
		// circular reference — degrade to a lossy but informative summary
		if (typeof value === "object" && value !== null) {
			const keys = Object.keys(value as object);
			return clip(`[circular object: ${keys.slice(0, 10).join(", ")}]`);
		}
		return String(value); // BigInt and other exotics
	}
}

/** Human message from any thrown value — objects get stringified, not "[object Object]". */
function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return clip(error);
	try {
		const json = JSON.stringify(error);
		if (json !== undefined) return clip(json);
	} catch {
		/* fall through to String() */
	}
	return String(error);
}

/** Rename `file` → `file.1`, tolerating an existing backup (Windows rename). */
function rotate(file: string): void {
	const backup = file + ".1";
	try {
		renameSync(file, backup);
		return;
	} catch {
		/* backup exists or file vanished — retry once without the old backup */
	}
	try {
		rmSync(backup, { force: true });
		renameSync(file, backup);
	} catch {
		/* give up — keep appending to the live log */
	}
}

/** Append one error entry. Synchronous by design: uncaughtException must flush before exit. */
export function logError(kind: string, error: unknown, context?: Record<string, unknown>, options: LogErrorOptions = {}): void {
	const entry: Record<string, unknown> = {
		t: new Date().toISOString(),
		kind,
		message: messageOf(error),
		stack: error instanceof Error && typeof error.stack === "string" ? clip(error.stack) : undefined,
		cwd: process.cwd(),
	};
	if (context !== undefined) {
		const ctx: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(context)) ctx[k] = safeValue(v);
		entry.context = ctx;
	}
	let line: string;
	try {
		line = JSON.stringify(entry);
	} catch {
		// safeValue makes entries serializable; belt and braces if something slipped through
		line = JSON.stringify({ t: entry.t, kind, message: clip(String(entry.message)), cwd: entry.cwd });
	}
	const file = errorLogPath(options.dir);
	try {
		mkdirSync(dirname(file), { recursive: true });
		try {
			if (statSync(file).size > (options.maxBytes ?? DEFAULT_MAX_BYTES)) rotate(file);
		} catch {
			/* no file yet (or size check raced) — nothing to rotate */
		}
		appendFileSync(file, line + "\n", "utf8");
	} catch {
		// The logger must not crash the crash path — stderr is the last resort.
		try {
			process.stderr.write(`puck: 无法写入 ${file}：${line}\n`);
		} catch {
			/* even stderr failed — nothing left to do */
		}
	}
}
