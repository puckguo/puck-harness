import http from "node:http";
/**
 * LLM adapter tests, fully offline: fetch is stubbed with canned SSE streams.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Message } from "@puck-agent/core";
import { createMockStreamFn, streamOpenAi, streamAnthropic, contextWindowFor, recordContextWindow, resolveModel, defineModel } from "@puck-agent/llm";

const testModel = defineModel({
	id: "test-model",
	name: "Test",
	baseUrl: "https://llm.test/v1",
	apiKeyEnv: "TEST_API_KEY",
	contextWindow: 100_000,
	cost: { input: 1, output: 2 },
});

function sseResponse(events: unknown[], status = 200): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			}
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

async function withStubbedFetch<T>(body: unknown[] | Response, run: () => Promise<T>): Promise<{ result: T; requests: Array<Record<string, unknown>> }> {
	const originalFetch = globalThis.fetch;
	const requests: Array<Record<string, unknown>> = [];
	process.env.TEST_API_KEY = "test-key"; // resolved before fetch; must exist up front
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return body instanceof Response ? body : sseResponse(body);
	}) as typeof fetch;
	try {
		const result = await run();
		return { result, requests };
	} finally {
		globalThis.fetch = originalFetch;
		delete process.env.TEST_API_KEY;
	}
}

test("openai: maps context, streams text, maps usage and cost", async () => {
	const messages: Message[] = [
		{ role: "user", content: "hello", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "hi" }], model: "test-model", stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0 }, timestamp: 2 },
	];
	const { result, requests } = await withStubbedFetch(
		[
			{ choices: [{ delta: { content: "hel" } }] },
			{ choices: [{ delta: { content: "lo" } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } } },
		],
		async () => {
			const stream = streamOpenAi(testModel)({ messages });
			const final = await stream.result();
			return final;
		},
	);

	assert.equal(result.content[0].type === "text" ? result.content[0].text : "", "hello");
	assert.equal(result.stopReason, "stop");
	assert.equal(result.usage.input, 100);
	assert.equal(result.usage.output, 50);
	assert.equal(result.usage.cacheRead, 20);
	assert.ok(result.usage.cost && result.usage.cost.total > 0);

	const request = requests[0];
	const sentMessages = request.messages as Array<Record<string, unknown>>;
	assert.equal(sentMessages[0].role, "user");
	assert.equal(sentMessages[1].role, "assistant");
	assert.equal(request.stream, true);
	assert.equal(request.model, "test-model");
});

test("openai: assembles fragmented tool call arguments", async () => {
	const { result } = await withStubbedFetch(
		[
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "echo", arguments: "" } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"te' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"hi"}' } }] } }] },
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		],
		async () => streamOpenAi(testModel)({ messages: [{ role: "user", content: "go", timestamp: 1 }] }).result(),
	);

	assert.equal(result.stopReason, "toolUse");
	const call = result.content.find((c) => c.type === "toolCall");
	assert.ok(call && call.type === "toolCall");
	assert.equal(call.name, "echo");
	assert.deepEqual(call.arguments, { text: "hi" });
});

test("openai: maps assistant tool call + tool result back to the wire", async () => {
	const messages: Message[] = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hi" } }],
			model: "test-model",
			stopReason: "toolUse",
			usage: { input: 0, output: 0, totalTokens: 0 },
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "echo",
			content: [{ type: "text", text: "echo: hi" }],
			isError: false,
			timestamp: 2,
		},
	];
	const { requests } = await withStubbedFetch([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }], async () =>
		streamOpenAi(testModel)({ messages }).result(),
	);
	const sent = requests[0].messages as Array<Record<string, unknown>>;
	assert.equal(sent[0].role, "assistant");
	const wireCalls = sent[0].tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
	assert.equal(wireCalls[0].id, "call_1");
	assert.equal(wireCalls[0].function.name, "echo");
	assert.equal(sent[1].role, "tool");
	assert.equal(sent[1].tool_call_id, "call_1");
});

test("openai: HTTP errors become error messages, never throws", async () => {
	const errorResponse = new Response("quota exceeded", { status: 429 });
	const { result } = await withStubbedFetch(errorResponse, async () =>
		streamOpenAi(testModel)({ messages: [] }).result(),
	);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /429/);
	assert.match(result.errorMessage ?? "", /quota exceeded/);
});

test("openai: missing API key is an error message", async () => {
	const stream = streamOpenAi(testModel)({ messages: [] }, { apiKey: undefined });
	// ensure env var absent
	delete process.env.TEST_API_KEY;
	const result = await stream.result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /TEST_API_KEY/);
});

test("anthropic: streams text and tool_use blocks", async () => {
	const { result, requests } = await withStubbedFetch(
		[
			{ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 3 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sure" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "echo" } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"text"' } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ':"x"}' } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
			{ type: "message_stop" },
		],
		async () => streamAnthropic(testModel)({ messages: [{ role: "user", content: "go", timestamp: 1 }] }).result(),
	);

	assert.equal(result.stopReason, "toolUse");
	const text = result.content.find((c) => c.type === "text");
	const call = result.content.find((c) => c.type === "toolCall");
	assert.ok(text && text.type === "text" && text.text === "sure");
	assert.ok(call && call.type === "toolCall" && call.id === "tu_1" && call.arguments.text === "x");
	assert.equal(result.usage.input, 10);
	assert.equal(result.usage.output, 7);
	assert.equal(result.usage.cacheRead, 3);

	const request = requests[0];
	assert.equal(request.system, undefined); // no system prompt given
	assert.equal((request.max_tokens as number) > 0, true);
});

test("anthropic: tool results merge into one user turn", async () => {
	const messages: Message[] = [
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tu_1", name: "a", arguments: {} },
				{ type: "toolCall", id: "tu_2", name: "b", arguments: {} },
			],
			model: "test-model",
			stopReason: "toolUse",
			usage: { input: 0, output: 0, totalTokens: 0 },
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "tu_1",
			toolName: "a",
			content: [{ type: "text", text: "result-a" }],
			isError: false,
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "tu_2",
			toolName: "b",
			content: [{ type: "text", text: "result-b" }],
			isError: false,
			timestamp: 3,
		},
	];
	const { requests } = await withStubbedFetch([{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "message_stop" }], async () =>
		streamAnthropic(testModel)({ messages }).result(),
	);
	const sent = requests[0].messages as Array<{ role: string; content: Array<{ type: string }> }>;
	const toolTurns = sent.filter((m) => m.role === "user" && m.content[0]?.type === "tool_result");
	assert.equal(toolTurns.length, 1);
	assert.equal(toolTurns[0].content.length, 2);
});

test("splitThinkTags: handles split/unclosed/absent tags", async () => {
	const { splitThinkTags } = await import("@puck-agent/llm");
	assert.deepEqual(splitThinkTags("<think>推理</think>\n\n答案"), { thinking: "推理", text: "\n\n答案" });
	assert.deepEqual(splitThinkTags("<think>还没结"), { thinking: "还没结", text: "" });
	assert.deepEqual(splitThinkTags("普通"), { thinking: "", text: "普通" });
	assert.deepEqual(splitThinkTags("前<think>x</think>后"), { thinking: "x", text: "前后" });
});

test("mock: scripts stream, consume steps per call, and handle abort", async () => {
	const streamFn = createMockStreamFn([
		{ text: "first", toolCalls: [{ name: "x", arguments: {} }] },
		{ text: "second" },
	]);

	const first = await streamFn({ messages: [] }).result();
	assert.equal(first.stopReason, "toolUse");
	assert.equal(first.content.find((c) => c.type === "text")?.type === "text" ? (first.content[0] as { text: string }).text : "", "first");

	const second = await streamFn({ messages: [] }).result();
	assert.equal(second.stopReason, "stop");

	const exhausted = await streamFn({ messages: [] }).result();
	assert.match((exhausted.content[0] as { text: string }).text, /script complete/);
});

test("contextWindowFor: known table > /models-reported > 128k default", () => {
	assert.equal(contextWindowFor("MiniMax-M3"), 1_000_000);
	assert.equal(contextWindowFor("glm-5.3"), 1_000_000);
	assert.equal(contextWindowFor("GLM-5.2"), 1_000_000);
	assert.equal(contextWindowFor("claude-sonnet-4-5"), 200_000);
	assert.equal(contextWindowFor("gpt-5.2"), 400_000);
	assert.equal(contextWindowFor("totally-unknown"), 128_000);
	// a model the table doesn't know picks up a /models-reported value
	recordContextWindow("weird-model-v9", 512_000);
	assert.equal(contextWindowFor("weird-model-v9"), 512_000);
	// the known table still wins over a stale /models value
	recordContextWindow("MiniMax-M3", 8_000);
	assert.equal(contextWindowFor("MiniMax-M3"), 1_000_000);
	// resolver wires it into the wire model
	assert.equal(resolveModel("minimax-cn/MiniMax-M3").contextWindow, 1_000_000);
});

test("anthropic adapter: no double /v1 in the messages URL", async () => {
	// Local SSE server captures the request path once the stream starts.
	const seen: string[] = [];
	const server = http.createServer((req, res) => {
		seen.push(req.url ?? "");
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n`);
		res.write(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n`);
		res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n`);
		res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
		res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;

	const model = defineModel({
		id: "test-claude",
		name: "Test Claude",
		provider: "anthropic",
		api: "anthropic",
		baseUrl: `http://127.0.0.1:${port}/v1`, // registry style: baseUrl carries /v1
		contextWindow: 128_000,
		apiKeyEnv: "TEST_ANTHROPIC_KEY",
	});
	try {
		const stream = streamAnthropic(model, undefined)({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { apiKey: "k" });
		const final = await stream.result();
		assert.equal(final.stopReason, "stop");
		assert.equal(seen[0], "/v1/messages");
	} finally {
		server.close();
	}
});

test("openai adapter: abort mid-stream reports stopReason 'aborted'", async () => {
	const controller = new AbortController();
	const server = http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: {"choices":[{"delta":{"content":"par"}}]}\n\n`);
		// never finish — the client aborts while waiting for more
		res.on("close", () => undefined);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;

	const model = defineModel({ id: "m", name: "m", baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: "X", contextWindow: 128_000 });
	try {
		const stream = streamOpenAi(model, undefined)({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { apiKey: "k", signal: controller.signal });
		const pending = stream.result();
		await new Promise((r) => setTimeout(r, 150));
		controller.abort();
		const final = await pending;
		assert.equal(final.stopReason, "aborted");
	} finally {
		server.close();
	}
});

test("resolveModel: bare id routes by model family, then single-usable-provider, else Ambiguous", () => {
	// no env keys of any provider → family-known ids route home (honest
	// "未配置 key" later); unknown ids are Ambiguous, never the first registry entry
	const saved: Record<string, string | undefined> = {};
	for (const name of ["DASHSCOPE_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "MOONSHOT_API_KEY", "ZAI_API_KEY"]) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
	const savedHome = process.env.PUCK_HOME;
	const home = mkdtempSync(join(tmpdir(), "puck-resolve-")); // isolate from the real auth.json
	process.env.PUCK_HOME = home;
	try {
		// glm-5.3 belongs to ZAI — even with a minimax key stored too (the exact
		// "usable keys: minimax-cn, zai" report that motivated the family table)
		writeFileSync(join(home, "auth.json"), JSON.stringify({ "minimax-cn": "k1", zai: "k2" }));
		assert.equal(resolveModel("glm-5.3").provider, "zai");
		assert.equal(resolveModel("MiniMax-M3").provider, "minimax-cn");
		// family home even without any key (missing-key warning beats wrong vendor)
		writeFileSync(join(home, "auth.json"), JSON.stringify({}));
		assert.equal(resolveModel("deepseek-chat").provider, "deepseek");
		// unknown family with zero usable keys → Ambiguous
		assert.throws(() => resolveModel("totally-unknown-model"), /Ambiguous/);
		// single usable provider still binds non-family ids
		writeFileSync(join(home, "auth.json"), JSON.stringify({ deepseek: "k" }));
		assert.equal(resolveModel("totally-unknown-model").provider, "deepseek");
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		if (savedHome === undefined) delete process.env.PUCK_HOME;
		else process.env.PUCK_HOME = savedHome;
	}
});

test("thinkingEffort: openai → reasoning_effort; zai → thinking.type; off only for zai", async () => {
	const bodies: Array<{ url: string; body: Record<string, any> }> = [];
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			bodies.push({ url: req.url ?? "", body: JSON.parse(raw) });
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`);
			res.write(`data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const generic = defineModel({ id: "m", name: "m", baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: "X", contextWindow: 128_000 });
	const glm = defineModel({ id: "glm-5.3", name: "g", provider: "zai-coding-cn", baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: "X", contextWindow: 128_000 });
	const messages = [{ role: "user" as const, content: "hi", timestamp: 0 }];
	try {
		await streamOpenAi(generic, undefined)({ messages }, { apiKey: "k", thinkingEffort: "low" }).result();
		await streamOpenAi(glm, undefined)({ messages }, { apiKey: "k", thinkingEffort: "high" }).result();
		await streamOpenAi(glm, undefined)({ messages }, { apiKey: "k", thinkingEffort: "off" }).result();
		await streamOpenAi(generic, undefined)({ messages }, { apiKey: "k", thinkingEffort: "off" }).result();
		assert.equal(bodies[0].body.reasoning_effort, "low");
		assert.deepEqual(bodies[1].body.thinking, { type: "enabled" });
		assert.deepEqual(bodies[2].body.thinking, { type: "disabled" });
		assert.equal(bodies[3].body.reasoning_effort, undefined, "generic off → no param");
	} finally {
		server.close();
	}
});

test("thinkingTags model: reasoning_content stream is not clobbered by the <think> split (GLM coding endpoints)", async () => {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		// GLM coding style: reasoning via reasoning_content, answer via content
		res.write(`data: {"choices":[{"delta":{"reasoning_content":"The user wants "}}]}\n\n`);
		res.write(`data: {"choices":[{"delta":{"reasoning_content":"a greeting."}}]}\n\n`);
		res.write(`data: {"choices":[{"delta":{"content":"你好！"}}]}\n\n`);
		res.write(`data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	// thinkingTags ON + zero inline <think> in content — the old code clobbered
	// reasoning to "" on every partial
	const model = defineModel({ id: "glm-t", name: "t", provider: "zai-coding-cn", baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: "X", contextWindow: 128_000, thinkingTags: true });
	const partials: string[] = [];
	try {
		const stream = streamOpenAi(model, undefined)({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { apiKey: "k" });
		for await (const event of stream) {
			if (event.type === "delta") {
				const think = event.partial.content.find((c): c is { type: "thinking"; thinking: string } => c.type === "thinking");
				if (think) partials.push(think.thinking);
			}
		}
		const final = await stream.result();
		const finalThink = final.content.find((c): c is { type: "thinking"; thinking: string } => c.type === "thinking");
		assert.equal(finalThink?.thinking, "The user wants a greeting.");
		assert.ok(partials.length >= 2 && partials[0] === "The user wants ", `partials streamed: ${JSON.stringify(partials)}`);
	} finally {
		server.close();
	}
});
