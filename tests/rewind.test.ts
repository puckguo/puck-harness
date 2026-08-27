/**
 * Rewind — Claude-Code-style double-ESC checkpoints.
 *
 * Covers the three layers the feature is built from:
 *   1. RewindStore: checkpoint lifecycle + copy-on-first-touch file snapshots
 *      + restore-to-earlier-node semantics (modify / create / delete cases)
 *      + per-session persistence and reload.
 *   2. Session: `rewind` log entries — replay truncates the transcript and
 *      rewinds the counters; statsAll reports the post-rewind view.
 *   3. DoubleEscDetector: the two-press window that triggers the picker.
 * Plus one end-to-end agent run: beforeToolCall snapshot → prompt → rewind
 * restores both the transcript and the working tree.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RewindStore, applyFileOps } from "../packages/features/dist/rewind/index.js";
import { DoubleEscDetector, watchStandaloneEsc } from "../packages/cli/dist/term.js";
import { Agent } from "../packages/core/dist/index.js";
import type { Message } from "../packages/core/dist/index.js";
import { createMockStreamFn } from "../packages/llm/dist/index.js";
import { Session, SessionStore } from "../packages/session/dist/index.js";
import { createWriteTool } from "../packages/tools/dist/index.js";

function tempProject(): { root: string; proj: string; checkpoints: string } {
	const root = mkdtempSync(join(tmpdir(), "puck-rewind-"));
	const proj = join(root, "proj");
	const checkpoints = join(root, "checkpoints");
	mkdirSync(proj, { recursive: true });
	return { root, proj, checkpoints };
}

const userMsg = (text: string, ts = Date.now()): Message => ({ role: "user", content: text, timestamp: ts });

// ---------------------------------------------------------------------------
// RewindStore
// ---------------------------------------------------------------------------

test("RewindStore: restore to an earlier node — modify, create and delete cases", () => {
	const { root, proj, checkpoints } = tempProject();
	try {
		const a = join(proj, "a.txt");
		const b = join(proj, "b.txt");
		const untouched = join(proj, "keep.txt");
		writeFileSync(a, "v0");
		writeFileSync(untouched, "stable");

		const store = new RewindStore(checkpoints);
		store.bind("sess-1", []);

		// run 1: modify a.txt, create b.txt (absent → restore deletes it)
		store.begin("first", [], 0);
		store.captureFile(a);
		writeFileSync(a, "v1");
		store.captureFile(b); // does not exist yet
		writeFileSync(b, "created");
		store.finish();

		// run 2: modify a.txt again, modify b.txt
		store.begin("second", [], 2);
		store.captureFile(a);
		writeFileSync(a, "v2");
		store.captureFile(b);
		writeFileSync(b, "created2");
		store.finish();

		assert.equal(store.list().length, 2, "two checkpoints recorded");

		// rewind to before run 2: a → v1, b → "created", untouched intact
		applyFileOps(store.restoreTo(2));
		assert.equal(readFileSync(a, "utf8"), "v1");
		assert.equal(readFileSync(b, "utf8"), "created");
		assert.equal(readFileSync(untouched, "utf8"), "stable");
		assert.equal(store.list().length, 1, "voided checkpoints are pruned");

		// rewind to before run 1: a → v0, b deleted (it was created during run 1)
		applyFileOps(store.restoreTo(1));
		assert.equal(readFileSync(a, "utf8"), "v0");
		assert.equal(existsSync(b), false, "file created after the node is deleted");
		assert.equal(store.list().length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("RewindStore: copy-on-first-touch — repeated captures in one run keep the ORIGINAL content", () => {
	const { root, proj, checkpoints } = tempProject();
	try {
		const a = join(proj, "a.txt");
		writeFileSync(a, "original");
		const store = new RewindStore(checkpoints);
		store.bind("sess-1", []);
		store.begin("run", [], 0);
		store.captureFile(a);
		writeFileSync(a, "changed-once");
		store.captureFile(a); // second modification of the same file in the same run
		store.finish();
		applyFileOps(store.restoreTo(1));
		assert.equal(readFileSync(a, "utf8"), "original");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("RewindStore: checkpoints persist per session and reload with message slices", () => {
	const { root, proj, checkpoints } = tempProject();
	try {
		const a = join(proj, "a.txt");
		writeFileSync(a, "x");
		const store = new RewindStore(checkpoints);
		const messages = [userMsg("m1"), userMsg("m2"), userMsg("m3")];
		store.bind("persist-me", messages);
		store.begin("hello\nsecond line", messages, 3);
		store.captureFile(a);
		store.finish();

		// a fresh store (simulated restart) reloads the checkpoint
		const reloaded = new RewindStore(checkpoints);
		reloaded.bind("persist-me", messages);
		const list = reloaded.list();
		assert.equal(list.length, 1);
		assert.equal(list[0].userText, "hello\nsecond line");
		assert.equal(list[0].sessionCount, 3);
		assert.equal(list[0].messages.length, 3, "agent view reconstructed from the session transcript");
		assert.equal(list[0].files.length, 1, "file snapshot refs survive the reload");
		// and the snapshot bytes are still restorable
		writeFileSync(a, "modified");
		applyFileOps(reloaded.restoreTo(list[0].serial));
		assert.equal(readFileSync(a, "utf8"), "x");

		// a different session starts clean
		const other = new RewindStore(checkpoints);
		other.bind("another-session", []);
		assert.equal(other.list().length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("RewindStore: files beyond maxFileBytes are skipped, never guessed", () => {
	const { root, proj, checkpoints } = tempProject();
	try {
		const big = join(proj, "big.bin");
		writeFileSync(big, Buffer.alloc(64));
		const store = new RewindStore(checkpoints, { maxFileBytes: 16 });
		store.bind("sess", []);
		store.begin("run", [], 0);
		store.captureFile(big);
		store.finish();
		writeFileSync(big, Buffer.alloc(64, 0xff));
		const ops = store.restoreTo(1);
		applyFileOps(ops);
		assert.equal(ops.length, 1);
		assert.equal(ops[0].skipped, true, "oversized file is reported as skipped");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Session rewind entries
// ---------------------------------------------------------------------------

test("Session: rewind truncates in memory, persists as an entry, and replays on load", () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-sess-rw-"));
	try {
		const store = new SessionStore(dir);
		const s = store.create({ id: "rw" });
		for (let i = 1; i <= 5; i++) s.append(userMsg(`m${i}`));
		s.recordCompaction();
		s.recordCompaction();
		assert.equal(s.compactionCount, 2);

		s.rewind(2, 0); // back to before compactions existed, keeping 2 messages
		assert.equal(s.messages.length, 2);
		assert.equal(s.compactionCount, 0, "counters rewind with the transcript");

		const loaded = Session.load(s.path);
		assert.equal(loaded.messages.length, 2, "replay applies the rewind entry");
		assert.equal(loaded.compactionCount, 0);

		// conversation continues from the rewound state
		loaded.append(userMsg("after"));
		const again = Session.load(s.path);
		assert.equal(again.messages.length, 3);
		assert.deepEqual(
			again.messages.map((m) => (m as { content: string }).content),
			["m1", "m2", "after"],
		);

		// a compaction AFTER the rewind still counts
		again.recordCompaction();
		assert.equal(Session.load(s.path).compactionCount, 1);

		// picker stats reflect the post-rewind conversation
		const stats = store.statsAll().find((x) => x.id === "rw")!;
		assert.equal(stats.turns, 3);
		assert.equal(stats.compactions, 1);
		assert.equal(stats.title, "m1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// DoubleEscDetector
// ---------------------------------------------------------------------------

test("DoubleEscDetector: two presses inside the window trigger; outside they don't", () => {
	let t = 1000;
	const d = new DoubleEscDetector(600, () => t);
	assert.equal(d.press(), false, "first press only arms");
	t += 250;
	assert.equal(d.press(), true, "second press inside the window triggers");
	assert.equal(d.press(), false, "third press arms again (window consumed)");
	t += 700;
	assert.equal(d.press(), false, "window has closed");
	assert.equal(d.press(), true);
	d.reset();
	assert.equal(d.press(), false, "reset forgets the pending press");
});

test("watchStandaloneEsc: byte-level double-ESC fires; escape sequences and split tails don't", async () => {
	const input = new EventEmitter();
	const presses: number[] = [];
	const detach = watchStandaloneEsc(input as unknown as NodeJS.ReadableStream, () => presses.push(Date.now()), 20);

	// escape sequences (arrows, F-keys) arrive as multi-byte chunks — ignored
	input.emit("data", Buffer.from("\x1b[A"));
	input.emit("data", "\x1b[B");
	// a split sequence: lone ESC then its tail within the grace window — the
	// pending ESC is cancelled, not counted
	input.emit("data", Buffer.from("\x1b"));
	setTimeout(() => input.emit("data", Buffer.from("[C")), 5);
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(presses.length, 0, "sequences and split tails never press");

	// standalone ESC: no tail arrives → one press after the grace window
	input.emit("data", Buffer.from("\x1b"));
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(presses.length, 1);

	// quick double press (both standalone)
	input.emit("data", Buffer.from("\x1b"));
	setTimeout(() => input.emit("data", "\x1b"), 30);
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(presses.length, 3, "both presses registered");

	// detach stops the watch (and cancels pending timers)
	input.emit("data", Buffer.from("\x1b"));
	detach();
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(presses.length, 3);
});

// ---------------------------------------------------------------------------
// end-to-end: agent + beforeToolCall snapshot → rewind restores both layers
// ---------------------------------------------------------------------------

test("end-to-end: checkpoint → write tool → rewind restores transcript and file", async () => {
	const { root, proj, checkpoints } = tempProject();
	try {
		const target = join(proj, "out.txt");
		const store = new RewindStore(checkpoints);
		const agent = new Agent({
			streamFn: createMockStreamFn([
				// run 1 consumes the first two steps (tool turn + closing turn),
				// run 2 the next two — the mock cursor advances per LLM call
				{ text: "writing", toolCalls: [{ name: "write", arguments: { path: "out.txt", content: "after" } }] },
				{ text: "done" },
				{ text: "rewriting", toolCalls: [{ name: "write", arguments: { path: "out.txt", content: "v2" } }] },
				{ text: "done again" },
			]),
			tools: [createWriteTool({ cwd: proj })],
			hooks: {
				// the same wiring the CLI installs (rewindHook): capture BEFORE the tool runs
				beforeToolCall: (info): undefined => {
					if (info.toolCall.name !== "write") return;
					const raw = (info.args as { path?: unknown }).path;
					if (typeof raw === "string") store.captureFile(resolve(proj, raw));
				},
			},
		});
		store.bind("e2e", agent.messages);

		// prompt 1 — creates the file
		store.begin("make the file", agent.messages, 0);
		await agent.prompt("go");
		store.finish();
		assert.ok(existsSync(target));
		assert.equal(readFileSync(target, "utf8"), "after");
		const afterFirst = agent.messages.length;
		assert.ok(afterFirst > 0);

		// prompt 2 — overwrites it (own checkpoint, own snapshot)
		store.begin("edit the file", agent.messages, afterFirst);
		await agent.prompt("again");
		store.finish();
		assert.equal(readFileSync(target, "utf8"), "v2");

		// rewind code only, to before prompt 2: file back to its run-1 result
		const cp2 = store.list().find((cp) => cp.userText === "edit the file")!;
		applyFileOps(store.restoreTo(cp2.serial));
		assert.equal(readFileSync(target, "utf8"), "after");

		// rewind both layers to before prompt 1
		const cp = store.list()[0];
		assert.equal(cp.userText, "make the file");
		agent.replaceMessages(cp.messages);
		applyFileOps(store.restoreTo(cp.serial));
		assert.equal(agent.messages.length, 0, "transcript back to the pre-prompt state");
		assert.equal(existsSync(target), false, "file created during the run is deleted");

		// the agent is immediately usable again on the rewound transcript
		const next = await agent.prompt("fresh start");
		assert.ok(next.length > 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
