import assert from "node:assert/strict";
import test from "node:test";
import { buildBar, buildPopupRows, charWidth, displayWidth, FileTrail, filterSlashCommands, formatTokens, parseInterject, renderBar, renderQueueRows, renderTrail, summarizeTurn, wrapByWidth } from "../packages/cli/dist/term.js";

const CMDS = [
	{ name: "login", args: "[provider]", desc: "接入 provider" },
	{ name: "logout", args: "<provider>", desc: "移除 key" },
	{ name: "models", desc: "列出模型" },
	{ name: "model", args: "<id>", desc: "切换模型" },
];

test("formatTokens: human units", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1000), "1k");
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(1_000_000), "1M");
	assert.equal(formatTokens(1_500_000), "1.5M");
});

test("filterSlashCommands: prefix match in definition order", () => {
	assert.deepEqual(filterSlashCommands(CMDS, "").map((c) => c.name), ["login", "logout", "models", "model"]);
	assert.deepEqual(filterSlashCommands(CMDS, "lo").map((c) => c.name), ["login", "logout"]);
	assert.deepEqual(filterSlashCommands(CMDS, "model").map((c) => c.name), ["models", "model"]);
	assert.deepEqual(filterSlashCommands(CMDS, "zzz"), []);
});

test("buildPopupRows: highlight + separator + desc clipping", () => {
	const rows = buildPopupRows(CMDS.slice(0, 2), 80);
	assert.equal(rows.length, 3); // 2 matches + separator
	assert.ok(rows[0].includes("→"));
	assert.ok(!rows[1].includes("→"));
	assert.ok(rows[2].includes("─"));
	// narrow terminal: descriptions clipped
	const narrow = buildPopupRows([{ name: "login", args: "[provider]", desc: "x".repeat(60) }], 30);
	assert.ok(narrow[0].length < 40, `row should be clipped, got ${narrow[0].length}`);
});

test("buildBar: home compression + stats + severity", () => {
	const bar = buildBar({
		cwd: "C:\\Users\\ada\\proj",
		home: "C:\\Users\\ada",
		model: "MiniMax-M3",
		inTokens: 1234,
		outTokens: 567,
		ctxTokens: 12_800,
		ctxWindow: 128_000,
	});
	assert.equal(bar.cwd, "~/proj");
	assert.deepEqual(bar.stats, ["↑1.2k ↓567", "10%/128k"]);
	assert.equal(bar.ctxSeverity, "ok");
	assert.equal(bar.model, "MiniMax-M3");

	const hot = buildBar({ cwd: "/x", home: "/h", model: "m", inTokens: 1, outTokens: 1, ctxTokens: 122_000, ctxWindow: 128_000 });
	assert.equal(hot.ctxSeverity, "hot");
	const warn = buildBar({ cwd: "/x", home: "/h", model: "m", inTokens: 1, outTokens: 1, ctxTokens: 100_000, ctxWindow: 128_000 });
	assert.equal(warn.ctxSeverity, "warn");

	const noUsage = buildBar({ cwd: "/x", home: "/h", model: "mock", inTokens: 0, outTokens: 0, ctxTokens: 0, ctxWindow: 0 });
	assert.deepEqual(noUsage.stats, []);
});

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

test("renderBar: fits cols (drops cwd first, keeps model), severity coloring", () => {
	const data = buildBar({ cwd: "/very/long/path/to/some/project", home: "/home/x", model: "MiniMax-M3", inTokens: 1200, outTokens: 300, ctxTokens: 9000, ctxWindow: 128_000 });
	const wide = stripAnsi(renderBar(data, 120));
	assert.ok(wide.includes("/very/long/path"));
	assert.ok(wide.includes("MiniMax-M3"));

	const mid = stripAnsi(renderBar(data, 40));
	assert.ok(!mid.includes("/very/long"), "cwd should be dropped at 40 cols");
	assert.ok(mid.includes("↑1.2k ↓300"));
	assert.ok(mid.includes("MiniMax-M3"));

	const tiny = stripAnsi(renderBar(data, 15));
	assert.ok(tiny.includes("MiniMax-M3"), "model survives even at 15 cols");
	assert.ok(tiny.length <= 15, `fits 15 cols, got ${tiny.length}`);

	const hot = buildBar({ cwd: "/x", home: "/h", model: "m", inTokens: 1, outTokens: 1, ctxTokens: 120_000, ctxWindow: 128_000 });
	assert.ok(renderBar(hot, 80).includes("\x1b[31m"), "hot severity is red");
});

