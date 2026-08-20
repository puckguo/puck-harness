# puck 使用指南

## 准备

```bash
cd puck
npm install
npm run build          # 产出 packages/*/dist
```

### API key 两种方式

**方式 A（推荐）：/login 录入，持久化到 `~/.puck/auth.json`（0600 权限）**

```bash
puck                    # 首次运行无 key → 自动进入接入向导（29 家 provider 可选）
puck login              # 或显式登录（不带参数进入交互选择器）
puck login minimax-cn   # 或直接指定 provider
puck › /login           # REPL 内同样支持（无参 = 选择器）
```

接入即厂商：API key 对应 provider（如 MiniMax CN），**模型列表登录后从 `GET /models` 实时拉取**（回车选第一个，或输入编号/模型 id），不绑定具体模型、永不过时。模型引用格式 `provider/model`（如 `minimax-cn/MiniMax-M3`）；裸模型 id 按模型家族路由（glm-→Z.AI（编程套餐优先）、minimax-→MiniMax、deepseek→DeepSeek、kimi→Moonshot、gpt-/claude-→OpenAI/Anthropic…）；不认识的 id 在只有一家 provider 时绑定它，多家时报 `Ambiguous`（REPL 会弹出 provider 选择器）。

已支持 provider（30）：OpenAI / Anthropic / DeepSeek / MiniMax（含 CN）/ Moonshot（含 CN）/ Kimi / Qwen Token Plan×3 / Groq / OpenRouter / Together / Mistral / xAI / NVIDIA / Fireworks / Cerebras / Hugging Face / Vercel / Xiaomi / ZAI（含编程套餐 CN 端点）/ Ant Ling / OpenCode Zen / Google，以及本地 Ollama / vLLM / LM Studio。

**方式 B：环境变量（按所用模型设置其一）**

| 模型 | 环境变量 |
|---|---|
| `MiniMax-M3` | `MINIMAX_API_KEY` |
| `deepseek-chat` / `deepseek-reasoner` | `DEEPSEEK_API_KEY` |
| `gpt-4o` / `gpt-4o-mini` | `OPENAI_API_KEY` |
| `claude-sonnet-4-5` / `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |
| `kimi-k2-0905-vision-preview` | `MOONSHOT_API_KEY` |
| `qwen-plus` | `DASHSCOPE_API_KEY` |

也可以不用环境变量：CLI 不支持（后续可加 `--api-key`），SDK 用 `apiKey` 参数传入。

---

## CLI 使用

入口：`node packages/cli/dist/index.js`（可 `npm run cli`），四种玩法：

```bash
# 1. 一次性任务：给 prompt，跑完退出
node packages/cli/dist/index.js "读一下 README.md，总结这个项目"

# 2. 交互式 REPL（输入 exit 退出）
node packages/cli/dist/index.js

# 3. 指定模型
node packages/cli/dist/index.js --model MiniMax-M3 "写一个快速排序"
#    或用环境变量：PUCK_MODEL=deepseek-chat puck

