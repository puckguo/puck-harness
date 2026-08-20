# puck 仓库审计报告（开源 + npm 发布前）

> **目的**：识别 `puck/` 仓库里所有**不应该进入 npm 包或 GitHub 仓库**的文件，以及所有 package metadata 的缺口。
> **生成时间**：仓库审计第 1 轮（基于当前工作目录）。
> **下一步**：人工 review 后我会准备 `.gitignore` 草案 + `LICENSE` + 各 package.json 补丁 + 自动验证脚本（`scripts/audit-publish.mjs`）。

---

## 一、绝不能发布的文件（隐私 / 开发痕迹）

按风险从高到低排序。

### 🔴 高风险（包含密钥 / 个人数据 / 配置）

| 路径 | 内容 | 处置 |
|---|---|---|
| `bench/home/puck/auth.json` | 真实 API key（Anthropic / OpenAI 等） | **必须删除**，发布前清零；保留痕迹会触发 npm token 撤稿流程 |
| `bench/home/puck/timings.jsonl` | 真实模型调用记录 | **必须删除**（与上面同一个目录） |
| `bench/home/codex/` | 完整 codex home dir，包含 sqlite + sessions | **必须整体删除**（个人 codex 安装数据） |
| `bench/fixture/`、`bench/fixture-template/` | benchmark 用的项目脚手架（100 KB） | 可保留进 git（无害），但需从 npm 排除 |
| `bench/results.json`、`bench/results-t4.json`、`bench/run.log` | benchmark 运行结果 | 可保留进 git（公开数据），但需从 npm 排除 |
| `bench/home/puck/` 目录本身 | 残留的 dev home dir | **必须删除**（已与 `bench/fixture/` 一起放到 `.puckhome` 更合适） |

### 🟡 中风险（开发工具产物 / 个人备注）

| 路径 | 内容 | 处置 |
|---|---|---|
| `.puck/` | 真实 session 记录（开发期间累积的对话） | **必须排除**（不进 git，不进 npm） |
| `.puck-real-sessions/` | 真实 session 的备份 | **必须排除** |
| `.patch-docs14.cjs` | 一键修改 `brainstorm.md` 标题的本地脚本 | **必须删除**（绝对不应该开源） |
| `brainstorm.md` | 100 KB 的内部设计记录，标题里写着 `v0.2.14`（≠ 当前 package.json 的 `0.1.0`） | **必须排除**或脱敏后重命名 |
| `puck-demo.txt` | 测试输出文件 | **必须排除** |
| `void` | 空文件（占位符） | **必须删除** |
| `pnpm-lock.yaml` | 与 `package-lock.json` 重复（混用了 pnpm 和 npm） | **必须二选一并删除另一个** |
| `.claude/`、`.codex/`、`.pi/` | 仓库外的工具配置 | 与本仓库无关，无需处理（不会被 git 跟踪） |

### 🟢 低风险（可保留但要进 .gitignore）

| 路径 | 内容 | 处置 |
|---|---|---|
| `node_modules/` | 依赖目录 | 标准忽略 |
| `dist/` | 构建产物 | 各 package.json 已通过 `files: ["dist", ...]` 限定；git 应忽略 |
| `tsconfig.tsbuildinfo` | TypeScript 增量构建缓存 | 标准忽略 |
| `**/.DS_Store` | macOS 文件 | 标准忽略 |
| `coverage/`、`*.log` | 测试覆盖 / 日志 | 预防性忽略 |

---

## 二、各 package.json metadata 缺口（按发布必备项审计）

参考 npm 官方推荐字段 + 社区最佳实践（`npm pkg fix` 会自动补一些，但不会自动填 `repository` / `author` / `keywords` 之类）。**缺失字段 = `npm publish` 时不报错但展示效果差 / 链接失效**。

字段说明：
- ✅ = 已填
- ⚠️ = 部分填（需要补充）
- ❌ = 完全缺失
- N/A = 不需要

