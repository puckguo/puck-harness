# puck 开源补丁计划（按文件）

> **前提**：本文档是补丁**草案**——执行任何 `npm pkg set` / 文件删除 / `git init` 之前需要你点头。
> **配套**：`REPO-AUDIT.md`（盘点报告） + `PUBLISH-PLAN.md`（战略方案） + `scripts/audit-publish.mjs`（自检脚本）。

---

## Phase A：删除 / 清理（隐私 & 隐私扩散风险）

### A1. 必须**人工确认**后删除的文件

| 路径 | 删除原因 | 删除前必须做 |
|---|---|---|
| `bench/home/puck/auth.json` | 真实 API key | **先把 key 在上游（Anthropic / OpenAI / DeepSeek）rotate 掉**，因为如果这个文件曾经上传过任何地方，token 已经泄漏 |
| `bench/home/puck/timings.jsonl` | 真实模型调用记录（含 query/response 片段） | 检查是否含敏感代码片段；备份到保险柜 |
| `bench/home/codex/` 整目录 | 个人 codex 安装（含 sqlite + sessions） | 整个目录是私人的，无需备份 |
| `.puck/` 整目录 | 开发期真实 session 记录 | 备份（如果想保留某些会话） |
| `.puck-real-sessions/` 整目录 | session 备份 | 同上 |
| `brainstorm.md` | 100 KB 内部设计日志 | 决定是删除还是脱敏后保留（脱敏 = 删掉 version 状态行 + 个人吐槽） |
| `puck-demo.txt` | 测试输出 | 直接删 |
| `void` | 占位空文件 | 直接删 |
| `.patch-docs14.cjs` | 本地补丁脚本（修改 brainstorm.md） | 直接删 |
| `pnpm-lock.yaml` | 与 `package-lock.json` 冲突 | 推荐**保留 `package-lock.json`**（CI 用 npm） |

### A2. CLI 构建泄漏的 dist/.puck/

`packages/cli/dist/.puck/sessions/*.jsonl` —— 测试运行期间 CLI 在 `packages/cli/` 目录创建了 session 文件，tsc 增量构建把它们也复制到了 `dist/`。需要：
- **修复**：让 CLI 测试运行时把 session 写到 `tmpdir` 而不是 cwd（用 `os.tmpdir()`）
- **临时清理**：`rm -rf packages/cli/dist/.puck packages/*/dist/.puck packages/*/dist/.*`（执行 build 前后都清一遍）

---

## Phase B：补 metadata（package.json 字段）

### B1. 必备字段补丁（11 个 package.json × 9 个字段）

每个 `package.json` 需要加：