test("FileTrail: newest first, dedupe moves to front, relativizes cwd", () => {
	const trail = new FileTrail();
	trail.record("C:\\proj\\src\\a.ts", "C:\\proj");
	trail.record("C:/proj/docs/b.md", "C:\\proj");
	assert.deepEqual(trail.list(), ["docs/b.md", "src/a.ts"]); // newest first
	trail.record("C:\\proj\\src\\a.ts", "C:\\proj"); // re-touch -> front
	assert.deepEqual(trail.list(), ["src/a.ts", "docs/b.md"]);
	trail.record("/elsewhere/x.txt", "C:\\proj"); // outside cwd stays absolute
	assert.deepEqual(trail.list(), ["/elsewhere/x.txt", "src/a.ts", "docs/b.md"]);
});

test("renderTrail: arrow order, drops oldest to fit, empty for none", () => {
	assert.equal(renderTrail([], 80, false), "");
	const plain = renderTrail(["a.ts", "b.md", "c.txt"], 80, false);
	assert.equal(plain, "✎ a.ts ← b.md ← c.txt");
	const narrow = renderTrail(["a.ts", "b.md", "c.txt"], 14, false);
	assert.ok(narrow.length <= 14, `fits: "${narrow}"`);
	assert.ok(narrow.startsWith("✎ a.ts"), "newest survives clipping");
});

// ---------------------------------------------------------------------------
// summarizeTurn — last-turn summary for title + bottom bar
// ---------------------------------------------------------------------------

const U = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const A = (blocks: unknown[]) => ({ role: "assistant", content: blocks, model: "m", stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0 }, timestamp: 0 });
const CALL = (name: string, args: unknown) => ({ type: "toolCall", id: "t1", name, arguments: args });

test("summarizeTurn: chat only → prompt + 回答", () => {
	const s = summarizeTurn([U("9+9等于几"), A([{ type: "text", text: "18" }])]);
	assert.equal(s.short, "9+9等于几");
	assert.equal(s.oneLine, "9+9等于几 → 回答");
});

test("summarizeTurn: write/edit tools → 改动 + basenames, dedup, +N", () => {
	const s = summarizeTurn([
		U("修一下bug"),
		A([CALL("write", { path: "docs/usage.md", content: "x" })]),
		A([CALL("edit", { path: "docs/usage.md", edits: [] }), CALL("write", { path: "src/a.ts", content: "y" }), CALL("write", { path: "src/b.ts", content: "z" })]),
	]);
	assert.equal(s.short, "修一下bug");
	assert.equal(s.oneLine, "修一下bug → 改动 usage.md、a.ts 等3个文件");
});

test("summarizeTurn: bash only → 执行命令 ×N", () => {
	const s = summarizeTurn([U("跑下测试"), A([CALL("bash", { command: "npm test" }), CALL("bash", { command: "ls" })])]);
	assert.equal(s.oneLine, "跑下测试 → 执行命令 ×2");
});

test("summarizeTurn: no user text → short falls back to first file", () => {
	const s = summarizeTurn([A([CALL("write", { path: "DEPLOYMENT-BRIEF.md", content: "x" })])]);
	assert.equal(s.short, "DEPLOYMEN…"); // 18 cp clipped to 10
	assert.ok(s.oneLine.startsWith("改动 DEPLOYMENT-BRIEF.md"));
});

test("summarizeTurn: title clips to 10 cp; oneLine to 120 cp (emoji pairs intact)", () => {
	const long = "这是一段非常非常长的用户提问内容需要被截断处理"; // 22 cp
	const s = summarizeTurn([U(long)]);
	assert.equal(Array.from(s.short).length, 10);
	assert.ok(s.short.endsWith("…"));
	assert.equal(Array.from(s.oneLine).length, 23); // 23 cp, unclipped under 120
	const emoji = summarizeTurn([U("🚀".repeat(30))]);
	assert.ok(emoji.short.startsWith("🚀"));
	assert.ok(emoji.short.endsWith("…"));
	// all emoji intact (full pairs) except the trailing single-unit ellipsis
	const units = Array.from(emoji.short);
	assert.ok(units.slice(0, -1).every((u) => u.length === 2));
	assert.equal(units[units.length - 1], "…");
});
test("summarizeTurn: first line only + whitespace collapse; block user content", () => {
	const s = summarizeTurn([{ role: "user", content: [{ type: "text", text: "  多行\n第二行" }] }]);
	assert.equal(s.short, "多行");
});

