# @puck-agent/web

puck 的 web client —— 一个零依赖的 HTTP/SSE 服务器 + 零构建的浏览器 UI，把 puck harness 完整暴露给网页端。

```
npm run web                          # 真实模型（读 ~/.puck/auth.json / 环境变量）
npm run web -- --mock                # 离线剧本演示（零网络、零 key）
npm run web -- --port 9000 --host 0.0.0.0
node packages/web/dist/cli.js --cwd /path/to/project --model deepseek-chat
```

打开 `http://127.0.0.1:8787` 即用。

## 架构

```
浏览器 (public/index.html + app.js, vanilla JS)
   │  POST /api/run ──▶ SSE 流（AgentEvent 逐帧 JSON）
   │  GET  /api/state /api/sessions /api/models /api/health
   │  POST /api/model /api/login /api/logout /api/abort
   ▼
createWebServer()  ──  @puck-agent/sdk createPuck()（每 sessionId 一个实例）
                          │
                          ├─ @puck-agent/tools   bash/read/write/edit（cwd 可指定）
                          ├─ @puck-agent/session JSONL 会话持久化（/resume 可恢复）
                          ├─ @puck-agent/llm     FileCredentialStore + 多 provider
                          └─ compaction          100k 自动压缩
```

- **协议**：`POST /api/run` 以 Server-Sent Events 回流，每帧一个 `data: {json}`，主体就是 core 的 `AgentEvent`（`message_update` / `tool_start` / `tool_end` / `turn_end` …），外加三个服务端生命周期事件（`server_notice` / `server_error` / `run_settled`）。
- **并发**：同一 session 的并发 POST 由 `Agent.prompt()` 自身的 steering 队列串行化。
- **UI 与 CLI 完全同构**：复刻 `term.ts` 的全部视觉与交互 ——
  - thinking 灰显流式 + 正文前换行分隔、命令品红 `$ cmd`、路径亮蓝、✅/❌ + 3 行折叠 + `+N more`
  - 等待 spinner（`⠹ thinking … 1.3s` 刷新计时）与文档标题 `✻ Working…` 轮换
  - 底部状态栏：cwd · ↑in ↓out · ctx%（>70% 黄 / >90% 红）· 模型；上轮总结行 + 文件轨迹行 `✎ 最新 ← 较旧`
  - 每轮统计 `— N tokens · 首字 X.Xs · 本轮 Y.Ys —`，Turn 分隔线 `───`
  - 斜杠命令全套：`/model /models /think /compact /clear /resume /timings /status /login /logout /help`，带前缀过滤弹窗（↑↓ 选择 · Tab 补全）
  - `/resume` 历史列表（标题/轮次/工具次数/compact/模型/相对时间）+ transcript 回放渲染 + 文件轨迹与总结水合
  - 输入历史 ↑/↓ 翻阅（localStorage 持久，最多 500 条）；Ctrl+C 双击保护（运行中先提示，3 秒内再按才中止）

## SDK 用法

```ts
import { createWebServer } from "@puck-agent/web";

const server = createWebServer({
  port: 8787,
  host: "127.0.0.1",
  model: "deepseek-chat",     // 或省略 → PUCK_MODEL / 内置默认
  cwd: process.cwd(),          // 工具执行目录
  sessionsDir: ".puck/sessions",
  ui: true,                    // false = 只做 API server（自备前端）
  mock: false,                 // true = 离线剧本（UI 开发/演示）
});

await server.start();
// ... later
await server.stop();
```

## 安全须知

服务器以**当前进程的权限**执行 bash/read/write/edit。默认只绑定 `127.0.0.1`；不要暴露到公网（没有鉴权）。需要远程访问时请自行加反向代理 + 鉴权，或用容器隔离 —— 参见 puck README 的容器化说明。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活检查 + 当前模型 / cwd |
| GET | `/api/state?sessionId=` | 会话快照（transcript / tokens / ctx% / thinking / session 统计） |
| GET | `/api/sessions` | 历史会话列表（SessionStats[]） |
| GET | `/api/status` | 当前模型 / thinking / cwd / key 路径 / provider 状态（/status） |
| GET | `/api/providers` | 全部 provider + 鉴权状态（✓ stored / ~ env / • none） |
| GET | `/api/models` | 已接入 provider 的实时模型列表 |
| GET | `/api/timings` | 按模型聚合的用时统计（/timings） |
| POST | `/api/run` | `{sessionId?, input, model?, thinkingEffort?}` → SSE 流 |
| POST | `/api/model` | 切换会话模型（同时可存为默认，/model） |
| POST | `/api/think` | 设置 thinking 等级（/think off\|low\|medium\|high） |
| POST | `/api/compact` | 手动压缩上下文（/compact；过小则拒绝并说明原因） |
| POST | `/api/login` / `/api/logout` | 存/删 provider key；login 返回实时模型列表供选默认（/login） |
| POST | `/api/abort` | 中止活跃 run |
