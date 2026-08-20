/** Inspect actual SSE frame contents to debug rendering. */
import { createWebServer } from "@puck-agent/web";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "puck-dbg-"));
const server = createWebServer({ port: 0, mock: true, cwd: dir, sessionsDir: join(dir, "sessions") });
await server.start();
const base = `http://127.0.0.1:${server.server.address().port}`;

const res = await fetch(base + "/api/run", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ input: "hi" }),
});
const raw = await res.text();
const frames = raw.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)));

console.log("total frames:", frames.length);
for (const e of frames) {
	if (e.type === "message_update" || e.type === "message_start" || e.type === "message_end") {
		const role = e.message?.role;
		if (role !== "assistant") {
			console.log(`${e.type} [${role}]`);
			continue;
		}
		const think = (e.message.content ?? []).filter((b) => b.type === "thinking").map((b) => b.thinking).join("");
		const text = (e.message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
		const tools = (e.message.content ?? []).filter((b) => b.type === "toolCall").map((b) => b.name);
		console.log(
			`${e.type} asst | think=${JSON.stringify(think.slice(0, 30))} | text=${JSON.stringify(text.slice(0, 40))} | tools=[${tools}] | stop=${e.message.stopReason ?? ""}`,
		);
	} else {
		console.log(e.type);
	}
}

await server.stop();
rmSync(dir, { recursive: true, force: true });
