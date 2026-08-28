/**
 * Session persistence tests.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Session, SessionStore, scanForeignSessions } from "@puckguo123/session";

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "puck-session-"));
}

test("session: create, append, load roundtrip", () => {
	const dir = makeTmpDir();
	try {
		const session = Session.create(dir, { id: "s1", model: "test-model", systemPrompt: "be brief" });
		session.append({ role: "user", content: "hello", timestamp: 1 });
		session.append({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model: "test-model",
			stopReason: "stop",
			usage: { input: 1, output: 1, totalTokens: 2 },
			timestamp: 2,
		});

		assert.ok(existsSync(join(dir, "s1.jsonl")));

		const loaded = Session.load(join(dir, "s1.jsonl"));
		assert.equal(loaded.id, "s1");
		assert.equal(loaded.model, "test-model");
		assert.equal(loaded.messages.length, 2);
		assert.equal(loaded.messages[0].role, "user");

		// continue appending after reload
		loaded.append({ role: "user", content: "again", timestamp: 3 });
		const reloaded = Session.load(join(dir, "s1.jsonl"));
		assert.equal(reloaded.messages.length, 3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session: torn trailing line is tolerated", () => {
	const dir = makeTmpDir();
	try {
		const session = Session.create(dir, { id: "s2" });
		session.append({ role: "user", content: "x", timestamp: 1 });
		// simulate a crash mid-write
		appendFileSync(join(dir, "s2.jsonl"), '{"type":"message","seq":2,"mess', "utf8");

		const loaded = Session.load(join(dir, "s2.jsonl"));
		assert.equal(loaded.messages.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session: fork copies history", () => {
	const dir = makeTmpDir();
	try {
		const original = Session.create(dir, { id: "a" });
		original.append({ role: "user", content: "hello", timestamp: 1 });

		const forked = original.fork(dir, { id: "b" });
		assert.equal(forked.id, "b");
		assert.equal(forked.messages.length, 1);

		original.append({ role: "user", content: "more", timestamp: 2 });
		assert.equal(forked.messages.length, 1); // fork is independent
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("store: list and load by id", () => {
	const dir = makeTmpDir();
	try {
		const store = new SessionStore(dir);
		store.create({ id: "x" });
		store.create({ id: "y" });
		assert.deepEqual(store.list(), ["x", "y"]);

		const loaded = store.load("x");
		assert.equal(loaded.id, "x");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session: compaction entries survive roundtrip + statsAll summarizes", () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-session-stats-"));
	try {
		const store = new SessionStore(dir);
		const s = store.create({ id: "stats-1", model: "MiniMax-M3" });
		s.append({ role: "user", content: "帮我修复登录超时的 bug", timestamp: Date.now() - 7200_000 });
		s.append({ role: "assistant", content: [{ type: "text", text: "ok" }], model: "MiniMax-M3", stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 }, timestamp: Date.now() - 7100_000 });
		s.recordCompaction(2);
		s.recordCompaction(4);
		assert.equal(s.compactionCount, 2);

		const stats = store.statsAll();
		assert.equal(stats.length, 1);
		assert.equal(stats[0].id, "stats-1");
		assert.equal(stats[0].title, "帮我修复登录超时的 bug");
		assert.equal(stats[0].turns, 1);
		assert.equal(stats[0].assistantMessages, 1);
		assert.equal(stats[0].compactions, 2);
		assert.equal(stats[0].model, "MiniMax-M3");

		// reload keeps the count (log is the source of truth)
		const reloaded = store.load("stats-1");
		assert.equal(reloaded.compactionCount, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session: cwd is recorded on create + surfaced via statsAll + forked sessions inherit it", () => {
	// /resume filters the picker by current cwd; cwd must survive create,
	// load, and fork so cross-project filtering stays accurate.
	const dir = makeTmpDir();
	try {
		const session = Session.create(dir, { id: "cwd-1", model: "MiniMax-M3", cwd: "C:\\projects\\demo" });
		assert.equal(session.cwd, "C:\\projects\\demo");

		const loaded = Session.load(join(dir, "cwd-1.jsonl"));
		assert.equal(loaded.cwd, "C:\\projects\\demo");

		const stats = new SessionStore(dir).statsAll();
		assert.equal(stats.length, 1);
		assert.equal(stats[0].cwd, "C:\\projects\\demo");

		// fork keeps cwd by default (same project)
		const forked = loaded.fork(dir, { id: "cwd-1-fork" });
		assert.equal(forked.cwd, "C:\\projects\\demo");

		// fork can override cwd (project migration scenario)
		const migrated = loaded.fork(dir, { id: "cwd-1-moved", cwd: "D:\\new\\location" });
		assert.equal(migrated.cwd, "D:\\new\\location");

		// Session.create without cwd is still allowed (back-compat)
		const legacy = Session.create(dir, { id: "cwd-legacy" });
		assert.equal(legacy.cwd, undefined);
		const legacyStats = new SessionStore(dir).statsAll().find((s) => s.id === "cwd-legacy");
		assert.equal(legacyStats?.cwd, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Regression for the bug where /resume could not find puck's own history:
// files written before headers carried `cwd` were treated as "unknown cwd"
// and hidden by /resume's cwd filter, while external (pi/claude/codex)
// sessions stayed visible. The CLI derives the missing cwd from the store
// location (`<cwd>/.puck/sessions` → projectCwd) instead of hiding them.
test("session: store.projectCwd derives the project dir for legacy headerless-cwd files", () => {
	const project = makeTmpDir();
	try {
		// canonical layout: sessions live two levels under the project root
		const sessionsDir = join(project, ".puck", "sessions");
		const store = new SessionStore(sessionsDir);
		assert.equal(store.projectCwd, resolve(project));

		// relative store dir (how the CLI opens it: ".puck/sessions") resolves
		// against process.cwd() and still lands two levels up
		const relative = new SessionStore(join(".", ".puck", "sessions"));
		assert.equal(relative.projectCwd, resolve(process.cwd()));

		// a legacy file (no header cwd) is still listed by statsAll with
		// undefined cwd — the caller decides to fall back to projectCwd
		Session.create(sessionsDir, { id: "legacy-no-cwd" });
		const stats = store.statsAll().find((s) => s.id === "legacy-no-cwd");
		assert.equal(stats?.cwd, undefined);
		assert.equal(stats?.cwd ?? store.projectCwd, resolve(project));
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

// Regression for the /resume bug this change fixes: the picker scanned only
// the current project's .puck/sessions plus external harness stores
// (~/.claude · ~/.pi · ~/.codex), so a folder with no puck sessions showed
// ONLY pi/codex/claude history — puck's own other-folder sessions were
// invisible. scanForeignSessions turns global-index rows into verified
// filesystem hits so the "all directories" view includes them.
test("session: scanForeignSessions finds other projects' puck sessions for /resume", () => {
	const projectA = makeTmpDir();
	const projectB = makeTmpDir();
	const here = makeTmpDir();
	try {
		const mk = (project: string, id: string, question: string): void => {
			const s = Session.create(join(project, ".puck", "sessions"), { id, cwd: project });
			s.append({ role: "user", content: question, timestamp: Date.now() });
		};
		mk(projectA, "aaa", "怎么配置 vite 别名");
		mk(projectB, "bbb", "修一下 CI 的缓存");
		mk(here, "local", "当前项目的问题"); // current project — covered by its own store

		const hits = scanForeignSessions(
			[
				{ id: "aaa", project: projectA },
			{ id: "bbb", project: projectB },
				{ id: "local", project: here }, // cwd row → skipped
				{ id: "gone", project: projectA }, // file missing → skipped
				{ id: "bad", project: "" }, // no project → skipped
			],
			here,
		);
		assert.equal(hits.length, 2);
		assert.deepEqual(hits.map((h) => h.stats.id).sort(), ["aaa", "bbb"]);

		const a = hits.find((h) => h.stats.id === "aaa")!;
		assert.equal(a.path, join(resolve(projectA), ".puck", "sessions", "aaa.jsonl"));
		assert.equal(a.stats.turns, 1);
		assert.equal(a.stats.title, "怎么配置 vite 别名");
		// header cwd round-trips — the picker uses it for the cwd tag + scope
		assert.equal(a.stats.cwd, resolve(projectA));

		// cwd matching is slash/case-insensitive (Windows drive casing): a row
		// pointing back at the current project is never a foreign hit
		assert.equal(scanForeignSessions([{ id: "local", project: here.toUpperCase() }], here).length, 0);
	} finally {
		rmSync(projectA, { recursive: true, force: true });
		rmSync(projectB, { recursive: true, force: true });
		rmSync(here, { recursive: true, force: true });
	}
});

test("session: /clear markers survive roundtrip + statsAll reports cleared", () => {
	// /clear keeps the transcript on disk so /resume can recover it; the
	// session must remember it was cleared so the picker can tint it yellow.
	// Also: recency should still bump past the cleared marker, otherwise a
	// cleared session stays pinned at the top of /resume forever.
	const dir = makeTmpDir();
	try {
		const store = new SessionStore(dir);
		const s = store.create({ id: "cleared-1", model: "MiniMax-M3" });
		s.append({ role: "user", content: "怎么把 vite 项目跑起来", timestamp: Date.now() - 7200_000 });
		s.append({ role: "assistant", content: [{ type: "text", text: "ok" }], model: "MiniMax-M3", stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 }, timestamp: Date.now() - 7100_000 });
		assert.equal(s.cleared, false);
		assert.equal(s.clearedAt, 0);

		// /clear the session
		s.recordCleared();
		assert.equal(s.cleared, true);
		assert.ok(s.clearedAt > 0);

		// statsAll surfaces the cleared flag and the timestamp
		const stats = store.statsAll();
		assert.equal(stats.length, 1);
		assert.equal(stats[0].id, "cleared-1");
		assert.equal(stats[0].cleared, true);
		assert.equal(stats[0].clearedAt, s.clearedAt);
		assert.equal(stats[0].title, "怎么把 vite 项目跑起来");

		// reload — marker must persist (log is the source of truth)
		const reloaded = store.load("cleared-1");
		assert.equal(reloaded.cleared, true);
		assert.equal(reloaded.clearedAt, s.clearedAt);

		// multiple /clear calls keep the LATEST timestamp — a fresh cleared
		// session should rank above an older cleared one in /resume order
		const dir2 = makeTmpDir();
		const store2 = new SessionStore(dir2);
		const older = store2.create({ id: "older" });
		older.append({ role: "user", content: "older question", timestamp: 1000 });
		older.recordCleared();
		const newer = store2.create({ id: "newer" });
		newer.append({ role: "user", content: "newer question", timestamp: 2000 });
		newer.recordCleared();
		assert.ok(newer.clearedAt > older.clearedAt);
		rmSync(dir2, { recursive: true, force: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
