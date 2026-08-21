# 双层 Skill 系统：Skill Pack（技能包）设计分析

> 状态：设计提案（RFC）。基于 v0.1.0 的 `packages/features/src/skills`（约 230 行）与
> 本机真实数据（60 个技能，其中 25 个 `lark-*`）验证得出。

## 1. 现状：单层扁平模型

```
~/.puck/skills/<name>/SKILL.md     ← puck 原生
~/.claude/skills/<name>/SKILL.md   ← 跨 harness 互认
~/.codex/skills/<name>/SKILL.md
~/.pi/skills/<name>/SKILL.md
```

加载路径：`loadHarnessSkillsDetailed()` 把四个目录**平铺扫描、按名去重、合并成一个数组**，
`skillsToPrompt()` 把所有 description 一股脑塞进 system prompt，`createSkillTool()`
暴露一个 `skill` 工具按需加载正文。

**两层已经存在于语义中，只是没有被物化**：

- lark 系列的 SKILL.md 开头写着 `> 前置条件：先阅读 ../lark-shared/SKILL.md`——
  包结构靠**相对路径约定 + 模型自觉**维系，harness 完全不知情；
- `skill` 工具的 description 里拼了全部 60 个技能名（枚举注入），本来就快撑不住了。

### 真实测量（本机，2026-08）

| 指标 | 数值 |
|---|---|
| 技能总数 | 60（含 1 个跨 harness 重名去重） |
| 其中 lark-* | 25（占 42%） |
| 修复 CRLF 解析 bug 后完整 skillsToPrompt | **11,254 字符**（≈ 4-5K tokens） |
| 其中 lark 25 个的 description 占 | 5,672 字符（50%） |
| lark 各包 references/ 总体积 | ~5.6 MB（lark-slides 一个 4MB/64 文件） |

也就是说：**用户可能一辈子只用飞书，却要为 25 个 lark 技能的描述常驻买单；
反过来，只用 GitHub 工作流的用户也在为飞书买单**。这正是 skill pack 要解决的问题。

## 2. 设计目标

1. **一个名字，一个入口**：system prompt 里只出现 `lark` 一行（“飞书全家桶，25 个子技能”），
   模型决定用飞书时才展开看到 `lark-base / lark-doc / ...` 的清单。
2. **零迁移成本**：现有 61 个平铺技能目录原样可用；skill pack 是**可选的包装层**，
   不是新格式强加于人。
3. **实现小**：skills 模块当前约 230 行，双层逻辑应以百行为量级追加，不引入新依赖
   （零依赖是 puck 的核心卖点）。
4. **路径稳定**：`skill` 工具的参数枚举不能爆炸；嵌套技能通过 `pack/name` 寻址。

## 3. 提案：`SkillPack` 作为一等公民

### 3.1 目录约定（向后兼容）

```
~/.claude/skills/
  lark/                        ← 一个 skill pack
    PACK.md                    ← 包清单：name/description/子技能路由表
    lark-base/SKILL.md         ← 子技能：普通 skill 原样嵌套
    lark-doc/SKILL.md
    ...
  review/                      ← 普通技能：不变，单层结构照常加载
    SKILL.md
```

判定规则只有一条：**目录下有 `PACK.md` → 是包；有 `SKILL.md` → 是技能；都没有 → 跳过**。
平铺技能的加载逻辑一行不改。

### 3.2 PACK.md 格式

```markdown
---
name: lark
description: 飞书/Lark 全家桶：文档、多维表格、日历、消息、邮件、视频会议、
  OKR、任务、Wiki、画板等 25 个子技能。需要操作任何飞书资源时加载本包。
---

# lark 技能包

## 子技能路由

| 子技能 | 用途 |
|---|---|
| lark-shared | 认证、身份切换、scope 管理（所有 lark 操作的前置） |
| lark-base | 多维表格：建表、字段、记录、视图、数据分析 |
| lark-doc | 云文档：新建、读取、更新、导出 |
| ... | （由 PACK.md 手工维护，或生成脚本产出） |
```

frontmatter 与 SKILL.md 同构（复用 `parseHeader`），body 就是“加载本包时给模型看的
路由表”。子技能清单**不必手工维护**——`loadSkills(packDir)` 本来就会扫出来，
PACK.md 里只放高层的“什么场景进哪个子技能”的路由提示。

### 3.3 运行时数据模型

```ts
export interface SkillPack {
    name: string;              // "lark"
    description: string;       // 进 system prompt 的那一行
    packInstructions: string;  // PACK.md 全文（含路由表）
    children: Skill[];         // 25 个 lark-*，懒加载展开
    path: string;
}

export interface SkillIndex {  // 替代裸 Skill[] 在 CLI 里流转
    packs: SkillPack[];
    loose: Skill[];            // 不属于任何包的平铺技能
}
```

### 3.4 两阶段加载（这是双层系统的核心）

