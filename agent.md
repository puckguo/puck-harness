# puck agent harness — 项目指令

这些规则对所有在本仓库工作的 agent 会话生效。

## 周任务：上游 harness 跟踪（每周一次）

puck 的设计大量参考了 pi / codex / dsh 三个开源 harness。为避免闭门造车，**每周检查一次上游更新并评估是否融合**。

### 流程

1. **跑跟踪脚本**（零依赖，匿名 GitHub API 即可）：

   ```bash
   node scripts/track-upstream.mjs
   ```

   - 有更新 → 生成 `docs/upstream-tracker/reports/<ISO周>.md` 报告骨架（预填 release notes + 最近提交表）
   - 无更新 → 脚本只刷新 `state.json`，本周任务结束
   - 想只看状态不写文件：加 `--check`

2. **填写报告的「分析与融合决策」区**（脚本生成的骨架里已留好模板）。对每个上游：

   - 从材料中挑出**功能层面**的变更（忽略纯 CI / 依赖 bump / 内部重构）
   - 逐条评估是否融合。判断标准按优先级：
     1. 是否符合 puck 的极简 / 可裁切哲学（core 保持 ~700 行零依赖）
     2. 能否做成一个可独立删除的目录 / 子包，而不是必须进 core 的能力
     3. 与现有能力是否重叠（puck 已有的：30+ provider、跨 harness 会话导入、
        四层记忆、空闲后台任务、per-turn 计时、Web UI）
     4. 实现成本与维护负担
   - 决策只有三种：**融合** / **拒绝（写理由）** / **观察（下期再看）**

3. **如果决定融合**：

   - 在 `docs/upstream-tracker/integrations/` 建一个记录文件，命名
     `<ISO周>-<feature-slug>.md`（例：`2026-W34-fullscreen-search.md`），内容包含：
     来源（哪个上游、哪个版本/PR）、puck 侧的实现方案、动到的包、验证方式
   - 实现代码，走正常 PR / commit 流程
   - 在当周 report 的「本周总结」里写一句"融合了什么 + 对应 integrations 文件"

### 目录约定

```
docs/upstream-tracker/
├── state.json          # 上次已知版本（脚本维护，勿手改）
├── reports/            # 每周分析报告（脚本生成骨架 + 人工填写结论）
│   └── 2026-W34.md
└── integrations/       # 每次实际融合的记录（一份融合一个文件）
    └── 2026-W34-<feature>.md
```

### 纪律

- **报告没填「分析与融合决策」= 本周跟踪未完成**，不允许只留脚本骨架
- 拒绝也要写理由——三个月后回头看重评时，理由是唯一依据
- 首次跑脚本（无 state）会为三个上游各建一份"基线报告"，那是快照不是分析；
  从第二次开始才是真正的增量分析
- 不要为了"对齐上游"而融合：puck 的小是特性不是负债
