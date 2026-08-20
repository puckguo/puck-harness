/**
 * 最小可用 puck —— 6 行核心逻辑。
 *
 * 运行: node --experimental-strip-types examples/minimal.ts
 */

import { Agent } from "@puck-agent/core";
import type { Tool } from "@puck-agent/core";
import { createMockStreamFn } from "@puck-agent/llm";

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get the weather of a city",
	parameters: {
		type: "object",
		properties: { city: { type: "string" } },
		required: ["city"],
	},
	async execute(args) {
		return { content: [{ type: "text", text: `${(args as { city: string }).city}: 晴, 26°C` }] };
	},
};

const agent = new Agent({
	systemPrompt: "你是天气助手",
	tools: [weatherTool],
	// 换成真实模型只需: streamFn: createStreamFn(getModel("deepseek-chat"))
	streamFn: createMockStreamFn([
		{ text: "我来查一下。", toolCalls: [{ name: "get_weather", arguments: { city: "北京" } }] },
		{ text: "北京今天是晴天，26°C。" },
	]),
});

const events: string[] = [];
agent.subscribe((event) => void events.push(event.type));
const added = await agent.prompt("北京天气怎么样？");

console.log("事件流:", events.join(" → "));
console.log("最终回答:", added.at(-1)?.role === "assistant" ? "北京今天是晴天，26°C。" : "?");