# 4. 离线演示（零网络、零 key，脚本化模型）
node packages/cli/dist/index.js --mock
```

会话自动存到 `./.puck/sessions/*.jsonl`。用 `--session <id>` 继续某次会话（id 存在则自动加载历史续聊，不存在则以该 id 新建）：

```bash
node packages/cli/dist/index.js --session abc123 "接着刚才的任务继续"
```

（id 是 sessions 目录下的文件名去掉 `.jsonl`）

REPL 里可用命令：直接输入对话；`exit` / `quit` 退出；斜杠命令：

```
/login [provider]    录入 API key（无参列出所有 provider 供选）
/logout <provider>   删除已存 key
/models              列出模型 + key 状态（✓ saved / ~ env / ✗ no key）
/model <id>          切换模型（本会话生效 + 存为默认）
/think [off|low|medium|high]  调整 thinking 等级（下一轮生效；off 仅对支持开关的 API 生效，如 GLM）
/compact              手动压缩上下文（摘要折叠旧对话，保留最近 ~10 条；bar 的 ctx% 即时更新）
/clear                清空上下文开始新对话（原会话保留在磁盘，/resume 可找回）
/status              当前模型 / key 存储 / 会话
/help
```

模型选择优先级：`--model` > `PUCK_MODEL` 环境变量 > `~/.puck/config.json` 的 defaultModel > 内置默认。key 解析优先级：显式 apiKey 参数 > auth.json > 环境变量。CLI 内置 bash/read/write/edit 四个工具，在**当前工作目录**运行（含子目录访问，默认不许越出 cwd）。

---

## 终端体验

交互模式下（TTY）：

- **斜杠命令菜单**：输入 `/` 立即显示全部命令及说明，继续输入按前缀过滤、首项高亮；提交后菜单自动清除。
- **底部状态栏**：常驻显示当前目录（~ 压缩）、会话累计 `↑输入 ↓输出` tokens、上下文占用百分比（>70% 黄、>90% 红）、当前模型；每轮对话和 `/model` 切换后即时更新。窄终端自动丢弃 cwd → stats，模型名永远保留。
- **输出配色**：模型 thinking 浅灰、正文默认色、执行的命令品红（`$ cmd`）、文件路径亮蓝、工具成功绿 ✅ / 失败红 ❌、统计行暗色。管道/一次性模式自动无色。
- **输入历史**：↑/↓ 翻阅历史输入，跨会话保存在 ~/.puck/history（最多 500 条）。
- **等待反馈**：LLM 静默期显示 `⠹ thinking … 1.3s`（刷新计时），出字即消失。
- **工具可视化**：edit 显示红绿 diff（`- old`/`+ new`）；工具结果显示前 3 行（`│ ` 前缀）+ `└─ +M more` 折叠。
- **Ctrl+C 保护**：运行中第一次 Ctrl+C 只提示（不打断流），3 秒内再按才退出；空闲时直接退出。
- **Turn 分隔线**：每次提问前画一条暗色 `───`，scrollback 中各轮对话边界清晰。
- **/resume 会话恢复**：列出历史会话（标题 = 首条提问、轮次、工具次数、compact ×N、模型、相对时间），选择继续旧对话；transcript 与压缩历史自动恢复，且**历史会回放到终端**（you › 回显、灰显思考、工具行、折叠输出，与实况渲染完全一致），文件轨迹行、终端标题与底栏的上轮总结也一并水合。
- **thinking 灰显**：模型的思考过程以灰色实时流式显示（GLM 的 reasoning_content、inline <think>、DeepSeek reasoning 三种协议自动兼容），正文前自动换行分隔。
- **记忆系统**：启动自动读 `~/.puck/agent.md`（全局）与项目 `agent.md`/`AGENTS.md`（向上遍历），连同自动归纳的 `experience.md` 注入系统提示；全部对话实时入 `~/.puck/index.db`（sqlite）；空闲 20s 自动运行后台任务（`/tasks` 查看目录列表）——每日总结当天全部对话到 `memories/` 并蒸馏经验到 `experience.md`；每周将近期日总结蒸馏为长期记忆 `long-term.md`（用户偏好/项目事实/工作流）。`/memory` 查看记忆源，`/recall <词>` 跨项目搜历史（箭头选择命中，每行右侧显示项目目录；Enter 查看该消息前后各 4 条对话上下文，Esc 取消）。`--no-memory` 或 config.json `memory.enabled=false` 可整体关闭。
- **系统提示可视化**：底栏显示当前系统提示总字数（`sys N`，含自动读取的全部文件）；`/prompt` 用方向键查看组成——各文件、路径、字数，Enter 看内容。
- **排队输入（底部固定）**：AI 正在运行时照样打字——输入行实时固定在底部排队区（不随 AI 输出上滚，也不会被 AI 内容覆盖）；Enter 后消息排入底部队列行，本轮结束自动依次执行（每条以 `you ›` 回放到对话流再运行）。以 `!` 开头的消息会**立即插队**：注入正在进行的对话（AI 收到「插队消息」提示，优先处理并把原任务收尾），插队位置在对话流中以 `you › … ⤵ 已插队` 回显；Ctrl+C 行为不变（一次警告、两次退出）。
- **上一轮总结**：每轮结束后，终端标题显示 10 字内总结（`puck · 修复thinking…`），状态栏上方有专用摘要行（`修复thinking显示 → 改动 openai.ts`），按显示宽度自动换行（最多两行）不截断——回到窗口一眼知道刚才做了什么；/clear 同时清掉。
- **终端标题 Working**：AI 工作时终端标签页显示转动的 `✻ Working…`（✻✽✶✳ 轮换），结束恢复为 `puck`。
- **文件轨迹行**：状态栏上方常驻一行 `✎ 最新 ← 较旧`，实时列出本会话 agent 通过 write/edit 创建或修改的文件（重复修改自动提前到最左）。
- **外部 harness 历史导入**：/resume 合并显示 puck-native + 本机 ~/.claude、~/.pi、~/.codex 的历史会话；外部会话带来源角标（[pi]/[codex]/[claude]），选中后透明导入（copy-on-import，不动原文件；重复导入自动复用）。工具调用按 id/顺序配对，压缩历史无损迁移，无输出悬空的调用会被安全丢弃。按 `r` 重新扫描外部会话。
- **/resume 默认仅显示当前目录的会话**（复用 pi 的默认行为）：其它项目的会话被隐藏，避免上百条不同项目的历史淹没当前上下文。按 `a` 切换为“全部目录”查看（每条 detail 会多一行 cwd 提示）；再按 `c` 切回。puck-native 会话在创建时记 cwd，外部会话从 pi v3 header / codex session_meta / claude 父目录名读 cwd，筛选使用 hash 一致的 slug 比较（避免有 `-` 的目录名解码歧义）。