```jsonc
{
  "repository": {
    "type": "git",
    "url": "https://github.com/<owner>/puck.git",
    "directory": "packages/<pkg-name>"
  },
  "homepage": "https://github.com/<owner>/puck#readme",
  "bugs": {
    "url": "https://github.com/<owner>/puck/issues"
  },
  "author": {
    "name": "<你的名字>",
    "email": "<你的邮箱>"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

`<owner>` 和 `<pkg-name>` 占位——你确认 GitHub 用户名后替换。

### B2. 互依赖版本号升级

11 个 package.json 里的 `@puck-agent/*` 依赖：
- 写死 `0.1.0` → 改成 `^0.1.0`
- `workspace:*` → 改成 `^0.1.0`

这是用 `npm pkg set` 一行命令搞定的事，但要等**所有包都 publish 完**才能 `^0.1.0` 正常工作。所以发布流程是：
1. 先按 `0.1.0` 发布所有包
2. 之后所有改动都用 `changesets` 提到 `0.2.0`，自动 `^0.2.0`

### B3. `keywords` 字段补全

`@puck-agent/store` 和 `@puck-agent/memory` 缺 keywords：

```jsonc
"keywords": ["ai", "agent", "storage", "kv"]
```

```jsonc
"keywords": ["ai", "agent", "memory", "index", "experience"]
```

### B4. `license: "MIT"` 补全

`@puck-agent/store` 和 `@puck-agent/memory` 缺 license。

### B5. `files` 字段补全

`@puck-agent/store` 和 `@puck-agent/memory` 缺 files，建议：

```jsonc
"files": ["dist", "README.md"]
```

### B6. `engines.node` 补全（根 package.json 已有）

子包应继承：
```jsonc
"engines": {
  "node": ">=22.18.0"
}
```

---

## Phase C：新增顶层文件

### C1. `LICENSE` (MIT)

标准 MIT 文本，作者 = `<你的名字>`，年份 = 2026。

### C2. `CONTRIBUTING.md`

最小骨架：
- 怎么装 dev 环境（`npm install`）
- 怎么跑测试（`npm test`）
- 怎么加新包（`packages/<name>/` 模板）
- PR 流程 + changeset 要求

### C3. `SECURITY.md`

- 漏洞披露邮箱
- 修复时间 SLA（"严重漏洞 7 天 / 一般 30 天"）
- 支持的版本范围

### C4. `.gitignore`

直接用 `puck/.gitignore.draft`（已写好）。

### C5. `CHANGELOG.md`

首版由 `changesets` 自动生成；先空着。

---

## Phase D：发布工具

### D1. changesets 安装

```bash
npm install --save-dev @changesets/cli
npx changeset init
```

### D2. 第一个 changeset

`/root/.changeset/initial-release.md`：
```md
---
"puck": major
"@puck-agent/core": major
"@puck-agent/sdk": major
"@puck-agent/session": major
"@puck-agent/llm": major
"@puck-agent/tools": major
"@puck-agent/features": major
"@puck-agent/web": major
"@puck-agent/store": major
"@puck-agent/memory": major
"@puck-agent/timing": major
---

Initial public release of puck — a minimal, trimmable agent harness.
```

### D3. `.github/workflows/ci.yml`

最小骨架：
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.18.0
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

### D4. `.github/workflows/release.yml`

changesets 自动发布：
```yaml
name: release
on:
  push:
    branches: [main]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with:
          node-version: 22.18.0
          registry-url: https://registry.npmjs.org/
      - run: npm ci
      - run: npx changeset version
      - run: npx changeset publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - uses: changesets/action@v1
        with:
          version: npx changeset version
          commit: "chore: version packages"
          title: "chore: version packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Phase E：第一次发布流程

1. **git init + 第一批 commit**
   ```bash
   cd puck
   git init
   git add .  # .gitignore 已生效
   git commit -m "chore: initial open-source release"
   ```
2. **push 到 GitHub（先 private，跑通 CI，再 public）**
3. **npm login**（你执行，浏览器认证）
4. **本地手动发布（不依赖 CI）**
   ```bash
   cd packages/core && npm publish --access public
   cd ../session && npm publish --access public
   cd ../llm && npm publish --access public
   cd ../tools && npm publish --access public
   cd ../features && npm publish --access public
   cd ../timing && npm publish --access public
   cd ../store && npm publish --access public
   cd ../memory && npm publish --access public
   cd ../sdk && npm publish --access public
   cd ../web && npm publish --access public
   cd ../cli && npm publish --access public  # 最后一个，因为依赖所有
   ```
   ⚠️ 顺序很重要：底层包先发。
5. **回仓库根升级所有互依赖到 `^0.1.0`**，跑测试验证
6. **push 第二批 commit + GitHub 转 public**
7. **首次发布后的验证清单**：
   ```bash
   # 在临时空目录里：
   npm install puck
   npx puck --help
   npm install @puck-agent/core
   node -e "import('@puck-agent/core').then(m => console.log(Object.keys(m)))"
   ```

---

## 我能现在立刻做的（不需要你拍板）

| 任务 | 文件 | 风险 |
|---|---|---|
| 写好 `.gitignore` 草案 | `.gitignore.draft`（已有）→ 等你确认后改名为 `.gitignore` | 零（draft 后缀） |
| 写好 `audit-publish.mjs` | `scripts/audit-publish.mjs`（已有） | 零（只是个检查脚本） |
| 写好 `REPO-AUDIT.md` | `REPO-AUDIT.md`（已有） | 零 |
| 写好 `PUBLISH-PLAN.md` | `PUBLISH-PLAN.md`（已有） | 零 |
| 写好本 `PATCH-PLAN.md` | `PATCH-PLAN.md`（本文件） | 零 |
| 写 `LICENSE` (MIT) | 待创建 | 零（但属于法律文件，等你点头） |

## 需要你明确拍板才能做的

| 任务 | 需要什么 |
|---|---|
| 删 `bench/home/puck/auth.json` 等 | 你说"删" + 你去上游 rotate key |
| 改任何 `package.json` | 你说改 + 提供 GitHub 用户名 + author 姓名邮箱 |
| 写 `LICENSE` 文本 | 你说写 + 提供姓名/年份 |
| `git init` + 第一次 commit | 你说初始化 + 决定本地 vs GitHub 远程 |
| `npm publish` | 你说"发" + 提供 npm 登录态 |
| 安装 changesets / GitHub Actions | 你说装 |

---

## 接下来推荐的动作

按风险递增：

1. ✅ 你现在 review `REPO-AUDIT.md` 和本文件，确认我对仓库的理解
2. ⏸ 你回答 PUBLISH-PLAN.md 的 6 个决策点（包命名、协议、命名空间、CI、changesets）
3. ⏸ 你确认删除清单（Phase A）后我用 `rm` 清理敏感文件
4. ⏸ 你提供 GitHub 用户名 / 邮箱 / 组织名后我用 `npm pkg set` 批量补 metadata
5. ⏸ 你确认 `git init` 后我帮你写首次 commit message + push
6. ⏸ 你执行 `npm login` 后我们手动 publish 第一个包（dry-run 验证后再真发）
