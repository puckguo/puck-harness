---
name: lark
version: 1.0.0
description: "飞书/Lark 全家桶（25 个子技能）：云文档、多维表格、电子表格、幻灯片、画板、知识库、即时通讯、邮箱、日历、视频会议、妙记、任务、OKR、审批、考勤、通讯录、实时事件，以及认证/身份/scope 管理。任何飞书/Lark 操作先加载本包看路由表；子技能按 lark/<名称> 寻址。"
metadata:
  requires:
    bins: ["lark-cli"]
  cliHelp: "lark-cli --help"
---

# lark 技能包

> **前置条件：** 任何 `lark-cli` 命令执行前，先读 `lark/lark-shared`——认证、`--as user/bot` 身份选择、scope 管理、Permission denied 处理都在那里。
> **寻址：** 子技能用 `lark/<名称>` 加载，如 `lark/lark-base`、`lark/lark-doc`。
> **兜底：** 现有子技能都不覆盖的需求，先试 `lark/lark-openapi-explorer` 找原生 OpenAPI。

## 路由表：按用户意图选子技能

### 我要操作文档 / 内容创作

| 意图 | 子技能 |
|---|---|
| 创建/编辑飞书在线文档（docx） | `lark/lark-doc` |
| Markdown 文件的创建与编辑 | `lark/lark-markdown` |
| 幻灯片（创建、读页、局部替换） | `lark/lark-slides` |
| 画板（导出图片/节点、DSL/PlantUML/Mermaid 更新） | `lark/lark-whiteboard` |
| 知识库（空间、成员、节点层级） | `lark/lark-wiki` |

### 我要操作表格 / 数据

| 意图 | 子技能 |
|---|---|
| 多维表格 Base（建表、字段、记录、视图、数据分析） | `lark/lark-base` |
| 电子表格（工作表、单元格、批量读写、导出） | `lark/lark-sheets` |
| 按名称/关键词先定位云空间里的表格/报表 | `lark/lark-doc`（docs +search 做资源发现） |
| 本地 Word/Markdown/Excel/CSV 导入成在线文档/表格/Base | `lark/lark-drive`（drive +import） |

### 我要沟通 / 协作

| 意图 | 子技能 |
|---|---|
| 发消息、回复、搜聊天记录、群管理、聊天文件 | `lark/lark-im` |
| 写信/回信/转发/搜邮件/附件/收信规则 | `lark/lark-mail` |
| 日程（创建/更新/参会人/忙闲/会议室预订） | `lark/lark-calendar` |
| 姓名换 open_id、查部门/邮箱/联系方式 | `lark/lark-contact` |

### 我要开会 / 多媒体

| 意图 | 子技能 |
|---|---|
| 历史会议查询、会议纪要/逐字稿、参会人快照 | `lark/lark-vc` |
| 机器人代为入会/离会、读取会中实时事件 | `lark/lark-vc-agent` |
| 妙记（音视频转纪要/逐字稿/总结/待办） | `lark/lark-minutes` |

### 我要管理工作 / 目标

| 意图 | 子技能 |
|---|---|
| 待办任务、清单、任务智能体 | `lark/lark-task` |
| OKR（目标、关键结果、对齐、进展） | `lark/lark-okr` |
| 审批实例与审批任务 | `lark/lark-approval` |
| 考勤打卡记录 | `lark/lark-attendance` |

### 高级 / 自动化

| 意图 | 子技能 |
|---|---|
| 实时事件流（NDJSON 监听消息/表情/成员变更） | `lark/lark-event` |
| 把飞书 API 封装成新的自定义 Skill | `lark/lark-skill-maker` |
| 现有技能都不覆盖 → 找原生 OpenAPI | `lark/lark-openapi-explorer` |

### 编排好的工作流（多技能组合，优先用）

| 意图 | 子技能 |
|---|---|
| 汇总一段时间会议纪要生成结构化报告 | `lark/lark-workflow-meeting-summary` |
| 今天的日程 + 未完成任务摘要（standup） | `lark/lark-workflow-standup-report` |

## 易混淆分流

- **在线文档 docx vs Markdown**：在线协作文档用 `lark-doc`；本地 `.md` 文件用 `lark-markdown`。
- **Base vs Sheets**：多维表格（结构化字段/视图/公式/跨表）用 `lark-base`；传统行列电子表格用 `lark-sheets`。
- **日历 vs 会议**：未开始的会议日程在 `lark-calendar`；已结束的会议/纪要在 `lark-vc`；会中实时事件在 `lark-vc-agent`。
- **导入入口**：本地文件导入成飞书在线文档走 `lark-drive +import`，不要直接用 doc/sheets 建。
- **wiki 链接**：`/wiki/{token}` 链接先经 `lark-wiki` 解析，最终落在哪类对象再分流到对应子技能。

## 子技能清单（25）

lark-approval · lark-attendance · lark-base · lark-calendar · lark-contact · lark-doc · lark-drive · lark-event · lark-im · lark-mail · lark-markdown · lark-minutes · lark-okr · lark-openapi-explorer · lark-shared · lark-sheets · lark-skill-maker · lark-slides · lark-task · lark-vc · lark-vc-agent · lark-whiteboard · lark-wiki · lark-workflow-meeting-summary · lark-workflow-standup-report
