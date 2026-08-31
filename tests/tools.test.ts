/**
 * Built-in tool tests: bash, read, write, edit, truncation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, createEditTool, createReadTool, createWriteTool, runShellCommand } from "@puckguo123/tools";
import { truncateHead, truncateTail } from "@puckguo123/tools";

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "puck-test-"));
}

const NODE = JSON.stringify(process.execPath); // quoted: Windows paths contain spaces
const ctx = { cwd: process.cwd() };

test("bash: captures output and exit codes", async () => {
	const ok = await runShellCommand(`${NODE} -e "console.log('puck-bash-ok')"`, process.cwd());
	assert.match(ok.output, /puck-bash-ok/);
	assert.equal(ok.exitCode, 0);

	const fail = await runShellCommand(`${NODE} -e "process.exit(3)"`, process.cwd());
	assert.equal(fail.exitCode, 3);
});

test("bash: timeout kills the command", async () => {
	const result = await runShellCommand(
		`${NODE} -e "setTimeout(() => {}, 10000)"`,
		process.cwd(),
		{ timeoutSeconds: 0.3 },
	);
	assert.equal(result.timedOut, true);
	assert.ok(result.durationMs < 5000);
});

/**
 * Regression: a grandchild that keeps duplicate pipe handles alive after the
 * direct child exits (Windows: spawn `shell:true` + `stdio:"ignore"` chains,
 * e.g. scripts that start a detached dev server). Node's "close" event never
 * fires then — waiting on it alone hangs the tool forever, and neither
 * ESC-abort nor the timeout can settle it. The tool must settle on "exit"
 * (after a short drain window) instead.
 */
