/**
 * External harness import tests — fixtures mirror the real formats verified
 * against local ~/.claude / ~/.pi / ~/.codex samples.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectFormat, importExternalSession, scanExternalSessions, cwdMatches, claudeCwdSlug, piCwdSlug, type ExternalSessionInfo } from "@puck-agent/session/import";
import { SessionStore } from "@puck-agent/session";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "puck-import-"));
}

// --- fixtures ---------------------------------------------------------------

const PI_FIXTURE = [
	JSON.stringify({ type: "session", version: 3, id: "pi-uuid-1", timestamp: "2026-08-01T00:00:00Z", cwd: "C:\\x" }),
	JSON.stringify({ type: "model_change", id: "m1", parentId: null, provider: "minimax-cn", modelId: "MiniMax-M3" }),
	JSON.stringify({ type: "message", id: "a1", parentId: "m1", message: { role: "user", content: [{ type: "text", text: "修复登录bug" }], timestamp: 1 } }),
	JSON.stringify({
		type: "message",
		id: "a2",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "先看代码" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
			],
			provider: "minimax-cn",
			model: "MiniMax-M3",
			usage: { input: 10, output: 5, cacheRead: 3, totalTokens: 15 },
			timestamp: 2,
		},
	}),
	JSON.stringify({ type: "message", id: "a3", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "file1\nfile2" }], timestamp: 3 } }),
	JSON.stringify({ type: "compaction", id: "c1", summary: "早期对话摘要", firstKeptEntryId: "a2", tokensBefore: 9000 }),
	JSON.stringify({ type: "message", id: "a4", message: { role: "assistant", content: [{ type: "text", text: "修复完成" }], provider: "minimax-cn", model: "MiniMax-M3", usage: { input: 1, output: 1, totalTokens: 2 }, timestamp: 4 } }),
].join("\n");

const CLAUDE_FIXTURE = [
	JSON.stringify({ type: "mode", mode: "normal", sessionId: "cl-1" }),
	JSON.stringify({ type: "ai-title", aiTitle: "修复登录超时", sessionId: "cl-1" }),
	JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "首页报错 TypeError" }, timestamp: "2026-08-01T01:00:00Z", sessionId: "cl-1" }),
	JSON.stringify({ type: "assistant", uuid: "s1", parentUuid: "u1", message: { id: "msg-A", role: "assistant", content: [{ type: "thinking", thinking: "先复现" }], model: "glm-5.2", usage: { input_tokens: 100, output_tokens: 10 } } }),
	JSON.stringify({ type: "assistant", uuid: "s2", parentUuid: "s1", message: { id: "msg-A", role: "assistant", content: [{ type: "text", text: "我来看看" }, { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "C:\\a.ts" } }], model: "glm-5.2", usage: { input_tokens: 100, output_tokens: 10 } } }),
	JSON.stringify({ type: "user", uuid: "u2", parentUuid: "s2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "line1\nline2" }] } }),
	JSON.stringify({ type: "user", uuid: "u3", parentUuid: "u2", isCompactSummary: true, message: { role: "user", content: "压缩摘要正文" } }),
	JSON.stringify({ type: "assistant", uuid: "s3", parentUuid: "u3", isSidechain: true, message: { id: "msg-S", role: "assistant", content: [{ type: "text", text: "subagent 不应导入" }] } }),
].join("\n");

const CODEX_FIXTURE = [
	JSON.stringify({ type: "session_meta", payload: { session_id: "cx-1", cwd: "C:\\x" } }),
	JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.2", cwd: "C:\\x" } }),
	JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "# AGENTS.md instructions for C:\\x" }] } }),
	JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "auth 页无限闪烁" }] } }),
	JSON.stringify({ type: "response_item", payload: { type: "function_call", id: "fc_0", name: "shell_command", arguments: "{\"command\":\"ls\"}" } }),
	JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call_xyz", output: "Exit code: 0\nfile1" } }),
	JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已定位问题" }] } }),
].join("\n");

// --- tests ------------------------------------------------------------------

test("import: pi fixture → messages, pairing, compaction, model", () => {
	const dir = tmp();
	try {
		const f = join(dir, "s.jsonl");
		writeFileSync(f, PI_FIXTURE);
		assert.equal(detectFormat(f), "pi");
		const s = importExternalSession(f, join(dir, "out"));
		assert.equal(s.messages[0].role, "user");
		assert.equal(String((s.messages[0] as { content: string }).content), "修复登录bug");
		const asst = s.messages[1];
		assert.equal(asst.role, "assistant");
		const content = (asst as { content: Array<{ type: string }> }).content;
		assert.equal(content[0].type, "thinking");
		assert.equal(content[1].type, "toolCall");
		assert.equal((asst as { model: string }).model, "minimax-cn/MiniMax-M3");
		// compaction summary materialized as a user message + counter
		assert.ok(s.messages.some((m) => m.role === "user" && String((m as { content: string }).content).includes("[Context compaction]")));
		assert.equal(s.compactionCount, 1);
		assert.equal((s.messages[2] as { toolCallId: string }).toolCallId, "call-1"); // pairing preserved
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("import: claude fixture → merge spans, id pairing, title, sidechain skipped", () => {
	const dir = tmp();
	try {
		const f = join(dir, "s.jsonl");
		writeFileSync(f, CLAUDE_FIXTURE);
		assert.equal(detectFormat(f), "claude");
		const s = importExternalSession(f, join(dir, "out"));
		const roles = s.messages.map((m) => m.role);
		assert.deepEqual(roles, ["user", "assistant", "toolResult", "user"]);
		// merged assistant: thinking + text + toolCall in ONE message
		const merged = s.messages[1] as unknown as { content: Array<{ type: string }> };
		assert.deepEqual(merged.content.map((c) => c.type), ["thinking", "text", "toolCall"]);
		// exact id pairing
		assert.equal((s.messages[2] as { toolCallId: string }).toolCallId, "tu-1");
		// compaction counted; sidechain message absent
		assert.equal(s.compactionCount, 1);
		assert.ok(!s.messages.some((m) => m.role === "assistant" && JSON.stringify((m as { content: unknown }).content).includes("subagent")));
		// usage renamed from anthropic fields
		const usage = (s.messages[1] as { usage?: { input: number; cacheRead?: number } }).usage;
		assert.equal(usage?.input, 200); // 100 + 100 across merged spans
		assert.equal(usage?.cacheRead, 0); // renamed from cache_read_input_tokens, accumulated
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("import: codex fixture → noise filtered, sequential pairing, model from turn_context", () => {
	const dir = tmp();
	try {
		const f = join(dir, "s.jsonl");
		writeFileSync(f, CODEX_FIXTURE);
		assert.equal(detectFormat(f), "codex");
		const s = importExternalSession(f, join(dir, "out"));
		// developer noise dropped
		assert.ok(!s.messages.some((m) => JSON.stringify(m).includes("AGENTS.md")));
		const roles = s.messages.map((m) => m.role);
		assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant"]);
		// the toolCall id came from function_call.id (fc_0) even though output.call_id differs
		const call = (s.messages[1] as { content: Array<{ type: string; id?: string }> }).content[0];
		assert.equal(call.id, "fc_0");
		assert.equal((s.messages[2] as { toolCallId: string }).toolCallId, "fc_0");
		assert.equal((s.messages[1] as { model: string }).model, "openai/gpt-5.2");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("import: sanitize drops toolCalls without outputs (wire API safety)", () => {
	const dir = tmp();
	try {
		// claude span with a tool_use that never got a tool_result
		const torn = [
			JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "assistant", uuid: "s1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "never-answered", name: "bash", input: { command: "x" } }], model: "m" } }),
		].join("\n");
		const f = join(dir, "torn.jsonl");
		writeFileSync(f, torn);
		const s = importExternalSession(f, join(dir, "out"));
		// the orphan toolCall was dropped, and with it the now-empty assistant message
		assert.equal(s.messages.length, 1);
		assert.equal(s.messages[0].role, "user");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("import: idempotent id + resumability (loaded session roundtrips)", () => {
	const dir = tmp();
	try {
		const f = join(dir, "s.jsonl");
		writeFileSync(f, PI_FIXTURE);
		const first = importExternalSession(f, dir, { id: "stable-id" });
		const store = new SessionStore(dir);
		const again = store.load("stable-id");
		assert.equal(again.messages.length, first.messages.length);
		assert.equal(again.compactionCount, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("scan: real harness stores are discovered (or gracefully empty)", () => {
	// this machine has ~/.claude, ~/.pi and ~/.codex histories
	const infos = scanExternalSessions();
	assert.ok(infos.length >= 3, `expected real external sessions, got ${infos.length}`);
	const sources = new Set(infos.map((i) => i.source));
	assert.ok(sources.has("pi") && sources.has("claude") && sources.has("codex"), `sources: ${[...sources].join(",")}`);
	for (const i of infos.slice(0, 10)) {
		assert.ok(i.turns > 0 || i.title === "(empty)");
		assert.ok(i.path.endsWith(".jsonl"));
	}
});

test("import: re-importing the same external file reuses the puck session (idempotent)", () => {
	// The unified /resume picker uses the source's puck-id mapping to dedup:
	// already-imported external sessions appear as puck-native (not duplicated
	// under their [source] label). This test pins down the id derivation.
	const dir = tmp();
	try {
		const f = join(dir, "s.jsonl");
		writeFileSync(f, PI_FIXTURE);
		const first = importExternalSession(f, dir, { id: "import-pi-fixture-stable" });
		const store = new SessionStore(dir);
		const again = store.load("import-pi-fixture-stable");
		assert.equal(again.messages.length, first.messages.length);
		// A second importExternalSession call without explicit id would derive
		// the same id from baseName('s.jsonl'.slice(-24)) → still stable across
		// runs since baseName doesn't change.
		const second = importExternalSession(f, dir);
		const derived = second.id;
		assert.match(derived, /^import-pi-/);
		assert.ok(store.list().includes(derived));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("scan: external sessions carry cwd for /resume cwd-filter", () => {
	// /resume defaults to the current directory and uses cwdMatches() to keep
	// other projects out of the way. Verify the extraction is wired for all
	// three sources.
	const dir = tmp();
	try {
		const piFile = join(dir, "pi.jsonl");
		writeFileSync(
			piFile,
			PI_FIXTURE.replace('"cwd": "C:\\\\x"', '"cwd": "C:\\\\demo\\\\project"'),
		);
		const piSession = importExternalSession(piFile, dir, { id: "pi-cwd-test" });
		assert.ok(piSession);

		const infos = scanExternalSessions();
		for (const info of infos) {
			// every real scan result must carry cwd — without it /resume's filter
			// would treat the session as out-of-scope and hide it permanently.
			assert.ok(info.cwd, `info.cwd missing for ${info.source} ${info.path}`);
		}

		// pi v3 + claude: cwdMatches is exact slug comparison (parent dir === encodeCwd(cwd)).
		const piMatch: ExternalSessionInfo = {
			source: "pi", path: "irrelevant", id: "x", title: "t",
			turns: 1, assistantMessages: 0, toolCalls: 0, compactions: 0,
			updatedAt: 0, cwd: piCwdSlug("C:\\demo\\project"),
		};
		assert.ok(cwdMatches("C:\\demo\\project", piMatch));
		assert.ok(!cwdMatches("C:\\demo\\other", piMatch));

		const claudeMatch: ExternalSessionInfo = {
			source: "claude", path: "irrelevant", id: "x", title: "t",
			turns: 1, assistantMessages: 0, toolCalls: 0, compactions: 0,
			updatedAt: 0, cwd: claudeCwdSlug("C:\\demo\\project"),
		};
		assert.ok(cwdMatches("C:\\demo\\project", claudeMatch));
		assert.ok(!cwdMatches("C:\\demo\\other", claudeMatch));

		// codex: cwd is the verbatim path stored in session_meta.payload.cwd.
		// Comparison normalizes separators + case so /c\foo and c:/foo match.
		const codexMatch: ExternalSessionInfo = {
			source: "codex", path: "irrelevant", id: "x", title: "t",
			turns: 1, assistantMessages: 0, toolCalls: 0, compactions: 0,
			updatedAt: 0, cwd: "C:\\demo\\project",
		};
		assert.ok(cwdMatches("C:\\demo\\project", codexMatch));
		assert.ok(cwdMatches("c:/demo/project", codexMatch), "case + slash insensitive");
		assert.ok(!cwdMatches("C:\\demo\\other", codexMatch));

		// undefined cwd → no match (conservative: don't accidentally scope unknown sessions)
		const unknown: ExternalSessionInfo = {
			source: "pi", path: "irrelevant", id: "x", title: "t",
			turns: 1, assistantMessages: 0, toolCalls: 0, compactions: 0,
			updatedAt: 0,
		};
		assert.ok(!cwdMatches("C:\\anywhere", unknown));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