| 字段 | puck | @puckguo123/core | sdk | session | llm | tools | features | web | store | memory | timing |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `name` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `version` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `description` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `type: "module"` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `main` / `types` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (无 main) | ✅ | ✅ | ✅ | ✅ |
| `exports` | ❌ (只有 bin) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `bin` | ✅ (puck) | N/A | N/A | N/A | N/A | N/A | N/A | ✅ (puck-web) | N/A | N/A | N/A |
| `files` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| `keywords` | ⚠️ (3 个) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| `license` | ✅ MIT | ✅ MIT | ✅ MIT | ✅ MIT | ✅ MIT | ✅ MIT | ✅ MIT | ✅ MIT | ❌ | ❌ | ✅ MIT |
| `repository` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `homepage` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `bugs` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `author` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `publishConfig` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `engines.node` | (根) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `README.md` 实际文件 | ❌ 不存在 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| 互依赖版本号 | ⚠️ workspace:* 残留 | ⚠️ 写死 `0.1.0` | ⚠️ 写死 `0.1.0` | ⚠️ 写死 `0.1.0` | ⚠️ 写死 `0.1.0` | ⚠️ 写死 `0.1.0` | ⚠️ 写死 `0.1.0` | ⚠️ 写死 `0.1.0` | ⚠️ workspace:* | ⚠️ workspace:* | ⚠️ 写死 `0.1.0` |

### 关键问题清单（按严重程度）

1. **所有 package.json 都没有 `repository` / `homepage` / `bugs` / `author`**
   → npmjs.com 上的包页面会显示 "no homepage / no repo"，GitHub star / issue 入口失效
2. **`@puckguo123/store` 和 `@puckguo123/memory` 完全没有 `files` 字段**
   → `npm publish` 会把整个目录（含 src/、tsconfig.json）都打包进去
3. **这两个包也没有 `license`**
   → npm 会警告（不阻断）
4. **所有包都声明了 `files: ["README.md"]`，但只有 `web` 实际有 README**
   → 其他包的 npm 页面会显示 "no readme"
5. **`@puckguo123/store` 和 `@puckguo123/memory` 用 `workspace:*`，其他包用 `0.1.0` 写死**
   → 需要统一改成 `^0.1.0`（发布后用户装的版本范围必须兼容）
6. **`@puckguo123/features` 完全没有 `main` / `types` 字段**
   → 只有 `exports`，对老式 bundler 不友好，但 Node 22 用 ESM 是 OK 的

---

## 三、仓库结构审计（monorepo 健康度）

### 已 OK 的部分
- ✅ `tsconfig.json` 用 references 把 11 个子包串成完整图
- ✅ TypeScript 5.9 增量构建（`tsc -b`）
- ✅ 148 个测试 143 通过 + 5 skipped（real API）
- ✅ workspace `packages/*` 标准 npm + pnpm 兼容

### 待修复的部分
- ❌ **没有 `.gitignore`**（一旦 `git init` 就会跟踪 `node_modules/` 和 `.puck/`）
- ❌ **没有 `.npmignore` 或 `package.json#files`**：CLI 包 `files: ["dist", "README.md"]` 已 OK，但 `store` / `memory` 完全没设
- ❌ **没有 `LICENSE` 文件**（虽然 package.json 写了 `"license": "MIT"`）
- ❌ **没有 `CONTRIBUTING.md`**
- ❌ **没有 `SECURITY.md`**（披露漏洞流程）
- ❌ **没有 `CHANGELOG.md`**（changesets 会自动生成）
- ❌ **没有 GitHub Actions / CI**（PR 不会自动跑 typecheck + test）

---

## 四、目录建议（开源后的理想布局）

