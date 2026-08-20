# puck 开源 + npm 发布方案

> 状态：**待确认** — 涉及不可逆操作（npm publish 后不能删除同名包，只能 unpublish 24h 内或 deprecate；GitHub 仓库公开后无法收回），决策点必须先对齐。

## 当前状态盘点

- **仓库根目录**：`/c/guo/SoftwareDevelopment/research/puck-agent/puck/`
- **版本**：11 个 packages 全部 `0.1.0`
- **包结构**（npm workspaces monorepo）：
  - `puck` （CLI，安装后 bin 为 `puck` 命令）
  - `@puckguo123/core` （零依赖核心，agent loop + message model）
  - `@puckguo123/sdk` （高层 createPuck 入口）
  - `@puckguo123/llm` （OpenAI/Anthropic 适配器）
  - `@puckguo123/session` （JSONL 会话持久化 + 跨 harness 导入）
  - `@puckguo123/features` （compaction / subagent / 思考轮转等可裁切特性）
  - `@puckguo123/tools` （bash/read/write/edit）
  - `@puckguo123/store` （本地 key-value 存储）
  - `@puckguo123/memory` （索引数据库）
  - `@puckguo123/timing` （轮转时长统计）
  - `@puckguo123/web` （可选 Web UI）
- **缺失项**：
  - ❌ 无 `.git` — 仓库尚未初始化
  - ❌ 无 `LICENSE` — 开源必备
  - ❌ 无 `CONTRIBUTING.md`、`SECURITY.md`
  - ⚠️ 根目录有 `.puck`、`puck-demo.txt`、`brainstorm.md`、`void/`、`pnpm-lock.yaml` 等开发痕迹，会污染 git
  - ⚠️ `pnpm-lock.yaml` + `package-lock.json` 混用（用了 `npm test` 和 `pnpm`），需统一

## 需要先确认的决策点

### 1. 包命名

CLI 包名 `puck` 是个**热门单字**，很可能会在 npm 上冲突。需要确认：

| 选项 | 优点 | 风险 |
|---|---|---|
| **A. 保留 `puck`** | 简洁、CLI 命令就是 `puck` | 很可能已被占用；需要 `npm view puck` 验证 |
| **B. `@puckguo123/cli`** + CLI 命令改名（如 `puck-agent`） | 命名空间安全，包名清晰 | 命令变长 |
| **C. 自命名空间（如 `@你的组织/puck`）** | 完全可控 | 需要 npm org 账号 |

**我的建议**：先用 `npm view puck` 验证是否可用；如已被占用，回退到 `@puckguo123/cli`（bin 名仍叫 `puck`，命令体验不变）。

### 2. 发布范围（关键决策）

| 选项 | 说明 | 适用场景 |
|---|---|---|
| **A. 只发 puck CLI** | 11 个 packages 合并发布为一个 fat npm 包 | 用户只需要 CLI，不在乎底层架构 |
| **B. 发 CLI + 公共子包** | `@puckguo123/core` / `sdk` / `session` 等零依赖/低依赖包也发布 | 用户可以 `import { Agent } from "@puckguo123/core"` 直接集成到自己的 app（puck 定位是 "trimmable harness"，这种用法很重要） |
| **C. 11 个包全部独立发布** | 完整 monorepo 发布 | 树摇最大化，但需要 `changesets`/`release-please` 等管理工具 |

**我的建议**：B（CLI + 5 个核心子包：core/sdk/llm/session/tools；features/web/store/memory/timing 保持私有或下个版本再考虑）。理由：
- README 顶部就写了 "createPuck({...})"，证明对外 SDK 是核心卖点
- `core` / `session` 明确写明 "zero dependencies"，是其他 agent 框架想嵌入时的天然选择
- 子包各自 < 5KB，独立发布对用户安装体积友好

### 3. GitHub 仓库（开源必备）

需要先决定：
- **仓库 URL**：`https://github.com/<owner>/puck` 或 `puck-agent`？
- **可见性**：Public（开源必须）
- **是否已有 repo**：需先确认 `git remote` 列表里是否已经有源仓库（目前 `.git` 还不存在）

### 4. 协议

| 选项 | 适用场景 |
|---|---|
| **MIT** | 最宽松，鼓励 fork/嵌入（puck 的 "trimmable" 哲学暗示了这点） |
| **Apache-2.0** | 加专利授权条款，企业友好 |
| **MPL-2.0** | 文件级 copyleft，允许嵌入但修改文件必须开源 |

**我的建议**：MIT（与 README 风格一致："可读、可断点、可审计"）。

