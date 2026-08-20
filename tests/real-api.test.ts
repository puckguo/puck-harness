/**
 * 真实 LLM API 集成测试 —— 打真实网络。
 *
 * 需要环境变量 MINIMAX_API_KEY（MiniMax 开放平台，OpenAI 兼容协议）。
 * 未设置时全部跳过，不阻塞离线 CI。
 *
 *   MINIMAX_API_KEY=sk-... node --test tests/real-api.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@puckguo123/core";
import { Agent } from "@puckguo123/core";
import { createStreamFn, getModel, splitThinkTags } from "@puckguo123/llm";
import { createPuck } from "@puckguo123/sdk";

const API_KEY = process.env.MINIMAX_API_KEY;
const MODEL_ID = "MiniMax-M3";
const skip = !API_KEY;

test("real: catalog resolves MiniMax-M3 with thinkingTags", { skip }, () => {
	const model = getModel(MODEL_ID);
	assert.equal(model.thinkingTags, true);
	assert.equal(model.provider, "minimax");
});

test("real: streams a chat completion and splits <think> reasoning", { skip }, async () => {
	const stream = createStreamFn(getModel(MODEL_ID))({
		systemPrompt: "你是简洁的助手，回答控制在20字内。",
		messages: [{ role: "user", content: "1+1等于几？只回答数字。", timestamp: Date.now() }],
	});

	let sawDelta = false;
	let final = null as null | Awaited<ReturnType<typeof stream.result>>;
	for await (const event of stream) {
		if (event.type === "delta") {
			sawDelta = true;
			// 流式过程中 partial 不应把 <think> 泄漏进 text
			const text = event.partial.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
			assert.ok(!text.includes("<think"), `partial text leaked think tag: ${text}`);
		}
	}
	final = await stream.result();
	assert.ok(sawDelta, "expected streaming deltas");
	assert.equal(final.stopReason, "stop");
	assert.ok(!final.errorMessage, final.errorMessage);

	const text = final.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
	const thinking = final.content.filter((c) => c.type === "thinking").map((c) => (c as { thinking: string }).thinking).join("");
	assert.ok(!text.includes("<think"), `final text leaked think tag: ${text}`);
	assert.match(text, /2/);
	// M3 几乎总是思考；若返回了思考，必须已从 text 中剥离
	if (thinking) assert.ok(text.length > 0);
	assert.ok(final.usage.totalTokens > 0, `usage missing: ${JSON.stringify(final.usage)}`);
});

test("real: full tool-call round trip through the agent loop", { skip }, async () => {
	const echoTool: Tool = {
		name: "echo",
		description: "原样返回传入的 text 参数",
		parameters: {
			type: "object",
			properties: { text: { type: "string", description: "要回显的文本" } },
			required: ["text"],
		},
		async execute(args) {
			return { content: [{ type: "text", text: `echo: ${String((args as { text: string }).text)}` }] };
		},
	};

	const agent = new Agent({
		systemPrompt: "你必须使用 echo 工具回显用户给的词，然后把工具返回内容原样告诉用户，不要添加别的字。",
		tools: [echoTool],
		streamFn: createStreamFn(getModel(MODEL_ID)),
		streamOptions: { apiKey: API_KEY, maxTokens: 2048 },
		hooks: { maxTurns: 4 },
	});

	const added = await agent.prompt("请回显: puck-real-test");
	const toolResult = added.find((m) => m.role === "toolResult") as
		| { toolName: string; isError: boolean; content: Array<{ type: string; text: string }> }
		| undefined;

	assert.ok(toolResult, "model should have called the echo tool");
	assert.equal(toolResult.toolName, "echo");
	assert.equal(toolResult.isError, false);
	assert.match(toolResult.content[0].text, /echo: puck-real-test/);

	const final = [...added].reverse().find((m) => m.role === "assistant");
	assert.ok(final && final.role === "assistant" && final.stopReason === "stop");
	const finalText = final.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
	assert.match(finalText, /puck-real-test/);
});

test("real: SDK run with session persistence", { skip }, async () => {
	const dir = "./.puck-real-sessions";
	const puck = createPuck({
		model: MODEL_ID,
		apiKey: API_KEY,
		maxTokens: 2048,
		tools: "none",
		session: { dir, id: "real-1" },
		systemPrompt: "你是简洁助手。回答不超过15个字。",
	});

	const first = await puck.run("我叫小明。记住我的名字。");
	assert.ok(first.text.length > 0);
	assert.ok(first.usage.input > 0);

	// 第二次 run 在同一 session 上继续，验证多轮上下文
	const second = await puck.run("我叫什么名字？");
	assert.match(second.text, /小明/);
});

test("real: wrong API key yields an error message, never throws", { skip }, async () => {
	const stream = createStreamFn(getModel(MODEL_ID))({
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	}, { apiKey: "sk-invalid-key-for-puck-test" });
	const final = await stream.result();
	assert.equal(final.stopReason, "error");
	assert.ok(final.errorMessage && final.errorMessage.length > 0);
});

// splitThinkTags 的纯函数用例（不依赖网络，但和真实协议强相关，放一起便于对照）
test("splitThinkTags contract", () => {
	assert.deepEqual(splitThinkTags("<think>a</think>b"), { thinking: "a", text: "b" });
	assert.deepEqual(splitThinkTags("no tags"), { thinking: "", text: "no tags" });
});