两项均为 TTY-only：管道、一次性 `puck "prompt"` 模式不产生任何转义序列。

## Web 使用

`@puckguo123/web` 把同一个 harness 暴露成网页端（零依赖 HTTP/SSE + 零构建 vanilla JS UI）：

```bash
npm run web                        # http://127.0.0.1:8787（读 ~/.puck/auth.json）
npm run web -- --mock             # 离线剧本，零 key 零网络
npm run web -- --port 9000 --cwd /path/to/project --model deepseek-chat
node packages/web/dist/cli.js --no-ui   # 只做 API server（自备前端）
```

协议：`POST /api/run` → SSE，每帧就是 core 的 `AgentEvent`；另有 `/api/state`、`/api/sessions`（对应 /resume）、`/api/models`、`/api/model`、`/api/abort`。UI 复刻 CLI 视觉：thinking 灰显、工具 3 行折叠、状态栏（模型/↑↓ tokens/ctx%）、会话恢复回放。SDK 嵌入：`createWebServer({ port, model, cwd, mock })`。注意：无鉴权，默认只绑 127.0.0.1，不要直接暴露公网。

## SDK 使用

### 最小示例（对话 + 内置工具）

```ts
import { createPuck } from "@puckguo123/sdk";

const puck = createPuck({
  model: "MiniMax-M3",                    // 目录里的模型 id
  tools: "coding",                        // bash + read + write + edit
  cwd: process.cwd(),                     // 工具工作目录
  session: { dir: ".puck/sessions" },     // JSONL 持久化（不传则纯内存）
  systemPrompt: "你是一个严谨的编码助手",
});

const { text, usage } = await puck.run("看看 package.json 里有哪些脚本");
console.log(text);
console.log("tokens:", usage.totalTokens, "cost:", usage.cost?.total);
```

`run()` 返回 `{ text, messages, usage }` —— 90% 场景只需要这三个字段。

### 流式渲染（订阅事件）

```ts
for await (const event of puck.iterate("重构 src/utils.ts 里的重复代码")) {
  switch (event.type) {
    case "message_update":               // 助手文本增量（partial 快照）
      if (event.message.role === "assistant") renderDelta(event.message);
      break;
    case "tool_start":                    // 模型开始调工具
      console.log("▶", event.toolName, JSON.stringify(event.args));
      break;
    case "tool_end":                      // 工具完成
      console.log(event.isError ? "❌" : "✅", event.toolName);
      break;
    case "turn_end":                      // 一轮结束（assistant + 工具结果）
      console.log("— turn", event.turn);
      break;
  }
}
```

或者用订阅回调（跨多次 run 持续生效）：

```ts
const off = puck.subscribe((event) => { ... });
// ... 多次 run ...
off();  // 取消订阅
```

### 中断运行

```ts
puck.abort();   // 当前 run 优雅停止，落一条 stopReason: "aborted" 的消息
```

