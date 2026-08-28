/**
 * Memory system tests: sqlite conversation index, agent.md context loading,
 * task catalog, daily summary + experience distillation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantStream, StreamFn } from "@puckguo123/core";
import { ConversationStore } from "@puckguo123/store";
import { loadAgentContext, clipExperience, clipLongTerm, TaskCatalog, IdleTaskScheduler, runDailySummary, runLongTermDistill, redact, memoryStats, localDateStr, longTermPath } from "@puckguo123/memory";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "puck-memory-"));
}

/** Minimal fixed-text stream function (no network). Iterable-only (no .result()). */
function fakeStream(texts: string[]): StreamFn {
	let call = 0;
	const gen = async function* () {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: texts[Math.min(call++, texts.length - 1)] ?? "" }],
			model: "fake",
			stopReason: "stop",
			usage: { input: 1, output: 1, totalTokens: 2 },
			timestamp: Date.now(),
		};
		yield { type: "start", partial: message };
		yield { type: "done", message };
	};
	return gen as unknown as StreamFn;
}

// ---------------------------------------------------------------- store ----

test("store: open, record, search roundtrip", async () => {
	const dir = tmp();
	const store = await ConversationStore.open(join(dir, "index.db"));
	assert.ok(store, "sqlite available in this runtime");
	try {
		store.touchSession("s1", { title: "修 HTTP/2 bug", project: "/repo/a", model: "m" });
		store.record({ sessionId: "s1", ts: Date.now(), role: "user", content: "多路复用为什么丢包" });
		store.record({ sessionId: "s1", ts: Date.now(), role: "assistant", content: "因为流优先级……", tokens: 5 });
		const hits = store.search("多路复用");
		assert.equal(hits.length, 1);
		assert.equal(hits[0].sessionId, "s1");
		assert.equal(hits[0].role, "user");
		assert.ok(hits[0].snippet.includes("多路复用"));
		assert.equal(store.search("不存在的词").length, 0);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("store: allSessions lists cross-project rows for /resume's foreign scan", async () => {
	// Regression for the /resume bug: a folder with no puck sessions showed
	// only pi/codex/claude history. The fix feeds index rows to
	// scanForeignSessions; allSessions is the row source and must expose
	// id+project for every session, newest first, with null projects dropped
	// by the caller (rows here keep them; the CLI filters).
	const dir = tmp();
	const store = await ConversationStore.open(join(dir, "index.db"));
	assert.ok(store);
	try {
		const base = Date.now();
		store.touchSession("proj-a-1", { title: "a1", project: "/repo/a" }, base);
		store.touchSession("proj-b-1", { title: "b1", project: "/repo/b" }, base + 1000);
		store.touchSession("no-project", { title: "legacy" }, base + 2000); // pre-project rows exist
		const rows = store.allSessions();
		assert.equal(rows.length, 3);
		// ordered most-recent first
		assert.equal(rows[0].id, "no-project");
		assert.equal(rows[1].id, "proj-b-1");
		assert.equal(rows[2].id, "proj-a-1");
		// camelCase mapping + verbatim project strings (paths must round-trip)
		assert.equal(rows[1].project, "/repo/b");
		assert.equal(rows[1].title, "b1");
		assert.equal(typeof rows[1].updatedAt, "number");
		assert.equal(rows[0].project, null);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("store: contextAround returns neighbors and clamps at edges", async () => {
	const dir = tmp();
	const store = await ConversationStore.open(join(dir, "index.db"));
	assert.ok(store);
	try {
		const base = Date.now();
		store.touchSession("s1", { project: "/repo/a" });
		for (let i = 0; i < 10; i++) {
			store.record({ sessionId: "s1", ts: base + i * 1000, role: i % 2 === 0 ? "user" : "assistant", content: `msg${i}` });
		}
		// middle: 4 before + hit + 4 after
		const mid = store.contextAround("s1", base + 5000);
		assert.equal(mid.length, 9);
		assert.equal(mid[4].content, "msg5");
		assert.ok(mid[0].content === "msg1");
		// near start clamps
		const head = store.contextAround("s1", base);
		assert.equal(head.length, 5); // msgs 0..4
		assert.equal(head[0].content, "msg0");
		// unknown session → empty
		assert.deepEqual(store.contextAround("nope", base), []);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("store: dayConversations scopes by local date and caps", async () => {
	const dir = tmp();
	const store = await ConversationStore.open(join(dir, "index.db"));
	assert.ok(store);
	try {
		const today = localDateStr();
		const noon = new Date(today + "T12:00:00").getTime();
		store.touchSession("today", { project: "/repo/a" });
		store.record({ sessionId: "today", ts: noon, role: "user", content: "今天的问题" });
		store.touchSession("old", { project: "/repo/a" });
		store.record({ sessionId: "old", ts: new Date("2020-01-01T12:00:00").getTime(), role: "user", content: "去年的问题" });
		const convs = store.dayConversations(today);
		assert.equal(convs.length, 1);
		assert.equal(convs[0].messages[0].content, "今天的问题");
		// caps: huge message clipped
		store.record({ sessionId: "today", ts: noon + 1, role: "user", content: "x".repeat(10_000) });
		const capped = store.dayConversations(today, { maxCharsPerMessage: 100, maxTotalChars: 500 });
		assert.ok(capped[0].messages.every((m) => m.content.length <= 101));
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

// -------------------------------------------------------------- context ----

test("context: system + project agent.md + experience, project wins order", () => {
	const home = tmp();
	const proj = tmp();
	try {
		writeFileSync(join(home, "agent.md"), "全局：回答要简洁");
		writeFileSync(join(home, "experience.md"), "经验A\n经验B");
		writeFileSync(join(proj, "agent.md"), "项目：用 pnpm");
		const ctx = loadAgentContext(proj, home);
		assert.equal(ctx.sources.length, 3);
		assert.equal(ctx.sources[0].kind, "system");
		assert.equal(ctx.sources[1].kind, "project");
		assert.equal(ctx.sources[2].kind, "experience");
		// system before project (refinement order), experience last
		assert.ok(ctx.text.indexOf("全局：回答要简洁") < ctx.text.indexOf("项目：用 pnpm"));
		assert.ok(ctx.text.includes("历史经验"));
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(proj, { recursive: true, force: true });
	}
});

test("context: walk-up finds nested agent.md, AGENTS.md alias, empty home", () => {
	const root = tmp();
	const nested = join(root, "a", "b");
	mkdirSync(nested, { recursive: true });
	try {
		writeFileSync(join(root, "AGENTS.md"), "根指令");
		writeFileSync(join(nested, "agent.md"), "叶子指令");
		const files = loadAgentContext(nested, tmp()).sources.filter((s) => s.kind === "project");
		assert.equal(files.length, 2);
		assert.equal(files[0].path, join(root, "AGENTS.md")); // root first
		assert.equal(files[1].path, join(nested, "agent.md")); // deepest last = most specific
		// no files anywhere → empty context
		const empty = loadAgentContext(tmp(), tmp());
		assert.equal(empty.text, "");
		assert.equal(empty.sources.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("context: clipExperience caps by lines", () => {
	const many = Array.from({ length: 100 }, (_, i) => `行${i}`).join("\n");
	const clipped = clipExperience(many, 10);
	assert.ok(clipped.split("\n").length <= 11);
	assert.ok(clipped.includes("已截断"));
	assert.equal(clipExperience("短", 10), "短");
});

// ---------------------------------------------------------------- tasks ----

test("tasks: catalog register/due/mark persistence + scheduler fires when idle", async () => {
	const dir = tmp();
	try {
		const catPath = join(dir, "tasks", "catalog.json");
		const cat = new TaskCatalog(catPath);
		cat.register("daily-summary", "daily", "每日总结");
		assert.ok(cat.isDue("daily-summary"));
		cat.markRun("daily-summary", "ok: 3 会话");
		assert.ok(!cat.isDue("daily-summary"));
		assert.equal(cat.get("daily-summary")?.state, "ok: 3 会话");
		// persisted
		const re = new TaskCatalog(catPath);
		assert.equal(re.get("daily-summary")?.lastRun, localDateStr());

		// scheduler: due task runs after idleMs (fresh dir — the catalog above
		// already marked today done, which would make the task NOT due)
		const dir2 = tmp();
		const ran: string[] = [];
		const sched = new IdleTaskScheduler({
			home: dir2,
			idleMs: 20,
			isIdle: () => true,
			runTask: async (id) => {
				ran.push(id);
				return "ok";
			},
			log: () => {},
		});
		sched.register("daily-summary", "daily", "每日总结");
		sched.nudge();
		await new Promise((r) => setTimeout(r, 120));
		assert.deepEqual(ran, ["daily-summary"]);
		rmSync(dir2, { recursive: true, force: true });
		assert.ok(sched.tasks.get("daily-summary")?.lastRun);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tasks: failing task records error and stays due", async () => {
	const dir = tmp();
	try {
		const sched = new IdleTaskScheduler({
			home: dir,
			idleMs: 10,
			isIdle: () => true,
			runTask: async () => {
				throw new Error("429 too many requests");
			},
			log: () => {},
		});
		sched.register("daily-summary", "daily", "每日总结");
		sched.nudge();
		await new Promise((r) => setTimeout(r, 100));
		assert.ok(sched.tasks.get("daily-summary")?.state?.startsWith("error"));
		assert.ok(sched.tasks.get("daily-summary")?.state?.includes("429"));
		assert.ok(!sched.tasks.get("daily-summary")?.lastRun, "failed run must not count as done");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------- daily ----

test("daily: summary + experience merge written, secrets redacted", async () => {
	const dir = tmp();
	const store = await ConversationStore.open(join(dir, "index.db"));
	assert.ok(store);
	try {
		const today = localDateStr();
		const noon = new Date(today + "T12:00:00").getTime();
		store.touchSession("s1", { title: "修 bug", project: "/repo/a" });
		store.record({ sessionId: "s1", ts: noon, role: "user", content: "key 是 <REDACTED:fake-key-for-redact-test> 请保密" });
		store.record({ sessionId: "s1", ts: noon + 1, role: "assistant", content: "修好了，浮点比较要加 epsilon" });

		const note = await runDailySummary({
			home: dir,
			store,
			streamFn: fakeStream(["# 总结\n- 修了浮点 bug", "1. 2026-xx 浮点比较加 epsilon"]),
			day: today,
		});
		assert.ok(note.startsWith("ok"));
		const summary = readFileSync(join(dir, "memories", `${today}.md`), "utf8");
		assert.ok(summary.includes("浮点"));
		const experience = readFileSync(join(dir, "experience.md"), "utf8");
		assert.ok(experience.includes("epsilon"));
		// the redaction happened before the payload left (fakeStream echoes input? no —
		// we assert the redact() helper directly)
		// Format mirrors sk-... (20+ alnum) but the body uses a special-char filler that
		// can't collide with a real key while still triggering the redact regex.
		assert.equal(redact("sk-XXXX-FAKE-TEST-KEY-12345 ok"), "[REDACTED] ok");

		// empty day → skip
		const skip = await runDailySummary({ home: dir, store, streamFn: fakeStream(["x"]), day: "2030-01-01" });
		assert.ok(skip.startsWith("skip"));
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("daily: memoryStats lists summaries", () => {
	const dir = tmp();
	try {
		mkdirSync(join(dir, "memories"), { recursive: true });
		writeFileSync(join(dir, "memories", "2026-08-01.md"), "a");
		writeFileSync(join(dir, "memories", "2026-08-02.md"), "b");
		writeFileSync(join(dir, "memories", "note.txt"), "not a summary");
		const stats = memoryStats(dir);
		assert.deepEqual(stats.summaries, ["2026-08-01.md", "2026-08-02.md"]);
		assert.equal(stats.experience, "");
		assert.equal(stats.longTerm, "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ------------------------------------------------------------ long-term ----

test("longterm: context loads long-term.md between project and experience", () => {
	const home = tmp();
	const proj = tmp();
	try {
		writeFileSync(join(home, "agent.md"), "全局指令");
		writeFileSync(join(home, "long-term.md"), "长期：用户偏好中文");
		writeFileSync(join(home, "experience.md"), "经验：浮点加 epsilon");
		const ctx = loadAgentContext(proj, home);
		const kinds = ctx.sources.map((x) => x.kind);
		assert.deepEqual(kinds, ["system", "longterm", "experience"]);
		// stable knowledge before recent lessons in the composed prompt
		assert.ok(ctx.text.indexOf("用户偏好中文") < ctx.text.indexOf("浮点加 epsilon"));
		assert.ok(ctx.text.includes("长期记忆"));
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(proj, { recursive: true, force: true });
	}
});

test("longterm: distill merges summaries into long-term.md, skips when few", async () => {
	const dir = tmp();
	try {
		// too few summaries → skip without touching the LLM
		mkdirSync(join(dir, "memories"), { recursive: true });
		writeFileSync(join(dir, "memories", "2026-08-18.md"), "# 总结\n修了 bug");
		let llmCalls = 0;
		const fn = fakeStream(["x"]);
		const counting: StreamFn = (ctx, opts) => { llmCalls++; return fn(ctx, opts); };
		const skip = await runLongTermDistill({ home: dir, streamFn: counting });
		assert.ok(skip.startsWith("skip"));
		assert.equal(llmCalls, 0);

		// enough summaries → distill + write
		for (const d of ["2026-08-16", "2026-08-17", "2026-08-19"]) writeFileSync(join(dir, "memories", `${d}.md`), `# ${d}\n做了事`);
		const note = await runLongTermDistill({
			home: dir,
			streamFn: fakeStream(["- 用户偏好：简洁回答\n- 项目事实：用 pnpm"]),
		});
		assert.ok(note.startsWith("ok"));
		const lt = readFileSync(longTermPath(dir), "utf8");
		assert.ok(lt.includes("用户偏好"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tasks: weekly schedule — due when never run or ≥7 days old", () => {
	const dir = tmp();
	try {
		const cat = new TaskCatalog(join(dir, "tasks", "catalog.json"));
		cat.register("weekly-distill", "weekly", "每周蒸馏");
		assert.ok(cat.isDue("weekly-distill"));
		cat.markRun("weekly-distill", "ok", "2026-08-10");
		assert.ok(!cat.isDue("weekly-distill", "2026-08-13"), "day 3 not due");
		assert.ok(cat.isDue("weekly-distill", "2026-08-17"), "day 7 due");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("longterm: clipLongTerm caps by lines", () => {
	const many = Array.from({ length: 200 }, (_, i) => `- 条目${i}`).join("\n");
	const clipped = clipLongTerm(many, 80);
	assert.ok(clipped.split("\n").length <= 81);
	assert.ok(clipped.includes("已截断"));
});
