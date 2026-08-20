/**
 * Core loop + Agent tests. All offline via the mock stream fn.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Agent, runAgentLoop, validateToolArguments } from "@puckguo123/core";
import type { AgentEvent, Message, Tool } from "@puckguo123/core";
import { createMockStreamFn } from "@puckguo123/llm";

function echoTool(overrides: Partial<Tool> = {}): Tool {
	return {
		name: "echo",
		description: "echo the input",
		parameters: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
		async execute(args) {
			return { content: [{ type: "text", text: `echo: ${String((args as { text: string }).text)}` }] };
		},
		...overrides,
	};
}

test("loop runs a plain text exchange", async () => {
	const streamFn = createMockStreamFn([{ text: "hello world" }]);
	const context = { messages: [] as Message[], tools: [] as Tool[] };
	const events: AgentEvent[] = [];
	const added = await runAgentLoop({
		context,
		prompt: { role: "user", content: "hi", timestamp: 1 },
		streamFn,
		emit: (event) => void events.push(event),
	});

	assert.equal(added.length, 2);
	assert.equal(context.messages.length, 2);
	const assistant = added[1];
	assert.equal(assistant.role, "assistant");
	assert.equal(assistant.stopReason, "stop");
	assert.equal(events[0].type, "run_start");
	assert.equal(events.at(-1)?.type, "run_end");
});

test("loop executes tool calls and feeds results back", async () => {
	const streamFn = createMockStreamFn([
		{ text: "calling tool", toolCalls: [{ name: "echo", arguments: { text: "puck" } }] },
		{ text: "done after tool" },
	]);
	const context = { messages: [] as Message[], tools: [echoTool()] };
	const added = await runAgentLoop({
		context,
		prompt: { role: "user", content: "hi", timestamp: 1 },
		streamFn,
		emit: () => {},
	});

	// user, assistant(toolCall), toolResult, assistant(final)
	assert.equal(added.length, 4);
	const toolResult = added[2];
	assert.equal(toolResult.role, "toolResult");
	assert.equal(toolResult.isError, false);
	assert.match((toolResult as { content: Array<{ type: string; text: string }> }).content[0].text, /echo: puck/);
	const final = added[3] as { role: string; content: Array<{ type: string; text?: string }> };
	assert.equal(final.role, "assistant");
	assert.equal(final.content[0].text, "done after tool");
});

test("loop reports unknown tools and invalid arguments as error results", async () => {
	const streamFn = createMockStreamFn([
		{ toolCalls: [{ name: "missing", arguments: {} }, { name: "echo", arguments: {} }] },
		{ text: "recovered" },
	]);
	const context = { messages: [] as Message[], tools: [echoTool()] };
	const added = await runAgentLoop({
		context,
		prompt: { role: "user", content: "hi", timestamp: 1 },
		streamFn,
		emit: () => {},
	});

	const results = added.filter((m) => m.role === "toolResult") as Array<{
		isError: boolean;
		toolName: string;
		content: Array<{ type: string; text: string }>;
	}>;
	assert.equal(results.length, 2);
	assert.ok(results.every((r) => r.isError));
	assert.match(results[0].content[0].text, /not found/);
	assert.match(results[1].content[0].text, /required property/);
});

test("beforeToolCall can block execution", async () => {
	const streamFn = createMockStreamFn([
		{ toolCalls: [{ name: "echo", arguments: { text: "nope" } }] },
		{ text: "blocked" },
	]);
	const context = { messages: [] as Message[], tools: [echoTool()] };
	let executed = false;
	const tool = echoTool({
		async execute(args) {
			executed = true;
			return { content: [{ type: "text", text: "should not run" }] };
		},
	});
	context.tools = [tool];

	const added = await runAgentLoop({
		context,
		prompt: { role: "user", content: "hi", timestamp: 1 },
		streamFn,
		emit: () => {},
		hooks: {
			beforeToolCall: () => ({ block: true, reason: "denied by test policy" }),
		},
	});

	assert.equal(executed, false);
	const result = added.find((m) => m.role === "toolResult") as {
		isError: boolean;
		content: Array<{ type: string; text: string }>;
	};
	assert.match(result.content[0].text, /denied by test policy/);
});

test("maxTurns stops the loop", async () => {
	const streamFn = createMockStreamFn([
		{ toolCalls: [{ name: "echo", arguments: { text: "1" } }] },
		{ toolCalls: [{ name: "echo", arguments: { text: "2" } }] },
		{ toolCalls: [{ name: "echo", arguments: { text: "3" } }] },
	]);
	const context = { messages: [] as Message[], tools: [echoTool()] };
	const added = await runAgentLoop({
		context,
		prompt: { role: "user", content: "hi", timestamp: 1 },
		streamFn,
		emit: () => {},
		hooks: { maxTurns: 2 },
	});

	const turns = added.filter((m) => m.role === "assistant");
	assert.equal(turns.length, 2);
});

test("error stopReason ends the run and is recorded", async () => {
	const streamFn = createMockStreamFn([{ error: "boom" }]);
	const context = { messages: [] as Message[], tools: [] };
	const added = await runAgentLoop({
		context,
		prompt: { role: "user", content: "hi", timestamp: 1 },
		streamFn,
		emit: () => {},
	});
	const assistant = added[1] as { stopReason: string; errorMessage: string };
	assert.equal(assistant.stopReason, "error");
	assert.equal(assistant.errorMessage, "boom");
});

test("transformContext projects only the LLM view", async () => {
	const streamFn = createMockStreamFn([{ text: "ok" }]);
	const context = {
		messages: [{ role: "user", content: "old", timestamp: 1 }] as Message[],
		tools: [] as Tool[],
	};
	const added = await runAgentLoop({
		context,
		prompt: { role: "user", content: "new", timestamp: 2 },
		streamFn,
		emit: () => {},
		hooks: {
			transformContext: (messages) => messages.slice(-1),
		},
	});
	// canonical transcript keeps both messages
	assert.equal(context.messages.length, 3);
	assert.equal(added.length, 2);
});

test("length-truncated tool calls fail without executing", async () => {
	const streamFn = createMockStreamFn([
		{ toolCalls: [{ name: "echo", arguments: { text: "x" } }], stopReason: "length" },
	]);
	let executed = false;
	const context = {
		messages: [] as Message[],
		tools: [
			echoTool({
				async execute() {
					executed = true;
					return { content: [{ type: "text", text: "ran" }] };
				},
			}),
		],
	};
	const added = await runAgentLoop({
		context,
		prompt: { role: "user", content: "hi", timestamp: 1 },
		streamFn,
		emit: () => {},
	});
	assert.equal(executed, false);
	const result = added.find((m) => m.role === "toolResult") as {
		isError: boolean;
		content: Array<{ type: string; text: string }>;
	};
	assert.match(result.content[0].text, /token limit/);
});

test("validateToolArguments checks required and types", () => {
	const tool = echoTool();
	assert.equal(validateToolArguments(tool, { text: "ok" }), null);
	assert.match(validateToolArguments(tool, {}) ?? "", /required/);
	assert.match(validateToolArguments(tool, { text: 42 }) ?? "", /expected string/);
	assert.match(validateToolArguments(tool, "not an object") ?? "", /must be a JSON object/);
});

test("Agent: prompt, subscribe, steering queue", async () => {
	const agent = new Agent({
		streamFn: createMockStreamFn([
			{ toolCalls: [{ name: "echo", arguments: { text: "first" } }] },
			{ text: "after steering" },
		]),
		tools: [echoTool()],
	});

	const events: AgentEvent[] = [];
	agent.subscribe((event) => void events.push(event));

	// Queue steering while the run is active: it must be injected before the second LLM call.
	const runPromise = agent.prompt("start");
	agent.queue("steer mid-run");
	const added = await runPromise;

	const userTexts = added
		.filter((m) => m.role === "user")
		.map((m) => (typeof (m as { content: unknown }).content === "string" ? (m as { content: string }).content : ""));
	assert.deepEqual(userTexts, ["start", "steer mid-run"]);
	assert.ok(events.some((e) => e.type === "run_end"));
	assert.equal(agent.isStreaming, false);
});

test("Agent: steering queued during a no-tool answer extends the run (not dropped)", async () => {
	// The first answer has no tool calls — the loop's natural end would break
	// before draining steering. Input queued during that window must still be
	// answered in the same run, not silently dropped.
	const agent = new Agent({
		streamFn: createMockStreamFn([
			{ text: "plain answer", delayMs: 50 },
			{ text: "steered answer" },
		]),
	});
	const run = agent.prompt("hi");
	setTimeout(() => agent.queue("steer at the end"), 10);
	const added = await run;
	const userTexts = added
		.filter((m) => m.role === "user")
		.map((m) => (typeof (m as { content: unknown }).content === "string" ? (m as { content: string }).content : ""));
	assert.deepEqual(userTexts, ["hi", "steer at the end"]);
	const texts = added
		.filter((m) => m.role === "assistant")
		.map((m) => (m as { content: Array<{ type: string; text?: string }> }).content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""));
	assert.deepEqual(texts, ["plain answer", "steered answer"]);
});

test("Agent: abort settles the run", async () => {
	const agent = new Agent({
		streamFn: createMockStreamFn([{ text: "long answer", delayMs: 50 }]),
	});
	const run = agent.prompt("hi");
	setTimeout(() => agent.abort(), 10);
	const added = await run;
	const assistant = added.find((m) => m.role === "assistant") as { stopReason: string };
	assert.equal(assistant.stopReason, "aborted");
});

test("Agent: continueRun retries after an error", async () => {
	const agent = new Agent({
		streamFn: createMockStreamFn([{ error: "first fails" }, { text: "second works" }]),
	});
	const first = await agent.prompt("hi");
	assert.equal((first[1] as { stopReason: string }).stopReason, "error");
	const second = await agent.continueRun();
	// the errored assistant was popped and retried: transcript keeps user + one good assistant
	assert.equal(agent.messages.length, 2);
	const final = second.at(-1) as { content: Array<{ type: string; text: string }> };
	assert.equal(final.content[0]?.text, "second works");
});

test("Agent: iterate yields the event sequence", async () => {
	const agent = new Agent({ streamFn: createMockStreamFn([{ text: "abc" }]) });
	const types: string[] = [];
	for await (const event of agent.iterate("hi")) {
		types.push(event.type);
	}
	assert.ok(types.includes("run_start"));
	assert.ok(types.includes("turn_start"));
	assert.ok(types.indexOf("run_end") === types.length - 1);
});

test("Agent: setModel mid-run takes effect at the next LLM call", async () => {
	// model A answers with a tool call; the tool is slow, so we switch models
	// while the run is in flight. The second LLM call must come from model B.
	const modelA = createMockStreamFn([
		{ text: "calling tool", toolCalls: [{ name: "slow", arguments: {} }] },
	]);
	const modelB = createMockStreamFn([{ text: "answer from model B" }]);

	const slowTool: Tool = {
		name: "slow",
		description: "slow tool",
		parameters: { type: "object", properties: {} },
		async execute() {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return { content: [{ type: "text", text: "done" }] };
		},
	};

	const agent = new Agent({ streamFn: modelA, tools: [slowTool], modelId: "A" });
	const run = agent.prompt("hi");
	// switch while the slow tool executes
	await new Promise((resolve) => setTimeout(resolve, 5));
	agent.setModel("B", modelB);
	const added = await run;

	const final = added.at(-1);
	assert.ok(final && final.role === "assistant");
	assert.equal(
		final.content.find((c) => c.type === "text")?.type === "text"
			? (final.content[0] as { text: string }).text
			: "",
		"answer from model B",
	);
});

test("Agent: error run + queued steering recovers instead of losing input", async () => {
	// First call errors after a delay; user input queued during that window must
	// not be swallowed — the loop drops the failed assistant and retries.
	const streamFn = createMockStreamFn([{ error: "boom", delayMs: 30 }, { text: "recovered" }]);
	const agent = new Agent({ streamFn });

	const run = agent.prompt("first");
	setTimeout(() => agent.queue("second"), 5);
	const added = await run;

	const final = added.at(-1);
	assert.ok(final && final.role === "assistant");
	assert.equal(
		final.content.find((c) => c.type === "text")?.type === "text"
			? (final.content[0] as { text: string }).text
			: "",
		"recovered",
	);
	const users = added.filter((m) => m.role === "user");
	assert.equal(users.length, 2); // both inputs preserved
});

test("sequential tool execution on abort: every toolCall still gets a result (wire integrity)", async () => {
	// Model demands 3 tool calls; the first tool aborts the run mid-batch.
	const abort = new AbortController();
	const slowTool: Tool = {
		name: "slow",
		description: "aborts the run",
		parameters: { type: "object", properties: {} },
		async execute(): Promise<{ content: [{ type: "text"; text: string }] }> {
			abort.abort();
			return { content: [{ type: "text", text: "done" }] };
		},
	};
	const tools: Tool[] = [slowTool, { ...slowTool, name: "slow2" }, { ...slowTool, name: "slow3" }];
	const streamFn = createMockStreamFn([
		{
			text: "run tools",
			toolCalls: [
				{ name: "slow", arguments: {} },
				{ name: "slow2", arguments: {} },
				{ name: "slow3", arguments: {} },
			],
		},
	]);

	const context = { messages: [] as Message[], tools };
	const added = await runAgentLoop({
		context,
		prompt: { role: "user", content: "go", timestamp: Date.now() },
		streamFn,
		emit: () => {},
		hooks: { toolExecution: "sequential" },
		signal: abort.signal,
	});

	// every toolCall in the transcript must be answered by a toolResult
	const calls = added.flatMap((m) => (m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall") : []));
	const results = added.filter((m) => m.role === "toolResult");
	assert.equal(calls.length, 3);
	assert.equal(results.length, 3, `expected 3 results, got ${results.length}`);
});