```
system prompt:  - lark: 飞书全家桶，25 个子技能（文档/表格/日历/...）
                - review: review code          ← 平铺技能照旧
                - deploy: ...                          （35 行，而不是 60 行）

skill 工具调用 skill({name:"lark"})
        ↓ 返回 PACK.md 路由表 + 子技能全名录
模型再调 skill({name:"lark/lark-base"})
        ↓ 返回 lark-base 的 SKILL.md 全文
```

关键点：**`skill` 工具不用改**——`execute` 里按 `/` 拆名字、先查 loose 再查
pack.children，两行的事。enum 里平铺技能名 + 包名 + （可选）`<pack>/*` 通配。
system prompt 从 60 行降到 36 行，token 成本砍半，而模型获得了显式的“先看目录再下钻”
路由路径——这正是人类用飞书文档的方式。

### 3.5 变体：通配 enum vs 严格 enum

- **A（推荐）**：enum = 平铺技能 + 包名。子技能不可直接 enum（必须先加载包才能看到）。
  优点：enum 稳定、强制先读路由表（lark-shared 前置条件就能被路由表保证）。
- **B**：enum 含所有 `pack/child` 全名。省一跳，但 enum 又回到 60 项，
  且模型可能跳过 lark-shared 直接调子技能。

lark 系列的“前置条件：先读 lark-shared”这个真实需求，是选 A 的最强论据。

## 4. 需要动的地方（估算）

| 文件 | 改动 | 量级 |
|---|---|---|
| `packages/features/src/skills/index.ts` | `loadSkillPacks` + `SkillIndex` + skill 工具按 `/` 寻址 + prompt 双层渲染 | ~100-150 行 |
| `packages/cli/src/index.ts` | `/skills` 命令显示包+子技能树；启动横幅统计包数 | ~30 行 |
| `tests/features.test.ts` | pack 加载 / 寻址 / 去重（包名 vs 平铺技能名冲突）/ prompt 渲染 | ~80 行 |
| `docs/usage.md` | skill pack 章节 | ~40 行 |

不需要动：core / tools / session / sdk 的公共 API（`createSkillTool` 签名不变，
只是内部支持嵌套寻址）。

## 5. 备选方案与为什么没选

| 方案 | 为什么不选 |
|---|---|
| **约定式分组**（`lark-*` 前缀自动归包，无 PACK.md） | 零新文件，但路由表无人维护——`lark-shared` 是前置条件这件事机器猜不出来；且 `mmx-cli`、`ask-matt` 这类无前缀家族会误归组 |
| **namespace 参数**（`skill({pack:"lark", name:"base"})`） | 改工具 schema，所有存量调用方（含模型提示词）要跟着改；`/` 寻址对模型更自然（就是路径） |
| **子技能全部隐藏、只留包**（激进版 3.5A） | 用户显式说“用 lark-base”时模型找不到入口；保留 loose 寻址兜底 |
| **把 lark 做成 subagent + 专用工具集** | 那是另一层抽象（subagent 特性），skill pack 解决的是 prompt 预算与路由，两者正交可叠加 |

## 6. 与上游（pi/codex/claude）的兼容性

- PACK.md 是 puck 的扩展：claude/codex 会把它当普通目录**忽略**（无 SKILL.md 就跳过），
  不破坏互认；代价是 pack 内子技能对 claude/codex 不可见——可接受，因为那些
  harness 的用户装的是平铺版（lark 官方分发就是 25 个平铺目录）。
- 若上游未来出现官方嵌套格式（如 claude 的 skill collections），`loadSkillPacks`
  的判定规则收敛到一个函数，换格式只动一处。

## 7. 实施顺序建议（已实施，2026-08-20）

1. ~~CRLF 解析修复~~ ✅（§8）。
2. ~~`loadSkillPacks` + `SkillIndex` + 双层 `skillsToPrompt`~~ ✅ `skillsIndexToPrompt`。
3. ~~`createSkillTool` 支持 `pack/child` 寻址~~ ✅ `createIndexedSkillTool`（enum 含包名，不含子技能）。
4. ~~CLI `/skills` 树状展示 + 启动横幅~~ ✅（包行标注 `[包·N 子技能]`）。
5. ~~本机 lark 25 技能真实验证~~ ✅ `scripts/pack-e2e.cjs`：prompt 11.2K→5.6K（省 50%），行数 60→21，enum 60→35。

## 8. 附：本次分析中发现并修复的 bug

`parseHeader` 的所有行级正则用 `$` 锚点，Windows 作者写的 CRLF SKILL.md
（本机 25 个 lark 技能全部如此）一个都匹配不上——**description 全部静默解析为空**，
system prompt 里是 25 行光秃秃的 `- lark-base`，模型无法路由，双层系统更无从谈起。
修复：入口处 `raw = raw.replace(/\r\n/g, "\n")` 一行归一化（含回归测试）。

这是“分析驱动修复”的直接例证：不跑真实数据，这个 bug 在合成材料的测试里永远不会现形
（既有测试全部用 `\n` 手写 fixture）。
