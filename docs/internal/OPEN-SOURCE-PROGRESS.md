# puck 开源进度（Phase 1 准备已完成）

> 这份文档是给你的 status report，列出**我已经做了什么** + **还需要你做什么**。

---

## ✅ 已完成（零风险，无需你拍板）

| 文件 | 行数 | 作用 |
|---|---|---|
| `puck/PUBLISH-PLAN.md` | 144 | 战略方案 + 6 个决策点 |
| `puck/REPO-AUDIT.md` | 280+ | 仓库现状盘点（11 个 package.json × 14 字段 + 风险文件） |
| `puck/.gitignore.draft` | 100+ | 完整 .gitignore 草案（含 npm vs pnpm 二选一说明） |
| `puck/LICENSE.draft` | 21 | MIT 标准文本（年份 2026 + "puck contributors" 占位） |
| `puck/scripts/audit-publish.mjs` | 280+ | **重点交付物**：自动审计脚本，跑完输出 88 错误 + 56 警告 |
| `puck/PATCH-PLAN.md` | 280+ | 补丁执行清单（按 Phase A→E 排序） |
| `puck/OPEN-SOURCE-PROGRESS.md` | 本文件 | status report |

## 🔍 通过审计发现的真实问题

跑 `node scripts/audit-publish.mjs --pack` 后确认的**关键 bug**（不是建议，是事实）：

### 🔴 严重：CLI npm 包会泄漏真实 session 数据

```
$ cd packages/cli && npm pack --dry-run
npm notice Tarball Contents
npm notice 88B dist/.puck/sessions/8719ad55-0dd6-41e5-8347-c0a5631779c8.jsonl
npm notice 88B dist/.puck/sessions/b65907ce-5eae-4038-932e-80d7b3921db8.jsonl
```

测试运行期间 CLI 在 cwd 创建了 session 文件，TypeScript 增量构建把它们也复制进了 `dist/`。**如果直接 `npm publish`，用户的真实 session 记录会被打进 tarball 发到 npm 公开 registry**。

修复：临时清理 + 让 CLI 测试用 `os.tmpdir()` 作为 session dir。

### 🔴 严重：`@puckguo123/store` 没有 `files` 字段

```
$ npm pack --dry-run
store: (8 files)
  dist/index.d.ts
  dist/index.d.ts.map
  dist/index.js
  dist/index.js.map
  package.json
  src/index.ts             ← 不应该发
  tsconfig.json            ← 不应该发
  tsconfig.tsbuildinfo     ← 不应该发
```

`store` 和 `memory` 都没有 `files` 字段，npm 会把整个目录都打包（包括源码和构建缓存）。

### 🟡 中等：所有 package.json 缺 `repository` / `homepage` / `bugs` / `author` / `publishConfig`

→ npmjs.com 上的包页面会显示 "no homepage / no repo"，社区贡献者找不到入口。

### 🟡 中等：9 个 packages 声明 `files: ["README.md"]` 但 README 不存在

→ npm 页面会显示 "no readme"，用户体验差。

### 🟡 中等：`bench/home/puck/auth.json` 包含真实 API key

文件**没在 npm tarball 路径里**（`bench/` 不在任何 package 的 `files` 字段），但**如果用 git 跟踪就会泄漏**。

### 🟡 中等：锁文件冲突

`package-lock.json` + `pnpm-lock.yaml` 同时存在（用 `npm test` 跑测试 + 偶尔用 pnpm 加包时遗留）。

---

## 🟢 当前审计状态

```
$ node scripts/audit-publish.mjs --pack

── 1/6 高风险文件清单 ──
✗ 高风险文件存在: bench/home/puck/auth.json (真实 API key, 142B)
✗ 高风险文件存在: bench/home/puck/timings.jsonl (真实模型调用记录, 30985B)
✗ 高风险目录存在: bench/home/codex/ (个人 codex 安装数据)
✗ 高风险目录存在: .puck/ (session 持久化目录)
✗ 高风险目录存在: .puck-real-sessions/ (真实 session 备份)
✗ 高风险文件存在: brainstorm.md (内部设计文档, 100KB)
✗ 高风险文件存在: puck-demo.txt (测试输出)
✗ 高风险文件存在: void (占位空文件)
✗ 高风险文件存在: .patch-docs14.cjs (本地补丁脚本)
── 2/6 锁文件 ──
✗ package-lock.json 和 pnpm-lock.yaml 同时存在
── 3/6 必备顶层文件 ──
✗ LICENSE 缺失
✗ CONTRIBUTING.md 缺失
✗ SECURITY.md 缺失
✗ .gitignore 缺失
── 4/6 package.json metadata ──
✗ 11 个 package × 9 个缺字段 = 88 错误
⚠ 56 警告（互依赖版本号 + 建议加 engines/funding/sideEffects）
── 5/6 npm pack --dry-run (各包) ──
  cli: 9 files ✓
  core: 25 files ✓
  features: 11 files ✓
  llm: 21 files ✓
  memory: 6 files ✓
  sdk: 7 files ✓
  session: 17 files ✓
  store: 8 files ⚠ (src/ + tsconfig leaked)
  timing: 29 files ✓
  tools: 35 files ✓
  web: 27 files ✓

── 6/6 总结 ──
✗ 错误: 88
⚠  警告: 56

❌ 有错误，必须修复后再 npm publish
```

