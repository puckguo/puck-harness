/**
 * Test runner wrapper — isolates the suite's global side effects from the
 * real ~/.puck.
 *
 * The session layer auto-registers every Session.create/load into
 * ~/.puck/sessions.json, and the memory/timing layers write ~/.puck too.
 * Unit tests create hundreds of throwaway sessions in tmp dirs, so `npm
 * test` points PUCK_HOME at a throwaway home first. Extra args (e.g. a
 * single file) are forwarded after --test.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILES = [
	"tests/core.test.ts",
	"tests/llm.test.ts",
	"tests/tools.test.ts",
	"tests/session.test.ts",
	"tests/features.test.ts",
	"tests/sdk.test.ts",
	"tests/auth.test.ts",
	"tests/real-api.test.ts",
	"tests/timing.test.ts",
	"tests/term.test.ts",
	"tests/term-spinner.test.ts",
	"tests/term-mention.test.ts",
	"tests/errorlog.test.ts",
	"tests/import.test.ts",
	"tests/web.test.ts",
	"tests/memory.test.ts",
	"tests/esc-stop.test.ts",
	"tests/rewind.test.ts",
];

const home = mkdtempSync(join(tmpdir(), "puck-test-home-"));
const env = { ...process.env, PUCK_HOME: home };
try {
	const child = spawnSync(process.execPath, ["--test", ...FILES, ...process.argv.slice(2)], { stdio: "inherit", env });
	process.exitCode = child.status ?? 1;
} finally {
	try {
		rmSync(home, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}
