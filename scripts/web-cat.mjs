/** Check /api/catalog and /api/models responses directly. */
import { createWebServer } from "@puckguo123/web";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "puck-cat-"));
const server = createWebServer({ port: 0, mock: true, cwd: dir, sessionsDir: join(dir, "sessions") });
await server.start();
const base = `http://127.0.0.1:${server.server.address().port}`;

for (const path of ["/api/catalog", "/api/models", "/api/providers"]) {
	try {
		const res = await fetch(base + path);
		const body = await res.json();
		console.log(path, "→", res.status, Array.isArray(body) ? `array[${body.length}]` : typeof body, Array.isArray(body) && body[0] ? JSON.stringify(body[0]).slice(0, 100) : "");
	} catch (error) {
		console.log(path, "→ FETCH ERROR:", error.message);
	}
}
await server.stop();
rmSync(dir, { recursive: true, force: true });