### 5. 发布工具

需要选择版本管理和发布自动化：

| 选项 | 复杂度 | 适用 |
|---|---|---|
| **手动 npm publish** | 低 | 一次性发布 5+ 个包要手动跑 5+ 次 + 维护版本号 |
| **`changesets`** | 中 | 主流 monorepo 方案，PR 流程内带 changeset，release 时自动生成 CHANGELOG |
| **`release-please`** | 中 | Google 出品，按 conventional commits 自动管理版本 + CHANGELOG |

**我的建议**：`changesets`（puck 跨包更新频繁：core 改了，cli/sdk 也要跟着 bump；changesets 让这个流程清晰）。

### 6. CI

发布需要一个 CI，至少做：
- **PR 检查**：`npm run typecheck` + `npm test`（已有）+ lint（待补）
- **发布**：合并到 main 后自动 npm publish（需要 `NPM_TOKEN` secret）
- **可选**：自动构建 + 校验 `npm pack` 内容，确保没有 `.puck`、scratch 文件泄漏

## 我建议的执行顺序（确认后开工）

### Phase 0：决策对齐（现在）
- 用户确认上述 6 个决策点

### Phase 1：仓库准备（本地）
1. `cd puck` → `git init` → 创建 `.gitignore`（忽略 `.puck/`、`puck-demo.txt`、`brainstorm.md`、`void/`、`node_modules/`、`dist/`、`.puck-real-sessions/`、`.patch-docs14.cjs`）
2. 选择 2-3 个 git host candidates（GitHub / Gitee），由用户决定
3. 创建 `LICENSE` (MIT) + `CONTRIBUTING.md` + `SECURITY.md` + 更新 `README.md` 加徽章 + 链接
4. 决定是否删除 `pnpm-lock.yaml`（用 npm 即可）或保留
5. 选定子包发布范围（决策点 2）

### Phase 2：包元数据补全
1. 每个 `package.json` 加：
   - `repository` 字段（指向 git 仓库）
   - `homepage` 字段
   - `bugs` 字段（issue tracker URL）
   - `author` 字段（你的名字 + email）
   - `publishConfig: { access: "public" }`
   - 互相依赖：`@puckguo123/sdk: 0.1.0` 改为 `^0.1.0`，避免 npm 把同 workspace 包当成 file: 引用
2. 验证：`npm run build && npm pack --dry-run` 看每个包会被发布的文件清单（**关键步骤**：catch 哪些私货会被泄漏）

### Phase 3：自动化
1. 加 `.github/workflows/ci.yml`（typecheck + test on PR）
2. 加 `.github/workflows/release.yml`（changeset bot + npm publish）
3. 加 `.changeset/config.json` + 首个 changeset
4. 加 `RELEASE.md` 描述发布流程

### Phase 4：第一次发布
1. 推 GitHub（首次 commit）
2. `npm login`（用户操作）
3. 用 changesets beta 版做第一个 stable release
4. 验证每个包在 npmjs.com 上可搜索到、可 `npm install` 成功

### Phase 5：发布后
1. 文档站（可选）：docs/ → vitepress 部署到 GitHub Pages
2. 添加 shields.io 徽章到 README
3. 在 pi/codex 生态社区发布公告（README 里的"参考 pi、codex"暗示你们在意这块）

## 风险与回退

- **npm publish 24h 内可 unpublish**：所以万一发错，可以快速回收。
- **一旦超过 24h**：只能 deprecate（用户安装时收到警告），不能删除。**所以**：第一次发布一定要先 `npm publish --dry-run`（实际是 `npm pack` + 检查 tarball）确认无误。
- **GitHub 仓库**：可以 private→public，但无法 public→private 后保留 issues/PRs。建议上线前先在 private repo 上跑 CI 跑通。

## 我现在能直接做的事（无需你确认）

如果上面决策点你想先放着，我可以先做这些**零风险**的事：

1. 写一个 `puck/REPO-AUDIT.md`，列出当前仓库里**所有**会被 git 跟踪但**不应该进 npm 包或 GitHub** 的文件（`.puck/`、`puck-demo.txt`、`brainstorm.md`、`void/`、`.patch-docs14.cjs`、`.puck-real-sessions/` 等）
2. 写一份 `.gitignore` 草案，让你 review 后 `git init` 就用
3. 写一份每个 `package.json` 缺哪些 fields 的清单（哪些缺 `repository` / `author` / `license` 等）

等你回决策点（至少 1/2/3/4），我就可以开干。
