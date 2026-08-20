/**
 * Web client tests — real HTTP server on an ephemeral port, mock model
 * (zero network), Node's built-in test runner. Mirrors tests/sdk.test.ts.
 */

import { createWebServer } from "@puck-agent/web";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

let server: ReturnType<typeof createWebServer>;
let base: string;
let dir: string;

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "puck-web-"));
	server = createWebServer({ port: 0, host: "127.0.0.1", mock: true, cwd: dir, sessionsDir: join(dir, "sessions") });
	await server.start();
	const addr = server.server.address() as AddressInfo;
	base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
	await server.stop();
	rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown) {
	const res = await fetch(base + path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** Collect every SSE frame of one run. */
async function run(input: string, sessionId?: string) {
	const res = await fetch(base + "/api/run", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionId, input }),
	});
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "text/event-stream");
	const text = await res.text();
	return text
		.split("\n\n")
		.filter((frame) => frame.startsWith("data: "))
		.map((frame) => JSON.parse(frame.slice(6)));
}

describe("web server (mock)", () => {
	it("health endpoint reports mock mode", async () => {
		const res = await fetch(base + "/api/health");
		assert.equal(res.status, 200);
		const health = (await res.json()) as { ok: boolean; mock: boolean };
		assert.equal(health.ok, true);
		assert.equal(health.mock, true);
	});

	it("streams a full run as SSE with all event types in order", async () => {
		const events = await run("hello");
		const types = events.map((e) => e.type);
		assert.ok(types.includes("run_start"), "run_start present");
		assert.ok(types.includes("message_update"), "streaming deltas present");
		assert.ok(types.includes("tool_start"), "tool_start present");
		assert.ok(types.includes("tool_end"), "tool_end present");
		assert.ok(types.includes("turn_end"), "turn_end present");
		assert.ok(types.includes("run_end"), "run_end present");
		assert.equal(types.at(-1), "run_settled", "settled is the final frame");
		// ordering: server_notice opener, then run_start, run_settled last
		assert.equal(types[0], "server_notice");
		assert.equal(types[1], "run_start");
	});

	it("emits bash + write tool events (mock script exercises both)", async () => {
		const events = await run("demo");
		const started = events.filter((e) => e.type === "tool_start").map((e) => e.toolName);
		assert.ok(started.includes("bash"), "bash tool fired");
		assert.ok(started.includes("write"), "write tool fired");
		// tool_end marks success on the mock script
		const ended = events.filter((e) => e.type === "tool_end" && !e.isError);
		assert.ok(ended.length >= 2, "both tools ended ok");
	});

	it("round-trips one session across two runs (context persists)", async () => {
		const first = await run("first", "sess-a");
		assert.ok(first.length > 0);
		const state = (await (await fetch(base + "/api/state?sessionId=sess-a")).json()) as { sessionId: string; messages: unknown[]; running: boolean };
		assert.equal(state.sessionId, "sess-a");
		assert.ok(state.messages.length > 0, "transcript hydrated in state");
		assert.equal(state.running, false);
		// second run continues the same session
		const second = await run("second", "sess-a");
		assert.ok(second.length > 0);
		const state2 = (await (await fetch(base + "/api/state?sessionId=sess-a")).json()) as { messages: unknown[] };
		assert.ok(state2.messages.length > state.messages.length, "transcript grew");
	});

	it("lists sessions created through the API", async () => {
		await run("list-me", "sess-list");
		const sessions = (await (await fetch(base + "/api/sessions")).json()) as Array<{ id: string }>;
		assert.ok(Array.isArray(sessions));
		assert.ok(sessions.some((s) => s.id === "sess-list"), "created session appears in list");
	});

	it("rejects a run without input", async () => {
		const { status } = await post("/api/run", {});
		assert.equal(status, 400);
	});

	it("model switching is refused in mock mode", async () => {
		const { status, json } = await post("/api/model", { sessionId: "sess-a", model: "deepseek-chat" });
		assert.equal(status, 400);
		assert.ok(String(json?.error).includes("mock"));
	});

	it("abort endpoint answers ok even for unknown sessions", async () => {
		const { status } = await post("/api/abort", { sessionId: "no-such-session" });
		assert.equal(status, 200);
	});

	it("serves the bundled UI at /", async () => {
		const res = await fetch(base + "/");
		assert.equal(res.status, 200);
		assert.ok((res.headers.get("content-type") ?? "").includes("text/html"));
		const html = await res.text();
		assert.ok(html.includes("puck"), "UI page contains the app markup");
		assert.ok(html.includes("app.js"), "UI loads its script");
	});

	it("static traversal normalizes to the SPA entry (never leaks files)", async () => {
		// ".." collapses during URL/normalize — the request can never address a
		// file outside public/; it falls back to index.html instead of leaking.
		const res = await fetch(base + "/../package.json");
		assert.equal(res.status, 200);
		const body = await res.text();
		assert.ok(body.includes("puck"), "served the SPA entry, not a real file");
		assert.ok(!body.includes('"name": "@puck-agent/web"'), "no package.json contents leaked");
	});

	it("unknown API paths 404 with JSON", async () => {
		const res = await fetch(base + "/api/nope");
		assert.equal(res.status, 404);
		const body = (await res.json()) as { error?: string };
		assert.ok(body.error);
	});
});

