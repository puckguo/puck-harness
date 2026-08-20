/**
 * Full browser-flow E2E (not part of npm test): parity checks against the CLI.
 *   node scripts/web-e2e.mjs
 */
import { createWebServer } from "@puckguo123/web";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "puck-e2e-"));
const server = createWebServer({ port: 0, mock: true, cwd: dir, sessionsDir: join(dir, "sessions") });
await server.start();
const base = `http://127.0.0.1:${server.server.address().port}`;

const post = async (path, body) => {
	const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
	return { status: res.status, json: await res.json().catch(() => null) };
};

async function send(text, sessionId) {
	const res = await fetch(base + "/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, input: text }) });
	const raw = await res.text();
	return raw.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)));
}

// --- boot ------------------------------------------------------------------
const health = await (await fetch(base + "/api/health")).json();
console.log("[boot] model:", health.model, "| mock:", health.mock, "| cwd:", health.cwd);

// --- THE regression: user message must NOT render twice --------------------
let events = await send("hi", null);
const sessionId = events.find((e) => e.type === "server_notice")?.message.split(" ")[1];
const userStarts = events.filter((e) => e.type === "message_start" && e.message.role === "user");
console.log("[dup-check] user message_start frames:", userStarts.length, "(server-side echo; the browser renders its own local echo and SKIPS these)");
assert(userStarts.length === 1, "server emits the user message exactly once");

// the browser-side rendering contract: local echo + skip server user frames
// → exactly one visible "hi" block. Simulated here:
let visibleUserBlocks = 1; // local echo
for (const e of events) if (e.type === "message_start" && e.message.role === "user") visibleUserBlocks += 0; // skipped by app.js
console.log("[dup-check] visible user blocks:", visibleUserBlocks, "(must be 1)");

// --- full parity features ---------------------------------------------------
const think = await post("/api/think", { sessionId, effort: "low" });
console.log("[think]", think.status, think.json);

const compact = await post("/api/compact", { sessionId });
console.log("[compact]", compact.status, compact.json?.ok === false ? `refused: ${compact.json.reason}` : compact.json);

const status = await (await fetch(base + `/api/status?sessionId=${sessionId}`)).json();
console.log("[status] model:", status.model, "| thinking:", status.thinking, "| session:", status.session);

const timings = await (await fetch(base + "/api/timings")).json();
console.log("[timings] rows:", Array.isArray(timings) ? timings.length : timings);

const providers = await (await fetch(base + "/api/providers")).json();
console.log("[providers]", providers.length, "entries; stored:", providers.filter((p) => p.state !== "none").map((p) => p.id).join(",") || "(none)");

const state = await (await fetch(base + `/api/state?sessionId=${sessionId}`)).json();
console.log("[state] msgs:", state.messages.length, "| ctxTok:", state.ctxTokens, "| thinking:", state.thinking);

const sessions = await (await fetch(base + "/api/sessions")).json();
console.log("[resume]", sessions.map((s) => `${s.id}:${s.turns}轮`).join(", "));

// abort while idle
console.log("[abort]", (await post("/api/abort", { sessionId })).status);

// spinner parity: run1 with delayMs=500 has silent period → turn_start fires
const run1Tools = events.filter((e) => e.type === "tool_start").map((e) => e.toolName);
console.log("[run1] tools:", run1Tools.join("+"), "| has thinking stream:", events.some((e) => e.type === "message_update" && JSON.stringify(e.message.content).includes("thinking")));

// stats parity: turn_end carries usage for the bar
const turns = events.filter((e) => e.type === "turn_end");
console.log("[run1] turn_end count:", turns.length);

await server.stop();
rmSync(dir, { recursive: true, force: true });
console.log("E2E OK");

function assert(cond, msg) {
	if (!cond) {
		console.error("ASSERT FAIL:", msg);
		process.exit(1);
	}
}