test("wrapByWidth: CJK-aware wrapping, no mid-pair breaks, overflow ellipsis", () => {
	// ascii fits one line
	assert.deepEqual(wrapByWidth("abc de", 10, 2), ["abc de"]);
	// CJK = 2 cells: 6 chars = 12 cells → wraps at 5 (10 cells), no mid-char break
	assert.deepEqual(wrapByWidth("修复thinking显示问题", 12, 2), ["修复thinking", "显示问题"]);
	// max 2 lines; overflow clips the 2nd line with …
	const out = wrapByWidth("修".repeat(30), 10, 2);
	assert.equal(out.length, 2);
	assert.ok(out[1].endsWith("…"));
	assert.equal(displayWidth(out[0]), 10);
	assert.ok(displayWidth(out[1]) <= 10);
	// emoji pair never split
	const em = wrapByWidth("🚀".repeat(6), 8, 2); // 12 cells → 4 + 4
	assert.deepEqual(em, ["🚀🚀🚀🚀", "🚀🚀"]);
});

test("charWidth: CJK/emoji wide, ascii narrow", () => {
	assert.equal(charWidth("a".codePointAt(0)!), 1);
	assert.equal(charWidth("修".codePointAt(0)!), 2);
	assert.equal(charWidth("：".codePointAt(0)!), 2);
	assert.equal(charWidth("🚀".codePointAt(0)!), 2);
	assert.equal(displayWidth("修复x"), 5);
});

// ---------------------------------------------------------------------------
// renderQueueRows — pinned queued-input rows (typing echo + queue list)
// ---------------------------------------------------------------------------

test("renderQueueRows: idle → blank rows, nothing painted", () => {
	assert.deepEqual(renderQueueRows({ active: false, typing: "", queued: [], interjected: 0 }, 80, false), ["", ""]);
});

test("renderQueueRows: live typing echoes in the pinned row (prompt-style)", () => {
	const rows = renderQueueRows({ active: true, typing: "改用方案B", queued: [], interjected: 0 }, 80, false);
	assert.equal(rows[0], "");
	assert.equal(rows[1], "you › 改用方案B");
});

test("renderQueueRows: queue list + interjected count, clipped to cols", () => {
	const rows = renderQueueRows({ active: true, typing: "", queued: ["第一条", "第二条", "第三条"], interjected: 1 }, 40, false);
	assert.ok(rows[0].startsWith("⏳ 已排队3 · 已插队1:"), rows[0]);
	assert.ok(rows[0].includes("第一条"), rows[0]);
	assert.ok(rows[0].endsWith("…"), `clipped with ellipsis, got "${rows[0]}"`);
	assert.ok(rows[1].includes("!"), "hint mentions the interject prefix");
	for (const row of rows) assert.ok(displayWidth(row) <= 40, `fits 40 cols: "${row}"`);
	// fits wide terminal: full list survives
	const wide = renderQueueRows({ active: true, typing: "", queued: ["a", "b"], interjected: 0 }, 80, false);
	assert.equal(wide[0], "⏳ 已排队2: a | b");
});

test("renderQueueRows: interjected-only shows count without list", () => {
	const rows = renderQueueRows({ active: true, typing: "", queued: [], interjected: 2 }, 80, false);
	assert.equal(rows[0], "⏳ 已插队2");
});

test("renderQueueRows: hint while a run is active (mentions queue + interject)", () => {
	const rows = renderQueueRows({ active: true, typing: "", queued: [], interjected: 0 }, 80, false);
	assert.equal(rows[0], "");
	assert.ok(rows[1].includes("排队"), rows[1]);
	assert.ok(rows[1].includes("!"), rows[1]);
});

test("parseInterject: ASCII and full-width ! both interject; prefix stripped + trimmed", () => {
	assert.deepEqual(parseInterject("!立即停"), { interject: true, text: "立即停" });
	assert.deepEqual(parseInterject("！立即停"), { interject: true, text: "立即停" });
	assert.deepEqual(parseInterject("!  leading spaces"), { interject: true, text: "leading spaces" });
	assert.deepEqual(parseInterject("！ 多个空格 "), { interject: true, text: "多个空格" });
	// no prefix (or a later one) → plain queued line, text untouched
	assert.deepEqual(parseInterject("普通消息"), { interject: false, text: "普通消息" });
	assert.deepEqual(parseInterject("wait! not a prefix"), { interject: false, text: "wait! not a prefix" });
	// prefix-only / blank stays “empty text” — the host clears the typing row
	assert.deepEqual(parseInterject("!"), { interject: true, text: "" });
	assert.deepEqual(parseInterject("！"), { interject: true, text: "" });
});

