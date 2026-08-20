# puck

> **极简、可任意裁切的 agent harness。** 与 pi、codex、DeepSeek Harness、Claude Code CLI 同一类工具，但走了一条不一样的路：核心 700 行，零依赖，按目录物理裁切。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node ≥ 22.18](https://img.shields.io/badge/node-%E2%89%A522.18-brightgreen)](./package.json)
[![Tests](https://img.shields.io/badge/tests-150%20pass-success)](./tests)
[![Zero deps](https://img.shields.io/badge/runtime%20deps-0-blueviolet)](./packages/core)
[![npm version](https://img.shields.io/npm/v/puck-harness.svg)](https://www.npmjs.com/package/puck-harness)
[![GitHub stars](https://img.shields.io/github/stars/puckguo/puck-harness)](https://github.com/puckguo/puck-harness)

```bash
npm install -g puck-harness                   # CLI
npm install @puckguo123/core                 # or just the agent loop, no UI
```

```ts
import { createPuck } from "@puckguo123/sdk";
const puck = createPuck({ model: "deepseek-chat", tools: "coding" });
const { text } = await puck.run("解释一下这个仓库");
```

**150 个测试全部离线通过 · 零网络 · 0 运行时依赖**

[English](#english) · [对比表](#puck-vs-其他-agent-harness) · [架构](#架构) · [安装](#安装) · [使用](#使用)

---

<a id="english"></a>

## What is puck?

puck is an agent harness — the engine that turns an LLM into a coding agent (think: Claude Code, but you can read the whole source in one sitting). It's the smallest viable form of the idea, and every package is independently deletable.

If you've used `pi`, `codex`, `DeepSeek Harness`, or `Claude Code CLI`, you know what this is. puck is for people who want the same capability **and** want to understand / modify / embed the engine itself.

```ts
// Minimal: just the agent loop, no LLM wiring
import { Agent } from "@puckguo123/core";

// Or one-call setup with everything
import { createPuck } from "@puckguo123/sdk";
```

---

## puck vs 其他 agent harness

四个项目的设计选择截然不同。puck 不是要替代谁，而是填补"想看完整代码 / 想改核心 / 想嵌进自己的运行时"这个空白。

| 维度 | **puck** | [pi](https://github.com/badlogic/pi-mono) | [Codex CLI](https://github.com/openai/codex) | [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) | Claude Code CLI |
|---|---|---|---|---|---|
| 核心代码（不含测试） | **~700 行** | ~3000 行 | ~15000 行 | ~5000 行 | 闭源 |
| 运行时依赖 | **0** | 0 | 大量（含 ripgrep） | 中等 | 闭源 |
| 安装体积 | **~50KB** CLI | ~2MB | ~50MB | ~10MB | 闭源 |
| LLM provider | 30+ 内置，OpenAI 兼容 + Anthropic | 自家抽象层 | OpenAI 优先 | DeepSeek 优先 | Anthropic only |
| 裁切单位 | **目录**（删即用） | npm 子包 | 不可裁切 | 插件 | 不可 |
| 子进程沙箱 | 不强加 | 不强加 | **强制**（Linux Landlock） | 不强加 | 强制（macOS sbpl） |
| 跨 harness 导入会话 | **pi / claude / codex** | 无 | 无 | 无 | 无 |
| 持久记忆（经验/长期） | **有**（自动蒸馏 + 空闲后台任务） | agent.md 上下文 | 无 | 无 | CLAUDE.md 上下文 |
| 上一轮总结常驻底栏 | **有**（标题+一句话+文件足迹） | 无 | 无 | 无 | 无 |
| 会话格式 | 追加式 JSONL | JSONL | JSONL | JSONL | JSONL |
| 协议层 | `AgentEvent` 流 + `StreamFn` | `StreamFn` | OpenAI 协议 | OpenAI 协议 | Anthropic SDK |
| Web UI | 零构建 SSE（[可选](packages/web)） | 无 | 需打包 | 无 | 无 |
| License | MIT | MIT | Apache-2.0 | MIT | 闭源 |

**详细对比（含架构图、功能矩阵、选型指南）**：[docs/harness-comparison.html](docs/harness-comparison.html)（浏览器打开）

### 一句话定位

- **pi** 把 agent 拆成可替换的 npm 子包——你装哪个用哪个
- **codex** 是工业级沙箱，安全性第一，**不能改核心**
- **DeepSeek Harness** 是插件平台，生态丰富，但底层偏紧耦合
- **Claude Code CLI** 是 Anthropic 官方闭源产品，能力最强但**不可审计**
- **puck** 把"读懂 / 改核心 / 嵌进自己项目"作为第一公民——核心 700 行、零依赖、按目录删

---

## 为什么做 puck

读 pi 的源码时，3000 行的核心仍然让人望而生畏；用 codex 时，OpenAI 协议锁死了非 OpenAI 厂商的接入姿势；用 DeepSeek Harness 时，每个功能都嵌套在主包内部、删不干净；用 Claude Code 时，闭源让你不得不相信它做对了所有事情。

puck 假设一种用户：**想搞清楚 agent loop 到底怎么工作的人**。所以：

1. **核心 700 行**——一个晚上读完
2. **零依赖**——`Agent` 类只依赖 Node 标准库
3. **按目录删**——`rm -rf packages/features/src/subagent` 然后 `tsc -b`，构建依然通过
4. **每个包都能独立装**——`npm install @puckguo123/core` 就能在自己项目里嵌入 agent loop

### 什么时候**不**用 puck

- 需要企业级沙箱审计 → 用 codex
- 要 Anthropic 官方深度优化 → 用 Claude Code CLI
- 要用现成的生态插件市场 → 用 DeepSeek Harness
- 想要可替换的 npm 子包架构 → 用 pi
- 想要闭源但功能最全 → 用 Claude Code CLI

### 什么时候**用** puck

- **教学**：让学生读懂 agent loop → 看 700 行
- **嵌入**：在自己产品（游戏引擎、浏览器扩展、CI 工具）里加 agent 能力 → `npm install @puckguo123/core`
- **审计**：想确保 agent 没在背后做什么 → 读源码，零依赖
- **裁切**：项目只要 LLM + bash + read 三个能力 → `rm -rf packages/features` 删掉整个 features 目录
- **跨工具会话合并**：从 pi / codex / claude 切到 puck 不用重做历史 → `/resume` 一键导入

---

## 架构

```
┌────────────────────────── cli（可删）──────────────────────────┐
│  sdk  createPuck() 组装门面（可删，直接用底层包）                │
├──────────┬──────────┬───────────────┬──────────────────────────┤
│  llm     │  tools   │  session      │  features（四个独立目录）  │
│  openai  │  bash    │  JSONL 日志    │  compaction  上下文压缩   │
│  anthropic│  read   │  追加式/可回放  │  subagent    多 agent     │
│          │  write   │  跨 harness 导入│  skills      技能包       │
│          │  edit    │               │  approval    审批门       │
├──────────┴──────────┴───────────────┴──────────────────────────┤
│  core:  types / loop(纯函数) / Agent(状态) / validate           │
│         唯一必须理解的部分，约 700 行                             │
└────────────────────────────────────────────────────────────────┘
```

**核心循环**：`user → LLM → assistant →(toolCalls)→ tools → results ↺`，
事件协议 `run → turn → message(流式) → tool` 四层，
`StreamFn` 永不 throw（失败编码为 `stopReason: "error"` 的消息），
`transformContext` 把 LLM 视图投影与 canonical transcript 分离。

### 11 个包一览

| 包 | 作用 | 依赖 |
|---|---|---|
| [`@puckguo123/core`](packages/core) | agent loop、消息模型、事件流 | 零 |
| [`@puckguo123/llm`](packages/llm) | OpenAI 兼容 / Anthropic 适配器 | 零 |
| [`@puckguo123/session`](packages/session) | JSONL 持久化 + 跨 harness 导入 | 零 |
| [`@puckguo123/tools`](packages/tools) | bash / read / write / edit | 零 |
| [`@puckguo123/features`](packages/features) | compaction / subagent / skills / approval | 零 |
| [`@puckguo123/timing`](packages/timing) | per-turn 延迟指标 | 零 |
| [`@puckguo123/store`](packages/store) | 会话索引（sqlite） | core |
| [`@puckguo123/memory`](packages/memory) | agent.md 上下文加载 / 经验蒸馏 | core + store |
| [`@puckguo123/sdk`](packages/sdk) | createPuck() 高层门面 | 全部底层包 |
| [`@puckguo123/web`](packages/web) | SSE Web 服务 | sdk + 底层 |
| [`puck-harness`](packages/cli) | CLI 入口（npm: `puck-harness`，bin: `puck`） | 全部 |

---

## 安装

### CLI（推荐大多数人从这里开始）

```bash
npm install -g puck-harness
puck --help
puck "读一下 package.json，总结这个项目"
```

### 嵌入到你自己的项目

```bash
npm install @puckguo123/core
```

```ts
import { Agent } from "@puckguo123/core";

const agent = new Agent({
  systemPrompt: "You are a careful code reviewer.",
  streamFn: async (messages, signal) => {
    // your own LLM call here; yield AgentEvent objects
  },
  tools: [myBashTool, myReadTool],
});

for await (const ev of agent.iterate("review src/foo.ts")) {
  if (ev.type === "message_update" && ev.message.role === "assistant") {
    process.stdout.write(ev.message.text ?? "");
  }
}
```

完整分层用法见 [docs/usage.md](docs/usage.md)。

---

## 使用

### CLI 命令

```bash
puck "读一下 package.json，总结这个项目"
puck --model deepseek-chat "重构 src/utils.ts"
puck /login anthropic                        # 存 API key 到 ~/.puck/auth.json
puck /resume                                 # 合并显示 puck + pi + claude + codex 会话
puck /clear                                  # 清空当前会话（标记而非删除）
puck /status
puck /help
puck /quit
```

### CLI 特色：常驻信息层

终端底部固定四层信息，不用翻历史就能知道"刚才发生了什么"：

```
┌─────────────────────────── 滚动区 ───────────────────────────┐
│  对话主区（thinking 灰显、工具调用折叠、流式输出）              │
└──────────────────────────────────────────────────────────┘
  上两行   上一轮总结（标题 + 一句话结果，按显示宽度折行）
  下一行   文件足迹（本轮 agent 改过哪些文件，最新在前）
  最后一行   状态栏（cwd · 轮次/工具数 · 模型）
```

- **上一轮任务总结**：每轮结束自动生成——终端标题栏放短语（≤ 10 字），底栏放一句话结果（含改动文件、成败）；`/resume` 恢复会话时也会重建这个总结，接上上次的工作
- **文件足迹**：agent 触碰过的文件实时列在底栏，review 改动不用猜
- **队列输入**：agent 运行中直接打字，下一轮自动送入；以 `!` 或 `！` 开头则立即插队，打断当前轮把消息送进去
- **终端标题动画**：运行时显示"puck · 正在做的事"，空闲时显示上一轮总结

### 记忆系统

会话之外的持久化记忆，启动时自动注入 system prompt：

| 层 | 内容 | 来源 |
|---|---|---|
| 全局偏好 | 你的个人习惯（语言、风格、默认工具） | `~/.puck/agent.md` |
| 项目说明 | 项目结构、约定、注意事项 | 从 cwd 向上找 `agent.md` / `AGENTS.md`（兼容 pi/codex 约定，现有仓库直接能用） |
| 经验记忆 | 自动蒸馏的操作经验（有上限，超出归档） | `~/.puck/experience.md`（自动维护） |
| 长期记忆 | 沉淀后的稳定结论 | `~/.puck/long-term.md`（自动维护） |

**后台任务（空闲时自动跑，无 daemon / 无 cron）**：

- 每日总结——把当天的会话汇总成 `~/.puck/memories/YYYY-MM-DD.md`（episodic 记忆）
- 经验蒸馏——把新会话中有价值的教训合并进 `experience.md`（semantic 记忆）
- 任务只在 REPL 空闲时运行（默认闲置 20 秒），不阻塞输入；关机错过会在下次启动补跑
- 所有送到 LLM 的内容先过 `redact()`，API key 模式自动打码
- `/memory` 查看当前注入了什么，`/tasks` 查看后台任务目录与状态

### SDK 一次性装配

```ts
import { createPuck } from "@puckguo123/sdk";

const puck = createPuck({
  model: "deepseek-chat",        // 或 getModel/defineModel 自定义端点
  tools: "coding",               // bash + read + write + edit
  session: { dir: ".puck/sessions" },
});

const { text, usage } = await puck.run("读一下 package.json，总结这个项目");
```

### 流式事件

```ts
for await (const event of puck.iterate("重构 src/utils.ts")) {
  if (event.type === "tool_start") console.log("▶", event.toolName);
  if (event.type === "message_update" && event.message.role === "assistant") {
    // 增量渲染助手文本
  }
}
```

### 更底层（不用 SDK，只用核心）

```ts
import { Agent } from "@puckguo123/core";
import { createStreamFn, getModel } from "@puckguo123/llm";

const agent = new Agent({
  systemPrompt: "...",
  tools: [myTool],
  streamFn: createStreamFn(getModel("claude-sonnet-4-5")),
});
```

---

## 模型

内置 30 个 provider：`deepseek-chat` / `gpt-4o` / `claude-sonnet-4-5` / `kimi-k2` / `qwen-plus` / `MiniMax-M3` / `glm-5.x` / `ollama` / `vllm` / `lmstudio` / `openrouter` / ...

模型列表**登录后从 `GET {baseUrl}/models` 实时拉取**——新模型不写代码就出现，目录永不过时。

任何 OpenAI 兼容端点用 `defineModel()`：

```ts
import { defineModel, createStreamFn } from "@puckguo123/llm";

const local = defineModel({
  id: "qwen3:32b", name: "Qwen3 32B",
  baseUrl: "http://localhost:11434/v1", apiKeyEnv: "OLLAMA_API_KEY",
  contextWindow: 131072,
});
```

---

## 跨 harness 会话导入

`/resume` 自动扫描 `~/.pi`、`~/.claude`、`~/.codex`，把外部会话按 cwd 对齐到当前项目，带来源角标显示（`[pi]` / `[claude]` / `[codex]`），选中后透明导入（copy-on-import，不动原文件；重复导入自动复用）。

```bash
puck /resume    # 默认仅当前项目；按 a 切换"全部目录"
```

会话格式是追加式 JSONL——可以 `cat .puck/sessions/*.jsonl` 手动审计，可以 `tail -f` 跟踪进度。

---

## 测试

```bash
npm test                # 150 个测试全部通过，零网络依赖
npm run typecheck       # tsc --noEmit
npm run audit:publish   # 发布前自检：metadata + tarball + API key 扫描
```

---

## Web 端

**[@puckguo123/web](packages/web)** — 零依赖 HTTP/SSE 服务器 + 零构建浏览器 UI，把完整 harness 暴露到网页端：`puck-web`（[http://127.0.0.1:8787](http://127.0.0.1:8787)）。协议就是 core 的 `AgentEvent` 逐帧 SSE，UI 复刻 CLI term.ts 的视觉语言（thinking 灰显、工具折叠、状态栏、会话恢复回放）。

---

## 裁切

不需要的功能物理删除：[docs/trimming.md](docs/trimming.md) 给出完整指南。常见路径：

- 不需要 subagent？`rm -rf packages/features/src/subagent` → `tsc -b` 仍然成功
- 不需要持久化？`rm -rf packages/session` → CLI 用 `--no-session` 模式跑
- 不需要 web？`rm -rf packages/web` → 不影响 CLI / SDK

puck 的每个 npm 包都是**独立可装的**——你不必为了用 core 而带一堆东西。

---

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). For security issues, see [SECURITY.md](./SECURITY.md).

## Links

- 详细对比：[docs/harness-comparison.html](docs/harness-comparison.html)
- 完整使用文档：[docs/usage.md](docs/usage.md)
- 性能评估协议：[docs/benchmarking.md](docs/benchmarking.md)
- 裁切指南：[docs/trimming.md](docs/trimming.md)
- Issues: <https://github.com/puckguo/puck-harness/issues>