test("bash: settles even when a grandchild holds the stdio pipes", async () => {
	const dir = makeTmpDir();
	try {
		// child: print, spawn the pipe-holding grandchild, exit 0 immediately.
		// the grandchild self-terminates after 8s so the test leaks no orphans
		// (it outlives the tool call — exactly the point).
		const script = join(dir, "leak.cjs");
		writeFileSync(
			script,
			`const { spawn } = require('node:child_process');
			spawn('cmd.exe', ['/d','/s','/c', ${JSON.stringify(`${process.execPath} -e "setTimeout(()=>{},8000)"`)}],
				{ shell: true, stdio: 'ignore' }).unref();
			console.log('grandchild spawned');
			process.exit(0);`,
		);
		const result = await runShellCommand(`${JSON.stringify(process.execPath)} ${JSON.stringify(script)} 2>&1`, dir, {});
		assert.equal(result.exitCode, 0, "exited normally");
		assert.match(result.output, /grandchild spawned/);
		// without the fix this promise NEVER settles ("close" never fires)
		assert.ok(result.durationMs < 5000, `settled in ${result.durationMs}ms`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Same hang via the abort path: ESC while the (leaky) command still runs. */
test("bash: abort settles even when a grandchild holds the pipes", async () => {
	const dir = makeTmpDir();
	try {
		// child: spawn the pipe-holding grandchild, then keep running (never exits);
		// grandchild self-terminates after 8s so the test leaks no orphans
		const script = join(dir, "leak-abort.cjs");
		writeFileSync(
			script,
			`const { spawn } = require('node:child_process');
			spawn('cmd.exe', ['/d','/s','/c', ${JSON.stringify(`${process.execPath} -e "setTimeout(()=>{},8000)"`)}],
				{ shell: true, stdio: 'ignore' }).unref();
			console.log('grandchild spawned');
			setInterval(() => {}, 8000);`,
		);
		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(), 300); // ESC mid-execution
		const result = await runShellCommand(
			`${JSON.stringify(process.execPath)} ${JSON.stringify(script)} 2>&1`,
			dir,
			{ timeoutSeconds: 60, signal: ctrl.signal },
		);
		assert.equal(result.aborted, true);
		assert.match(result.output, /grandchild spawned/);
		assert.ok(result.durationMs < 5000, `settled in ${result.durationMs}ms`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bash: tool result marks non-zero exits as errors", async () => {
	const bash = createBashTool();
	const ok = await bash.execute({ command: `${NODE} -e "console.log(1)"` }, ctx);
	assert.equal(ok.isError, undefined);

	const fail = await bash.execute({ command: `${NODE} -e "process.exit(2)"` }, ctx);
	assert.equal(fail.isError, true);
	assert.match((fail.content[0] as { text: string }).text, /exit code: 2/);
});

test("write + read roundtrip with offset/limit", async () => {
	const dir = makeTmpDir();
	try {
		const write = createWriteTool({ cwd: dir });
		const read = createReadTool({ cwd: dir });

		const lines = Array.from({ length: 300 }, (_, i) => `line-${i + 1}`).join("\n");
		const written = await write.execute({ path: "nested/file.txt", content: lines }, ctx);
		assert.equal(written.isError, undefined);

		const head = await read.execute({ path: "nested/file.txt", offset: 1, limit: 5 }, ctx);
		const text = (head.content[0] as { text: string }).text;
		assert.equal(text.split("\n").length, 5);
		assert.match(text, /line-1/);

		const window = await read.execute({ path: "nested/file.txt", offset: 100, limit: 3 }, ctx);
		assert.match((window.content[0] as { text: string }).text, /line-100/);

		const missing = await read.execute({ path: "nope.txt" }, ctx);
		assert.equal(missing.isError, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("read: confinement blocks paths outside cwd", async () => {
	const dir = makeTmpDir();
	try {
		const read = createReadTool({ cwd: dir });
		const result = await read.execute({ path: "../../etc/passwd" }, ctx);
		assert.equal(result.isError, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("edit: applies unique replacements and rejects ambiguous ones", async () => {
	const dir = makeTmpDir();
	const file = join(dir, "code.ts");
	writeFileSync(file, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
	try {
		const edit = createEditTool({ cwd: dir });

		const applied = await edit.execute(
			{
				path: "code.ts",
				edits: [
					{ oldText: "const a = 1;", newText: "const a = 10;" },
					{ oldText: "const c = 3;", newText: "const c = 30;" },
				],
			},
			ctx,
		);
		assert.equal(applied.isError, undefined);

		const read = createReadTool({ cwd: dir });
		const after = await read.execute({ path: "code.ts" }, ctx);
		const text = (after.content[0] as { text: string }).text;
		assert.match(text, /const a = 10;/);
		assert.match(text, /const b = 2;/);
		assert.match(text, /const c = 30;/);

		const notFound = await edit.execute(
			{ path: "code.ts", edits: [{ oldText: "not in file", newText: "x" }] },
			ctx,
		);
		assert.equal(notFound.isError, true);

		// "const" appears multiple times → ambiguous
		writeFileSync(file, "one\ntwo\nthree\n");
		const ambiguous = await edit.execute(
			{ path: "code.ts", edits: [{ oldText: "t", newText: "x" }] },
			ctx,
		);
		assert.equal(ambiguous.isError, true);
		assert.match((ambiguous.content[0] as { text: string }).text, /not unique/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("edit: malformed edits (non-string oldText/newText) return an error, not a crash", async () => {
	const dir = makeTmpDir();
	const file = join(dir, "code.ts");
	writeFileSync(file, "const a = 1;\n");
	try {
		const edit = createEditTool({ cwd: dir });

		// object/array/number values — the crash case from issue reports
		const bad = (await edit.execute(
			{ path: "code.ts", edits: [{ oldText: { deep: true } as never, newText: ["x"] as never }] },
			ctx,
		)) as { isError?: boolean; content: Array<{ type: string; text: string }> };
		assert.equal(bad.isError, true);
		assert.match(bad.content[0].text, /must be strings \(got object\/array\)/);

		// null/undefined fields
		const nullish = (await edit.execute(
			{ path: "code.ts", edits: [{ oldText: null as never, newText: "x" }] },
			ctx,
		)) as { isError?: boolean; content: Array<{ type: string; text: string }> };
		assert.equal(nullish.isError, true);
		assert.match(nullish.content[0].text, /must be strings \(got null\/string\)/);

		// edits not an array at all
		const noArray = await edit.execute({ path: "code.ts", edits: "nope" as never }, ctx);
		assert.equal(noArray.isError, true);
		assert.match((noArray.content[0] as { text: string }).text, /No edits provided/);

		// file untouched by failed runs
		assert.equal(readFileSync(file, "utf8"), "const a = 1;\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("truncate: head keeps the beginning, tail keeps the end", () => {
	const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
	const head = truncateHead(content, 10, 50_000);
	assert.equal(head.truncated, true);
	assert.match(head.content, /line 0/);
	assert.ok(!head.content.includes("line 99"));

	const tail = truncateTail(content, 10, 50_000);
	assert.match(tail.content, /line 99/);
	assert.ok(!tail.content.includes("line 0"));
});