```
puck/                                    # 仓库根
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                       # PR: typecheck + test
│   │   └── release.yml                  # main: changesets → npm publish
│   └── ISSUE_TEMPLATE/
│       ├── bug.md
│       └── feature.md
├── .changeset/
│   ├── config.json                      # changesets 配置
│   └── README.md                        # 第一个 changeset
├── .gitignore                           # 见 .gitignore 草案
├── .npmignore                           # 根目录兜底（各 package 已自带）
├── .nvmrc                               # 22.18.0
├── .editorconfig
├── LICENSE                              # MIT
├── README.md                            # 已有 → 需加徽章 + 链接
├── CONTRIBUTING.md
├── SECURITY.md
├── package.json                         # 根：workspaces + devDeps
├── tsconfig.json
├── tsconfig.base.json
├── tsconfig.check.json
├── packages/
│   └── (11 个子包，package.json 需补 metadata)
├── tests/                               # 跨包集成测试
├── examples/                            # 用法示例
├── docs/                                # 文档站源
├── bench/                               # benchmark（保留，但要 README 说明）
│   ├── README.md                        # 解释怎么跑、怎么读结果
│   ├── tasks/
│   ├── fixture-template/                # 模板（公开）
│   └── results/                         # 把 results*.json / run.log 挪到这里
└── scripts/
    ├── clean.mjs                        # 已有
    └── audit-publish.mjs                # 新增：发布前自检（见下）
```

### `bench/home/` 处置

整个 `bench/home/` 目录包含真实 codex / puck 安装数据，**绝对不能进 git**。但 `bench/runner.mjs` 等 benchmark 脚本需要写到一个 home dir 来跑。两种方案：

| 方案 | 说明 |
|---|---|
| **A. `bench/home/.gitkeep` + `.gitignore`** | 保留目录结构 + 一个 `.gitkeep` 占位，runner 跑测试时把临时数据写到这里（被 git 忽略） |
| **B. `bench/.home-template/`** + 首次运行 copy | 模板 commit 进 git，runner 启动时拷贝到 `bench/home/`（被 git 忽略） |

我推荐 A：简单，跟现有 `bench/runner.mjs` 行为一致。

---

## 五、待我交付的产物（Phase 1）

按 PUBLISH-PLAN.md 的 Phase 1，我接下来会写：

### 1. `.gitignore` 草案
详见 `.gitignore` 草案文件（下一步创建）。

### 2. `scripts/audit-publish.mjs`
发布前自检脚本，强制验证：
- 每个 `package.json` 缺哪些必备字段
- `npm pack --dry-run` 看每个包会被发布的文件清单
- 检测泄漏的敏感文件（`auth.json` / `.puck/` / `brainstorm.md` / `void` 等）
- 检测 `pnpm-lock.yaml` + `package-lock.json` 是否并存
- 检测所有 inter-package dep 是否还在 `workspace:*`

### 3. 各 package.json 补丁草案
11 个 package.json + 1 个根 package.json，全部用 `npm pkg set` 命令写成脚本，可以一键 dry-run。

### 4. `LICENSE` (MIT)
标准 MIT 文本。

### 5. 删除 `bench/home/puck/auth.json` 之类敏感文件的清单
（含确切路径 + 删除理由 + 删除前必须确认的备份策略）

### 6. README 增强草案
加 shields.io 徽章 + "What is puck?" + 安装命令 + 链接到 docs/。

---

## 六、我现在还**不会**做的（等你确认决策点）

这些需要先回答 PUBLISH-PLAN.md 的 6 个决策点：

- ❌ 不删除任何文件（除了上面提到的敏感文件，等你签字才动）
- ❌ 不创建 `LICENSE` / `CONTRIBUTING.md` / `SECURITY.md`（授权是法律行为）
- ❌ 不修改任何 `package.json`
- ❌ 不创建 GitHub 仓库
- ❌ 不跑 `npm publish`
- ❌ 不装 changesets / release-please

---

## 七、本审计的口径（自查）

| 检查项 | 方法 | 结果 |
|---|---|---|
| 高风险文件 | 列出 `bench/home/puck/auth.json` 等 + 估算密钥暴露风险 | ✅ 已列 |
| package.json 完整性 | 11 个 × 14 个字段 = 154 项 | ✅ 已列 |
| 仓库结构 | 与典型 monorepo 对照 | ✅ 已列 |
| 文档完整性 | LICENSE / README / CHANGELOG / CONTRIBUTING | ✅ 已列 |
| CI 完备性 | GitHub Actions 存在性 | ✅ 已列 |
| 与上游合规 | 不引用 pi/codex/DeepSeek 代码（仅参考设计） | ⚠️ 待你确认（README 写了 "参考 pi、codex、DeepSeek Harness 三个开源框架的设计"，这个是合规的——设计参考不构成代码抄袭） |
