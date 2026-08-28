/**
 * Global session registry — ~/.puck/sessions.json
 *
 * puck stores each project's sessions in that project's `.puck/sessions/`,
 * so unlike pi/codex/claude (central home-dir stores) there is no single
 * place to enumerate them from. This registry is that place: a tiny map of
 * every session file's ABSOLUTE path, written by the session layer itself
 * (Session.create / Session.load), read by /resume's cross-project scan.
 *
 * Design rules:
 *   - The per-project JSONL logs stay the source of truth; the registry is
 *     a pure accelerator. Every entry is verified against the filesystem
 *     before use (missing files are skipped, and pruned on write).
 *   - Never throws: any failure (read-only home, torn file, full disk) just
 *     means cross-project discovery degrades — session I/O must not break.
 *   - Atomic writes (tmp + rename) so concurrent puck processes can't tear
 *     it; lost-update races cost one stale entry until the session is
 *     touched again. The sqlite index (~/.puck/index.db) remains a
 *     secondary source, so nothing is ever solely registry-dependent.
 *   - Opt-out: PUCK_SESSION_REGISTRY=0 disables writes entirely; PUCK_HOME
 *     relocates ~/.puck (same knob as the rest of puck, see llm/auth.ts).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface SessionRegistryEntry {
	id: string;
	/** Absolute path of the session file (`<project>/.puck/sessions/<id>.jsonl`). */
	path: string;
	/** Working dir the session was started in (header `cwd`), when known. */
	cwd?: string;
	updatedAt: number;
}

/** Registry size cap — bounds growth from short-lived/test sessions. */
const MAX_ENTRIES = 2000;

/**
 * Registry file location, resolved lazily per call (tests override PUCK_HOME
 * after import). Returns "" when the registry is disabled — callers treat
 * that as "no registry".
 */
export function registryFile(): string {
	if (process.env.PUCK_SESSION_REGISTRY === "0") return "";
	const home = process.env.PUCK_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? ".";
	return join(home, ".puck", "sessions.json");
}

/** Read all entries (missing / corrupt / disabled → empty). Never throws. */
export function readSessionRegistry(file: string = registryFile()): SessionRegistryEntry[] {
	if (!file) return [];
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { sessions?: SessionRegistryEntry[] };
		if (!Array.isArray(parsed.sessions)) return [];
		return parsed.sessions.filter((e): e is SessionRegistryEntry => typeof e?.id === "string" && typeof e?.path === "string");
	} catch {
		return [];
	}
}

/**
 * Upsert one session file and persist: dedupe by path, drop entries whose
 * file no longer exists (self-healing against deleted projects / tmp dirs),
 * keep the newest MAX_ENTRIES. Registering a path that doesn't exist just
 * prunes — a dead entry must never survive any write. Never throws.
 */
export function registerSessionFile(path: string, id: string, cwd?: string): void {
	const file = registryFile();
	if (!file) return;
	try {
		const abs = resolve(path);
		const kept = readSessionRegistry(file).filter((e) => e.path !== abs && existsSync(e.path));
		// a path that doesn't exist on disk prunes instead of registering —
		// dead entries must never survive any write
		const sessions = existsSync(abs) ? [...kept, { id, path: abs, ...(cwd ? { cwd } : {}), updatedAt: Date.now() } as SessionRegistryEntry] : kept;
		const ordered = sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES);
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ version: 1, sessions: ordered }, null, "\t"), "utf8");
		renameSync(tmp, file);
	} catch {
		/* registry is an accelerator — never break the session layer */
	}
}
