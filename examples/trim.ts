/**
 * 功能裁切演示：同一个 SDK 入口，三种裁切形态。
 *
 * 运行: node --experimental-strip-types examples/trim.ts
 */

import { createPuck } from "@puck-agent/sdk";
import { createMockStreamFn } from "@puck-agent/llm";

// ── 形态 1：全功能（工具 + 会话持久化 + 审批）─────────────────────────
const full = createPuck({
	model: "mock",
	streamFn: createMockStreamFn([{ text: "全功能形态就绪" }]),
	tools: "coding",
	session: false, // 演示环境不落盘；真实项目传 { dir: ".puck/sessions" }
	approval: { policy: (call) => call.toolName === "bash", ask: () => true },
});
console.log("[1] 全功能:", (await full.run("hi")).text);

// ── 形态 2：无工具的纯对话 agent（客服/摘要/提取类项目）──────────────
const chat = createPuck({
	model: "mock",
	streamFn: createMockStreamFn([{ text: "纯对话形态就绪" }]),
	tools: "none",
	session: false,
});
console.log("[2] 纯对话:", (await chat.run("hi")).text);

// ── 形态 3：只要一个自定义工具（最小嵌入）────────────────────────────
const search = createPuck({
	model: "mock",
	streamFn: createMockStreamFn([
		{ toolCalls: [{ name: "search", arguments: { q: "puck" } }] },
		{ text: "搜到 3 条结果" },
	]),
	tools: [
		{
			name: "search",
			description: "搜索知识库",
			parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
			async execute(args) {
				return { content: [{ type: "text", text: `results for ${(args as { q: string }).q}: ...` }] };
			},
		},
	],
	session: false,
});
const result = await search.run("搜一下 puck");
console.log("[3] 单工具:", result.text, "| 用了工具:", result.messages.some((m) => m.role === "toolResult"));