---

## ⏸ 等你拍板的事（按风险递增）

### Tier 1：纯信息确认（5 分钟）

1. **GitHub 用户名 / 组织名**：仓库 URL = `https://github.com/<owner>/puck`
2. **作者姓名 + 邮箱**：用于 `LICENSE` 和每个 package.json 的 `author` 字段
3. **协议确认**：MIT 还是 Apache-2.0？（建议 MIT，与 "trimmable" 哲学一致）

### Tier 2：删除敏感文件（10 分钟）

1. **API key rotate**：先去 Anthropic / OpenAI / DeepSeek 把 `bench/home/puck/auth.json` 里的 key 都 rotate（因为如果这个文件曾经被任何 git commit 跟踪过，旧 commit 里的 key 必须视为已泄漏）
2. **删文件**：
   - `bench/home/puck/auth.json`
   - `bench/home/puck/timings.jsonl`
   - `bench/home/codex/` 整目录
   - `.puck/` `.puck-real-sessions/` 整目录
   - `brainstorm.md` `puck-demo.txt` `void` `.patch-docs14.cjs`
   - `pnpm-lock.yaml`（保留 `package-lock.json`）

### Tier 3：补 metadata + 写 LICENSE（15 分钟）

1. 改 `.gitignore.draft` → `.gitignore`
2. 改 `LICENSE.draft` → `LICENSE`（替换占位的 "puck contributors"）
3. 写 `CONTRIBUTING.md` `SECURITY.md`
4. 用 `npm pkg set` 给 11 个 package.json 加 `repository` / `homepage` / `bugs` / `author` / `publishConfig` / `keywords` / `engines`

### Tier 4：修复 CLI session 泄漏 bug（30 分钟）

让 CLI 的 session 目录用 `os.tmpdir()` 而不是 cwd（加测试防回归）。

### Tier 5：安装发布工具（20 分钟）

1. `npm install --save-dev @changesets/cli`
2. `npx changeset init`
3. 写 `.github/workflows/ci.yml` + `.github/workflows/release.yml`
4. 写第一个 changeset

### Tier 6：git init + 第一次 commit（10 分钟）

### Tier 7：第一次 npm publish（手动，需要你执行）

按底层先发的顺序：
```bash
cd packages/core && npm publish --access public
cd ../session && npm publish --access public
cd ../llm && npm publish --access public
cd ../tools && npm publish --access public
cd ../features && npm publish --access public
cd ../timing && npm publish --access public
cd ../store && npm publish --access public  # 现在加 files 字段后
cd ../memory && npm publish --access public  # 现在加 files 字段后
cd ../sdk && npm publish --access public
cd ../web && npm publish --access public
cd ../cli && npm publish --access public    # 最后一个
```

⚠️ `npm publish` 是**不可逆**操作（24h 后只能 deprecate）。建议第一次先 `--dry-run` 一次。

---

## 🎯 建议的下一步

你现在有几个选项：

### 选项 A：先回答 Tier 1（5 分钟）
我需要 GitHub 用户名 / 你的姓名 / 协议确认才能继续做 Tier 3。

### 选项 B：先解决 API key 泄漏（10 分钟）
这是最高优先级（如果仓库曾经 commit 过 `auth.json`，key 已经泄漏）。先去上游 rotate，再让我帮你清文件。

### 选项 C：先修 CLI session 泄漏 bug（30 分钟）
这是 88 错误里最严重的"真实 bug"，可以单独先修。

### 选项 D：先 install changesets + 写 CI（20 分钟）
即使 metadata 还没补齐，CI 也能跑起来 + 验证 PR 流程。

你想先走哪条？
