/**
 * 离线调试：用 mock 脚本确定性复现一个「模型改文件 → 跑测试 → 汇报」的完整流程。
 *
 * 运行: node --experimental-strip-types examples/debug-mock.ts
 * 零网络依赖 —— mock 每步都固定，适合断点单步、回归测试、CI。
 */

import { Agent } from "@puck-agent/core";
import { createCodingTools } from "@puck-agent/tools";
import { createMockStreamFn, type MockStep } from "@puck-agent/llm";
import { mkdirSync, rmSync } from "node:fs";

// 1) 准备一个干净的工作目录
const workdir = "./.debug-workdir";
rmSync(workdir, { recursive: true, force: true });
mkdirSync(workdir, { recursive: true });

// 2) 编写「模型会说什么、调什么工具」的剧本
const script: MockStep[] = [
	{
		thinking: "用户要一个加法模块，我先写文件。",
		text: "我来创建 add.ts。",
		toolCalls: [
			{
				name: "write",
				arguments: { path: "add.ts", content: "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n" },
			},
		],
	},
	{
		text: "写好了，跑个 node 验证一下。",
		toolCalls: [{ name: "bash", arguments: { command: 'node -e "console.log(require(\'./add.ts\') ? 1 : 1)" 2>&1 || node --experimental-strip-types -e "import(\'./add.ts\').then(m => console.log(\'add(2,3)=\', m.add(2,3)))"' } }],
	},
	{ text: "add.ts 已创建并验证：add(2,3) = 5。" },
];

// 3) 组装 agent 并观察事件
const agent = new Agent({
	systemPrompt: "你是编码助手",
	tools: createCodingTools({ cwd: workdir, only: ["write", "bash"] }),
	streamFn: createMockStreamFn(script),
});

agent.subscribe((event) => {
	if (event.type === "tool_start") console.log("▶ 工具:", event.toolName);
	if (event.type === "tool_end") console.log("◀ 完成:", event.toolName, event.isError ? "❌" : "✅");
	if (event.type === "message_end" && event.message.role === "assistant") {
		const text = event.message.content.find((c) => c.type === "text");
		if (text && text.type === "text" && text.text) console.log("💬", text.text);
	}
});

const added = await agent.prompt("写一个加法函数并验证");
console.log("\n本次 run 消息数:", added.length, "| 最后回答:", added.at(-1)?.role);
