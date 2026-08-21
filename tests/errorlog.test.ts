/**
 * errorlog tests — the crash-path logger must write parseable JSONL, survive
 * hostile inputs (circular refs, non-Error throws, unwritable dirs) and
 * rotate past its size cap.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorLogPath, logError } from "../packages/cli/dist/errorlog.js";

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "puck-errorlog-"));
}

function readEntries(dir: string): Array<Record<string, unknown>> {
	const raw = readFileSync(errorLogPath(dir), "utf8");
	return raw
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("logError: writes one JSON line with kind/message/stack/cwd/context", () => {
	const dir = makeTmpDir();
	try {
		logError("uncaught", new Error("boom"), { tool: "edit", args: [{ oldText: "a" }] }, { dir });
		const entries = readEntries(dir);
		assert.equal(entries.length, 1);
		const e = entries[0];
		assert.equal(e.kind, "uncaught");
		assert.equal(e.message, "boom");
		assert.match(e.stack as string, /Error: boom/);
		assert.equal(e.cwd, process.cwd());
		assert.deepEqual(e.context, { tool: "edit", args: '[{"oldText":"a"}]' });
		assert.match(e.t as string, /^\d{4}-\d{2}-\d{2}T/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("logError: non-Error values (string/object) serialize into message, no stack", () => {
	const dir = makeTmpDir();
	try {
		logError("tool", "plain failure", { tool: "bash" }, { dir });
		logError("tool", { code: 500, detail: { deep: true } }, { tool: "read" }, { dir });
		const entries = readEntries(dir);
		assert.equal(entries[0].message, "plain failure");
		assert.equal(entries[0].stack, undefined);
		assert.equal(entries[1].message, '{"code":500,"detail":{"deep":true}}');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("logError: circular context and huge values never throw and stay capped", () => {
	const dir = makeTmpDir();
	try {
		const circular: Record<string, unknown> = { tool: "edit" };
		circular.self = circular;
		logError("tool", new Error("weird args"), { args: circular, big: "x".repeat(10_000) }, { dir });
		const entries = readEntries(dir);
		const ctx = entries[0].context as Record<string, unknown>;
		// circular value degrades to a string, not a crash
		assert.equal(typeof ctx.args, "string");
		assert.match(ctx.args as string, /tool/);
		// 10 KB field clipped to the 4000-char cap
		assert.ok((ctx.big as string).length <= 4000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("logError: rotates to error.log.1 past maxBytes", () => {
	const dir = makeTmpDir();
	try {
		// threshold below one entry → second write rotates
		logError("run", new Error("first"), undefined, { dir, maxBytes: 100 });
		assert.ok(statSync(errorLogPath(dir)).size > 0, "first entry written");
		logError("run", new Error("second"), undefined, { dir, maxBytes: 100 });
		const backup = errorLogPath(dir) + ".1";
		assert.ok(existsSync(backup), "backup exists after rotation");
		const backupText = readFileSync(backup, "utf8");
		assert.match(backupText, /first/);
		const live = readEntries(dir);
		assert.equal(live.length, 1);
		assert.equal(live[0].message, "second");
		// third write rotates again: previous backup is replaced, not lost
		logError("run", new Error("third"), undefined, { dir, maxBytes: 100 });
		assert.match(readFileSync(backup, "utf8"), /second/);
		assert.equal(readEntries(dir)[0].message, "third");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("logError: unwritable target never throws (logger must not crash the crash path)", () => {
	const dir = makeTmpDir();
	const blocker = join(dir, "blocker");
	writeFileSync(blocker, "a file where .puck should be"); // mkdir of "blocker/.puck" fails
	try {
		assert.doesNotThrow(() => logError("uncaught", new Error("boom"), undefined, { dir: blocker }));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("errorLogPath: lives under .puck/ next to the sessions dir", () => {
	const p = errorLogPath(join("C:", "work")).replace(/\\/g, "/");
	assert.ok(p.endsWith(".puck/error.log"), p);
});
