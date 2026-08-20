# puck 性能评估与横向对比协议

> 目标：①量化 puck 自身性能；②与 pi / codex-cli / dsh（deepseek harness）做**公平**的真实对比。

## 0. 你已经有的：puck 生产遥测

每轮自动落盘 `~/.puck/timings.jsonl`（REPL 和 one-shot 都记）：

```jsonc
{ "durationMs": 5799, "ttftMs": 976, "llmMs": 2242, "toolMs": 3556,
  "inputTokens": 994, "outputTokens": 112, "outputTokensPerSecond": 50,
  "toolCalls": 1, "stopReason": "toolUse", "isError": false, "turn": 0 }
```

速览：`puck timing`（CLI 命令）/ `puck timing dashboard`（HTML）。日常用就会持续积累。

## 1. 先分清"性能"的四层——对比对象必须钉死

| 层 | 指标 | 由谁决定 | 能对比吗 |
|---|---|---|---|
| **LLM 层** | TTFT、生成 tok/s | 模型+provider | ❌ 不测这个，只**控制变量** |
| **harness 开销层** | turn 边界间隙（tool_end→下一请求发出）、工具调度延迟、进程启动、流式渲染 CPU | harness | ✅ **核心对比对象** |
| **任务层** | 端到端完成时间、token 用量/成本、工具调用数、成功率（测试过没过） | 两者混合 | ✅ 但要拆开归因 |
| **UX 层** | 首字节→首渲染延迟、滚动干净度 | harness | ✅ PTY 录制评估 |

关键认知：端到端时间里 LLM 占 90%+，**harness 的差异藏在缝隙里**（turn 间隙、调度、重试策略、上下文管理效率）。对比 harness = 同模型同任务下测缝隙。

## 2. 基准协议（四家通用）

### 2.1 控制变量（缺一即作废）

- **同一模型 id + provider + API key**（`glm-5.3` 就都 `glm-5.3`；换模型=没测 harness）
- 同机、同一时段**交错跑**（ABBA 顺序，吸收 provider 负载波动）
- 每任务 **≥3 次**，报中位数 + p90
- 每次运行**全新会话**（杜绝上下文缓存污染 input tokens 可比性）
- 任务文本逐字相同，cwd 相同的 fixture 仓库

### 2.2 任务套件（bench/tasks/，六类代表负载）

| # | 任务 | 测什么 |
|---|---|---|
| T1 | 纯问答（"这个项目用什么构建？"） | TTFT、流式吞吐、零工具路径 |
| T2 | 单读定位（"X 函数在哪，做什么"） | read 工具一次往返 |
| T3 | 单改+验证（"改 X 让测试过"） | edit+bash 循环、成功验证 |
| T4 | 多步重构（跨 3+ 文件） | 多 turn 边界、上下文增长 |
| T5 | 长上下文（贴大文件提问） | 上下文管理、token 效率 |
| T6 | 故障恢复（诱导一个报错） | 错误处理、重试策略 |

fixture 仓库：固定的小 git repo（含测试），每轮 `git reset --hard` 复位。

### 2.3 采集：外部黑盒 + 自报交叉验证

**外部黑盒**（对四家一视同仁，无仪表偏差）：
```bash
# wall clock + 输出事件时间线（首个输出字节 / 首个工具行 / 结束）
time puck  -m glm-5.3 "$(cat bench/tasks/t3.md)"
time codex exec --json  -m glm-5.3 "$(cat bench/tasks/t3.md)"   # 事件流自带时间戳
# pi / dsh 同理用各自的非交互模式
```

**自报日志**（细粒度指标，各家格式不同但字段可对齐）：

| harness | 来源 | 可提取 |
|---|---|---|
| puck | `~/.puck/timings.jsonl` | ttft/llmMs/toolMs/tok/s/tokens/错误 |
| codex | `codex exec --json` 事件流 | 每事件时间戳、token 用量、turn 边界 |
| pi | `~/.pi/sessions/*.jsonl` | 消息时间戳、usage |
| dsh | 其会话日志 | 同上 |

两者对不上时信外部黑盒。UX 层用现成的 PTY 录制法（scripts/vt.cjs 那套）抓首渲染延迟。

### 2.4 汇报表（每个 harness × 每任务一格）

```
            T1问答      T2单读      T3单改      T4重构     T5长文    T6恢复
端到端中位   …          …          …           …         …        …
p90         …
tokens(↓)   …          （成本列单列——系统提示词不同导致的用量差算 harness 效率，但须注明）
工具调用数   …
成功率       …          （T3/T4 以测试通过为准）
```

## 3. 已知陷阱

1. **模型不同=没测 harness**。最常见也最致命的错误。
2. **provider 缓存**：prompt caching 命中会让 input tokens 骤降且各家策略不同 → 全新会话 + 单列成本。
3. **系统提示词差异**：codex 的提示词可能比 puck 重 → token 用量差是真实的"harness 效率"，但要在结论里拆开说，别混进延迟。
4. **网络抖动**：单次运行毫无意义，必须交错+重复+中位数。
5. **ConPTY 开销**：PTY 录制本身有延迟，UX 指标只测"首渲染相对首字节"的差值，不测绝对时间。

## 6. puck 自身的性能红线（持续监控）

从现有遥测直接可得，建议看板关注：

- **turn 间隙** = durationMs − llmMs − toolMs：>200ms 说明调度有浪费
- **TTFT 中位数漂移**：模型侧回归的哨兵
- **错误率**（当前 GLM 7% vs MiniMax 0%）：重试策略的有效性
- **isError 轮的恢复成本**：错误后下一轮的 inputTokens 增量

## 下一步（可选）

建 `bench/`：`tasks/*.md` + fixture repo + `run.js`（交错调度四家、解析各自日志、出汇总表）。一次搭好，以后每个版本回归跑一遍。
