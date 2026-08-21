/**
 * ESC-to-stop + QueuedInput key handling — behavioral tests through the
 * compiled dist (same pattern as term.test.ts).
 *
 * ESC path in the real CLI: keypress "escape" → QueuedInput.onEscape →
 * host calls agent.abort() → mock stream settles with stopReason "aborted".
 * Here we verify each link plus the end-to-end chain.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { QueuedInput } from "../packages/cli/dist/term.js";
import { Agent } from "../packages/core/dist/index.js";
import { createMockStreamFn } from "../packages/llm/dist/index.js";

/** Minimal readline stand-in: only QueuedInput's touched surface. */
function fakeRl(): { rl: unknown; input: EventEmitter & { isTTY?: boolean } } {
	const input = new EventEmitter() as EventEmitter & { isTTY?: boolean };
	input.isTTY = true;
	return { rl: { input }, input };
}

test("QueuedInput: ESC fires onEscape; Enter still queues; Ctrl+C still sigints", () => {
	const { rl, input } = fakeRl();
	let escaped = 0;
	let siginted = 0;
	const queued: string[] = [];
	const echoes: string[] = [];
	const q = new QueuedInput({
		onQueue: (line) => queued.push(line),
		onSigint: () => siginted++,
		onEscape: () => escaped++,
		onEcho: (_s, buf) => echoes.push(buf),
	});
	q.attach(rl as never);

	input.emit("keypress", "", { name: "c", ctrl: true });
	input.emit("keypress", "\x1b", { name: "escape" });
	input.emit("keypress", "h", {});
	input.emit("keypress", "i", {});
	input.emit("keypress", "", { name: "enter" });
	// ESC is not a printable char: must not leak into the buffer
	input.emit("keypress", "\x1b", { name: "escape" });
	q.detach(rl as never);

	assert.equal(siginted, 1);
	assert.equal(escaped, 2, "both ESC presses forwarded");
	assert.deepEqual(queued, ["hi"], "Enter submits the typed buffer");
	assert.ok(echoes.every((e) => !e.includes("\x1b")), "ESC never echoed into the buffer");
});

test("QueuedInput: onEscape optional (older hosts unaffected)", () => {
	const { rl, input } = fakeRl();
	const q = new QueuedInput({
		onQueue: () => {},
		onSigint: () => {},
		onEcho: () => {},
	});
	q.attach(rl as never);
	assert.doesNotThrow(() => input.emit("keypress", "\x1b", { name: "escape" }));
	q.detach(rl as never);
});

test("end-to-end: ESC semantics — abort() mid-stream settles the run as aborted, transcript stays resumable", async () => {
	const agent = new Agent({
		streamFn: createMockStreamFn([{ thinking: "reasoning...".repeat(8), text: "long answer ".repeat(20), delayMs: 20 }]),
	});
	const run = agent.prompt("hi");
	setTimeout(() => agent.abort(), 15); // mid-stream, exactly when ESC would fire
	const added = await run;
	const assistant = added.find((m) => m.role === "assistant") as { stopReason: string };
	assert.equal(assistant.stopReason, "aborted");
	// the transcript ends in the aborted assistant message — /resume replays it
	assert.equal(agent.messages[agent.messages.length - 1], assistant);
	// and the NEXT prompt starts a fresh run on the same transcript (no stuck state)
	const next = await agent.prompt("go on");
	const last = next[next.length - 1];
	assert.equal(last.role, "assistant");
	assert.equal((last as { stopReason: string }).stopReason, "stop");
});