### 自定义工具

```ts
import type { Tool } from "@puckguo123/core";

const searchTool: Tool = {
  name: "search_docs",
  description: "在内部文档库搜索",
  parameters: {                          // 纯 JSON Schema
    type: "object",
    properties: { query: { type: "string" }, topK: { type: "number" } },
    required: ["query"],
  },
  async execute(args, ctx) {             // ctx.cwd / ctx.signal / 自定义字段
    const { query, topK = 5 } = args as { query: string; topK?: number };
    return { content: [{ type: "text", text: `results for ${query}` }] };
    // 出错时: return { content: [...], isError: true }
  },
};

const puck = createPuck({ model: "MiniMax-M3", tools: [searchTool] });
```

工具混合内置的：

```ts
import { createCodingTools } from "@puckguo123/tools";

createPuck({
  model: "deepseek-chat",
  tools: [...createCodingTools({ cwd: "src", only: ["read", "edit"] }), searchTool],
});
```

### 人工审批（危险命令把关）

```ts
import * as readline from "node:readline/promises";

const puck = createPuck({
  model: "MiniMax-M3",
  tools: "coding",
  approval: {
    policy: (call) => call.toolName === "bash" && /rm|git push/.test(String((call.args as { command?: string }).command ?? "")),
    ask: async (call) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`允许执行? ${call.toolName} ${JSON.stringify(call.args)} [y/N/a] `);
      rl.close();
      return answer === "y" ? true : answer === "a" ? "always-allow" : false;
    },
  },
});
```

- `policy: "never"`（默认）不拦；`"always"` 全拦；或谓词函数
- `ask` 返回 `true` 放行、`false` 拦截（模型收到拦截原因，可换方案）、`"always-allow"` 本工具后续不再问

### 上下文压缩（长会话自动摘要）

```ts
const puck = createPuck({
  model: "MiniMax-M3",
  tools: "coding",
  compaction: { enabled: true, maxTokens: 60_000, keepRecent: 20 },
  // 超过 60k token 时，把较早消息摘要成一条 user 消息，最近 20 条原样保留
  // canonical transcript 不动 —— 只是模型看到的视图被压缩
});
```

### 多轮 + 会话恢复

```ts
// run() 可连续调用，上下文延续；中途可切模型
await puck.run("第一步：分析这个代码库的结构");
puck.setModel("deepseek-reasoner");       // 换个推理模型做难点任务
await puck.run("第二步：找出所有 TODO");   // 新模型接着同一份上下文

// 恢复历史会话：同一个 { dir, id } 会自动 hydrate
const resumed = createPuck({
  model: "MiniMax-M3",
  session: { dir: ".puck/sessions", id: "<之前的会话id>" },
});
await resumed.run("继续刚才的对话");
```

### 子代理（并行子任务）

```ts
import { createSubagentTool } from "@puckguo123/features/subagent";

const agentTool = createSubagentTool({
  streamFn: createStreamFn(getModel("MiniMax-M3")),
  tools: createCodingTools({ cwd: "src" }),
  maxTurns: 8,
});

createPuck({ model: "MiniMax-M3", tools: [agentTool] });
// 模型可用 "agent" 工具派发独立子任务，父级只拿最终报告
```

### 技能（可复用指令包）

```ts
import { createSkillTool, loadSkills, skillsToPrompt } from "@puckguo123/features/skills";

const skills = await loadSkills("./skills");   // 每个子目录一个 SKILL.md
// 方式 A：全部注入 system prompt（模型直接知道怎么做）
createPuck({ model: "MiniMax-M3", systemPrompt: base + skillsToPrompt(skills) });
// 方式 B：按需加载（省上下文，模型自己决定读哪个技能）
createPuck({ model: "MiniMax-M3", tools: [createSkillTool(skills)] });
```

### 自定义模型端点（ollama / vllm / openrouter / 任何 OpenAI 兼容）

```ts
import { defineModel } from "@puckguo123/llm";

const local = defineModel({
  id: "qwen3:32b",
  name: "Qwen3 32B",
  baseUrl: "http://localhost:11434/v1",
  apiKeyEnv: "OLLAMA_API_KEY",          // 本地模型可随便填个名字，调用时传 apiKey: "ollama"
  contextWindow: 131_072,
  thinkingTags: true,                   // Qwen3 内联 <think> 思考 → 自动剥离
});

createPuck({ model: local, apiKey: "ollama" });
```

