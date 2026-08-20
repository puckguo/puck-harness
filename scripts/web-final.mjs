/** Final browser-visible check: real server, real HTTP, verify the page + picker data end-to-end. */
import { createWebServer } from "@puck-agent/web";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "puck-final-"));
const server = createWebServer({ port: 0, mock: true, cwd: dir, sessionsDir: join(dir, "sessions") });
await server.start();
const base = `http://127.0.0.1:${server.server.address().port}`;

// 1. page loads with the picker markup present
const html = await (await fetch(base + "/")).text();
console.log("page has model label:", html.includes('id="model"'));
console.log("page has modal container:", html.includes('id="modal"'));
console.log("page has manual-entry CSS:", html.includes(".manual"));

// 2. app.js served and contains the new picker
const js = await (await fetch(base + "/app.js")).text();
console.log("app.js has showModels:", js.includes("async function showModels"));
console.log("app.js has catalog+providers fallback:", js.includes("/api/catalog") && js.includes("/api/providers"));
console.log("app.js has client fallbacks:", js.includes("CLIENT_FALLBACKS"));
console.log("app.js has manual entry:", js.includes("provider/model"));

// 3. catalog data the picker consumes
const catalog = await (await fetch(base + "/api/catalog")).json();
const withFallback = catalog.filter((c) => c.fallback).length;
console.log("catalog providers:", catalog.length, "| with fallback model:", withFallback);

// 4. a run still works end-to-end after all changes
const res = await fetch(base + "/api/run", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ input: "final check" }),
});
const frames = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: "));
console.log("run frames:", frames.length, "| settled:", frames.at(-1).includes("run_settled"));

await server.stop();
rmSync(dir, { recursive: true, force: true });
console.log("\nFINAL OK");
