/**
 * SDK tests: createPuck wiring with the mock provider.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@puck-agent/core";
import { createPuck } from "@puck-agent/sdk";
import { createMockStreamFn } from "@puck-agent/llm";
import { SessionStore } from "@puck-agent/session";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const echoTool: Tool = {
	name: "echo",
	description: "echo",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	async execute(args) {
		return { content: [{ type: "text", text: `echo: ${String((args as { text: string }).text)}` }] };
	},
};

test("createPuck: run returns final text and usage", async () => {
	const puck = createPuck({
		model: "mock",
		streamFn: createMockStreamFn([
			{ toolCalls: [{ name: "echo", arguments: { text: "sdk" } }] },
			{ text: "all done" },
		]),
		tools: [echoTool],
		session: false,
	});

	const result = await puck.run("hello");
	assert.equal(result.text, "all done");
	assert.ok(result.messages.some((m) => m.role === "toolResult"));
});

test("createPuck: session persistence and hydration", async () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-sdk-"));
	try {
		const first = createPuck({
			model: "mock",
			streamFn: createMockStreamFn([{ text: "remember this" }]),
			tools: "none",
			session: { dir, id: "sess-1" },
		});
		await first.run("hi");

		const store = new SessionStore(dir);
		assert.deepEqual(store.list(), ["sess-1"]);
		assert.equal(store.load("sess-1").messages.length, 2);

		// second instance hydrates from the same session and continues
		const second = createPuck({
			model: "mock",
			streamFn: createMockStreamFn([{ text: "continued" }]),
			tools: "none",
			session: { dir, id: "sess-1" },
		});
		assert.equal(second.agent.messages.length, 2);
		await second.run("more");
		assert.equal(store.load("sess-1").messages.length, 4);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createPuck: approval gate blocks tool calls", async () => {
	const puck = createPuck({
		model: "mock",
		streamFn: createMockStreamFn([
			{ toolCalls: [{ name: "echo", arguments: { text: "blocked?" } }] },
			{ text: "tool was blocked, fine" },
		]),
		tools: [echoTool],
		session: false,
		approval: { policy: "always", ask: () => false, blockReason: "user said no" },
	});

	const result = await puck.run("try the tool");
	const toolResult = result.messages.find((m) => m.role === "toolResult") as {
		isError: boolean;
		content: Array<{ type: string; text: string }>;
	};
	assert.equal(toolResult.isError, true);
	assert.match(toolResult.content[0].text, /user said no/);
	assert.equal(result.text, "tool was blocked, fine");
});

test("createPuck: subscribe delivers streaming events", async () => {
	const puck = createPuck({
		model: "mock",
		streamFn: createMockStreamFn([{ text: "streamed" }]),
		tools: "none",
		session: false,
	});

	const types: string[] = [];
	puck.subscribe((event) => void types.push(event.type));
	await puck.run("hi");
	assert.ok(types.includes("message_update"));
	assert.ok(types.includes("run_end"));
});

test("createPuck: cwd is recorded on session creation (powers /resume cwd filter)", async () => {
	// /resume filters to the current cwd; the SDK must plumb cwd into the
	// session header so the picker can compare against it.
	const dir = mkdtempSync(join(tmpdir(), "puck-sdk-cwd-"));
	try {
		const puck = createPuck({
			model: "mock",
			streamFn: createMockStreamFn([{ text: "ok" }]),
			tools: "none",
			session: { dir, id: "cwd-test" },
			cwd: "C:\\projects\\demo",
		});
		await puck.run("hi");

		const session = new SessionStore(dir).load("cwd-test");
		assert.equal(session.cwd, "C:\\projects\\demo");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
