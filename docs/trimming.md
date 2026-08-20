# 裁切指南

puck 的裁切单位是**目录/包**，不是插件。不需要的功能直接删除，构建依然通过。

## 依赖方向（只能向左依赖）

```
core ← llm ← sdk → cli
core ← tools ↗
core ← session ↗
core ← features(compaction|subagent|skills|approval 各自独立) ↗
```

`core` 不依赖任何包。`features` 的四个子目录互不依赖。

## 常见裁切操作

| 不需要 | 操作 | 验证 |
|---|---|---|
| 多 agent | 删 `packages/features/src/subagent`，去掉 `features/package.json` 的 `./subagent` exports 条目 | `npm run build` |
| 上下文压缩 | 删 `packages/features/src/compaction`，同上 | 同上 |
| 技能系统 | 删 `packages/features/src/skills`，同上 | 同上 |
| 审批门 | 删 `packages/features/src/approval`，同上 | 同上 |
| 整个 features | 删 `packages/features`、根 tsconfig references 的对应行、`sdk/tsconfig.json` 与 `sdk/package.json` 中对它的引用，SDK 的 `compaction`/`approval` 参数及实现 | 同上 |
| 会话持久化 | 删 `packages/session`（同上清理 sdk/cli 引用）；运行时不传 `session` 即可不落盘 | 同上 |
| 某个内置工具 | 删 `packages/tools/src/<tool>.ts` 与 index.ts 导出，或运行时 `createCodingTools({ only: ["read"] })` | 同上 |
| 特定 LLM 协议 | 删 `packages/llm/src/anthropic.ts`（或 openai.ts），同步 `createStreamFn` 分发 | 同上 |
| 整个 LLM 层 | 删 `packages/llm`；自写 StreamFn（见下）| 同上 |
| CLI | 删 `packages/cli` | SDK 不受影响 |

## 自定义 StreamFn（替换整个 llm 层）

```ts
import type { AssistantStream, LlmContext, StreamFn } from "@puck-agent/core";

const myStream: StreamFn = (context: LlmContext): AssistantStream => {
	// 调用任意 SDK/HTTP 端点，把结果映射为 AssistantMessage。
	// 契约：永不 throw；失败发 { type: "error", message } 终止事件。
	// 最简实现可以不流式：直接发 start + done 两个事件。
	// 参考实现：packages/llm/src/stream-utils.ts 的 createAssistantStream()
	...
};
```

## 最小核心（删到只剩骨架）

```
packages/core/src/
  types.ts     全部数据模型（消息/工具/事件/钩子）
  loop.ts      循环（≈250 行）
  agent.ts     状态包装（≈150 行）
  validate.ts  工具参数校验
  utils.ts     小工具函数
  index.ts
```

约 700 行 TypeScript，零依赖。这就是必须理解的全集。

## 验证清单

裁切后跑：

```sh
npm run build
node --test tests/core.test.ts   # core 循环回归
# 保留哪些包就跑对应 tests/<pkg>.test.ts
```