### 不用 SDK，直接用 core（最底层）

```ts
import { Agent } from "@puckguo123/core";
import { createStreamFn, getModel } from "@puckguo123/llm";

const agent = new Agent({
  systemPrompt: "...",
  tools: [myTool],
  streamFn: createStreamFn(getModel("MiniMax-M3")),
  hooks: { maxTurns: 10 },
});

agent.subscribe((event) => { ... });       // 事件
const messages = await agent.prompt("hi"); // 返回本次新增的全部消息
agent.queue("补充要求");                     // 运行中插话
agent.abort();                              // 中断

// 模型切换：替换 streamFn，下一轮生效，发 model_update 事件
agent.setModel("deepseek-chat", createStreamFn(getModel("deepseek-chat")));
```

### 密钥录入（SDK 宿主自定义 UI）

```ts
import { createPuck, loginProvider } from "@puckguo123/sdk";

const puck = createPuck({ model: "MiniMax-M3", tools: "coding" });

// 自由渲染你的 UI，只要提供 promptSecret 回调
await loginProvider("minimax", puck.credentials!, {
  promptSecret: (message) => showMySecretInputDialog(message),  // 返回用户输入
  info: (msg) => showToast(msg),
});
// 之后所有 LLM 调用自动用存的 key（优先级：显式 > 存储 > 环境变量）
```

自定义存储（如 keyring / 数据库）实现 `CredentialStore` 接口传入 `credentials` 参数即可。

### 离线调试（mock 剧本）

```ts
import { createMockStreamFn } from "@puckguo123/llm";

const puck = createPuck({
  model: "mock",
  streamFn: createMockStreamFn([
    { text: "我来查天气", toolCalls: [{ name: "weather", arguments: { city: "北京" } }] },
    { text: "北京晴，26 度" },
  ]),
  tools: [weatherTool],
});
// 每次模型调用消耗剧本的一步；零网络、完全确定，适合测试与 CI
```

---

## 计时统计与 Dashboard

每个 turn 自动记录延迟指标（TTFT/时长/工具耗时/tok-s）到 `~/.puck/timings.jsonl`：

```bash
puck timings                  # 终端摘要（按模型：TTFT p50/p95、时长、tok/s、错误率）
puck timings --html           # 生成自包含 HTML dashboard（离线可开，零外部资源）
puck timings --analyze        # 用当前模型分析用时合理性（正常范围对照、异常解读、建议）
puck timings --model X --last 50   # 过滤
puck timings --clear
```

REPL 里每轮显示 `— 1234 tokens · 首字 0.9s · 本轮 2.1s —`；`/timings` 快速看摘要。

SDK 直接使用：

```ts
import { TimingCollector, TimingStore, generateDashboard, analyzeTimings } from "@puckguo123/timing";

const store = new TimingStore();
const collector = new TimingCollector({
  sessionId: "my-app",
  modelId: puck.modelId,
  onTurn: (record) => store.append(record),
});
collector.attach(puck.agent);

// 分析（任意 StreamFn，可用便宜模型）
const report = await analyzeTimings(store.load(), cheapModelStreamFn);
```

指标定义：TTFT=turn 开始到首个流式 token；整轮时长=LLM 流式+工具执行；工具耗时=工具阶段墙钟；tok/s=输出 token 速率。错误轮计入错误率但不计入延迟分位数。

## 常见问题

**key 放哪？** 环境变量（表格见开头）；SDK 也接受 `apiKey` 参数；CLI 依赖环境变量。

**怎么知道花了多少 token？** `run()` 返回 `usage`（input/output/cacheRead/totalTokens/cost，cost 需模型目录有定价数据）。

**模型列表？** `packages/llm/src/models.ts` 的 `MODEL_CATALOG`，报错信息里也会列出全部 id。

**输出被截断了？** bash 工具输出保留尾部 2000 行/50KB；read 工具用 `offset`/`limit` 分段读。

**想删掉用不到的功能？** 见 [docs/trimming.md](trimming.md)。