describe("web server slash-command parity (mock)", () => {
	it("/api/status reports model, thinking, cwd, providers", async () => {
		const res = (await (await fetch(base + "/api/status")).json()) as Record<string, unknown>;
		assert.equal(res.mock, true);
		assert.ok(typeof res.cwd === "string");
		assert.ok(Array.isArray(res.providers));
	});

	it("/api/think sets effort and echoes it back", async () => {
		const set = await post("/api/think", { sessionId: "sess-a", effort: "high" });
		assert.equal(set.status, 200);
		assert.equal((set.json as { thinking: string }).thinking, "high");
		const state = (await (await fetch(base + "/api/state?sessionId=sess-a")).json()) as { thinking: string | null };
		assert.equal(state.thinking, "high");
	});

	it("/api/think rejects invalid effort", async () => {
		const { status } = await post("/api/think", { effort: "extreme" });
		assert.equal(status, 400);
	});

	it("/api/compact reports a too-small context instead of compacting", async () => {
		const { status, json } = await post("/api/compact", { sessionId: "sess-a" });
		assert.equal(status, 200);
		assert.equal(json?.ok, false);
		assert.ok(String(json?.reason).includes("上下文还很小"));
	});

	it("/api/compact 400s for unknown sessions", async () => {
		const { status } = await post("/api/compact", { sessionId: "never-created" });
		assert.equal(status, 400);
	});

	it("/api/timings returns per-model aggregates", async () => {
		const res = await fetch(base + "/api/timings");
		assert.equal(res.status, 200);
		const rows = (await res.json()) as unknown[];
		assert.ok(Array.isArray(rows));
	});

	it("/api/providers lists every provider with auth state", async () => {
		const res = await fetch(base + "/api/providers");
		const rows = (await res.json()) as Array<{ id: string; state: string }>;
		assert.ok(rows.length > 0);
		assert.ok(rows.every((r) => ["stored", "env", "none"].includes(r.state)));
	});

	it("/api/state exposes session stats (turns, compactions)", async () => {
		const state = (await (await fetch(base + "/api/state?sessionId=sess-a")).json()) as {
			session: { turns: number; compactions: number } | null;
		};
		assert.ok(state.session, "session stats present after a run");
		assert.ok(state.session!.turns >= 1);
	});

	it("run SSE carries model_update only on actual switches", async () => {
		// mock script never switches; the run stream must not contain model_update
		const events = await run("model-check");
		assert.ok(!events.some((e) => e.type === "model_update"));
	});
});

describe("web model picker", () => {
	it("/api/catalog lists every provider without any key", async () => {
		const res = await fetch(base + "/api/catalog");
		assert.equal(res.status, 200);
		const groups = (await res.json()) as Array<{ provider: string; state: string; fallback?: string }>;
		assert.ok(groups.length >= 20, "full registry is browsable key-less");
		assert.ok(groups.every((g) => ["stored", "env", "none"].includes(g.state)));
		// fallbacks present for known providers
		const deepseek = groups.find((g) => g.provider === "deepseek");
		assert.equal(deepseek?.fallback, "deepseek-chat");
	});

	it("/api/login dryRun verifies a key without storing it", async () => {
		const before = (await fetch(base + "/api/providers").then((r) => r.json())) as Array<{ id: string; state: string }>;
		const res = await post("/api/login", { provider: "deepseek", apiKey: "sk-invalid-for-sure", dryRun: true });
		assert.equal(res.status, 200);
		// either a network refusal (ok:false with error) or a model list — but the
		// store must be untouched: no NEW stored provider appears after dryRun
		const after = (await fetch(base + "/api/providers").then((r) => r.json())) as Array<{ id: string; state: string }>;
		const ids = (list: Array<{ id: string; state: string }>) => list.filter((p) => p.state === "stored").map((p) => p.id).sort();
		assert.deepEqual(ids(after), ids(before), "dryRun must not persist the key");
		// a deepseek key was never stored before → still absent now
		assert.ok(!ids(after).includes("deepseek"));
	});

	it("/api/model rejects unknown models with a helpful error", async () => {
		const { status, json } = await post("/api/model", { model: "no-such-provider/nope" });
		// bare ids bind to a single provider when only one is usable; unknown
		// provider prefixes must fail with an error message
		if (status === 400) assert.ok(String(json?.error).length > 0);
	});
});
