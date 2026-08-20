/**
 * Manual smoke check for the web package (not part of npm test).
 *   node scripts/web-smoke.mjs
 */
import { createWebServer } from "@puckguo123/web";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "puck-web-smoke-"));
const server = createWebServer({ port: 0, mock: true, cwd: dir, sessionsDir: join(dir, "sessions") });
await server.start();
const base = `http://127.0.0.1:${server.server.address().port}`;
console.log("listening:", base);

const health = await (await fetch(base + "/api/health")).json();
console.log("health:", JSON.stringify(health));

const res = await fetch(base + "/api/run", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ input: "demo" }),
});
const text = await res.text();
const frames = text.split("\n\n").filter((f) => f.startsWith("data: "));
console.log("sse frames:", frames.length);
for (const t of ["run_start", "message_update", "tool_start", "tool_end", "turn_end", "run_end", "run_settled"]) {
	const hit = frames.some((f) => f.includes(`"type":"${t}"`));
	console.log(`  ${t}: ${hit ? "OK" : "MISSING"}`);
}

const html = await (await fetch(base + "/")).text();
console.log("ui loads app.js:", html.includes("app.js"));
const appjs = await fetch(base + "/app.js");
console.log("app.js:", appjs.status, appjs.headers.get("content-type"));

const sessions = await (await fetch(base + "/api/sessions")).json();
console.log("sessions:", sessions.length);

await server.stop();
rmSync(dir, { recursive: true, force: true });
console.log("done");
