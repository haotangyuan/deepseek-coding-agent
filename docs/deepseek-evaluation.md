# DeepSeek 专项评测基线

> 建立日期：2026-07-15
> 项目起始提交：`679bc71464f714be581472f7383bbb51d72d0b23`
> Pi 研究源码：`dcfe36c79702ec240b146c45f167ab75ecddd205`
> Pi SDK：`@earendil-works/pi-coding-agent@0.80.7`
> 当前评测输出协议：Schema v2

## 1. 目的与边界

这套评测回答三个问题：一次请求是否完成、工具循环是否可靠、质量提升是否值得增加的延迟和成本。它不是通用大模型排行榜，也不修改 Pi Agent Loop。

源码确认的边界：

- `src/main.ts` 继续通过 `createAgentSession()` 创建 Session；`thinkingLevel` 使用 SDK 的真实选项。
- `src/evaluation.ts` 只订阅 `AgentSessionEvent` 并读取 `getSessionStats()`，不介入消息或工具执行。
- `src/eval.ts` 通过产品 CLI 跑真实链路，不直接拼 DeepSeek HTTP 请求。
- `--ephemeral` 使用 Pi `SessionManager.inMemory()`，评测不会污染日常 JSONL 会话。
- 三个 repair 任务只在系统临时目录自动批准 write/edit；Bash 始终拒绝，测试由评测器执行，结束后删除 fixture。
- `repair-feedback` 的隐藏测试在 Agent 工作区外；失败只回填 evaluator 生成的最小摘要，不暴露测试源码、路径或堆栈。
- 每次 repair Agent 尝试最多 60 秒；超时通过 `AbortSignal` 调用 Pi `AgentSession.abort()`，不只是在外层放弃等待。
- 自动化只用事件替身和内存对象；真实 API 必须显式增加 `--live`。

设计推断：稳定的产品优化应当建立在同一任务、同一模型、同一 thinking 档位和多次样本上。单次 smoke 只能证明链路可用，不能证明模型或档位更优。

## 2. 官方协议与本地实现对照

| 事实 | 官方依据 | Pi / 本项目处理 |
|---|---|---|
| V4 Flash/Pro 都支持 thinking、工具调用、1M context | [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) | 模型和价格来自安装包 `pi-ai/dist/providers/deepseek.models.js` |
| thinking 默认开启；OpenAI 兼容格式接受 `high/max` | [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) | Pi `openai-completions` 把 `high/max` 写入 `reasoning_effort`；CLI 只暴露 `off/high/max` |
| 工具轮次要回放 reasoning context | [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) | 由 Pi DeepSeek compat 的 `requiresReasoningContentOnAssistantMessages` 处理 |
| 缓存按重复前缀自动命中并返回 usage | [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) | Pi 把 `prompt_cache_hit_tokens` 归入 `cacheRead`；本项目计算命中率 |
| 非 strict 工具参数仍可能无效 | [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) | 保留 Pi Schema 校验和工具错误回填；固定任务验证失败后恢复 |
| 400/401/402/422 不应盲目重试，429/500/503 需区分 | [Error Codes](https://api-docs.deepseek.com/quick_start/error_codes) | 当前记录 provider error/retry；可行动错误分类仍是 M6 后续项 |

不把 temperature、top_p 当作 thinking 调优旋钮；不默认启用 Beta strict mode 或 FIM。

### 2.1 Claude Code 与 Codex CLI 的产品参考

本项目只借鉴与当前本地评测直接相关的边界，不复制完整命令集合。2026-07-15 核对本机 Claude Code `2.1.210`、Codex CLI `0.144.1` 及官方文档后，采纳以下原则：

| 参考能力 | 官方依据 | 本项目取舍 |
|---|---|---|
| 非交互执行与流式 JSON | [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) 的 print/output-format；[Codex CLI reference](https://developers.openai.com/codex/cli/reference) 的 exec/JSON | `npm run eval` 输出 NDJSON；每次请求是 `eval_result`，最后是 `eval_summary` |
| 结构化最终结果 | Claude `--json-schema`；Codex `--output-schema` | 当前由确定性评测器生成固定 Schema，不要求模型自己声明成功 |
| 成本/工作量边界 | Claude `--max-budget-usd`、`--max-turns` | 增加 `--max-cost-usd`；它按 Provider 已返回的累计 usage 在请求间停止，不伪称能预知单次请求成本 |
| 权限与隔离 | Claude allowed/disallowed tools、permission mode；Codex workspace-write sandbox 与 ephemeral | repair 运行在临时目录，只批准 write/edit，拒绝 Bash；使用 Pi 内存 Session，不污染日常会话 |

暂不实现 Claude 的 Plan Mode 或 Codex 的完整 sandbox profile。前者需要明确设计“只读计划 → 用户确认 → 执行”的会话状态转换，后者需要 OS 级执行后端；把它们压进当前评测器会混淆产品策略与真正的系统隔离。

## 3. 使用方式

先构建，然后查看评测计划。默认命令不会调用 API：

```bash
npm run build
npm run eval -- --task all --model deepseek-v4-flash --thinking high
```

显式运行真实评测：

```bash
npm run eval -- --live --task all --model deepseek-v4-flash --thinking high --runs 1 --max-cost-usd 0.02
```

对比档位或模型时分开执行，保留每行 NDJSON 结果：

```bash
npm run eval -- --live --task all --model deepseek-v4-flash --thinking max --runs 3
npm run eval -- --live --task all --model deepseek-v4-pro --thinking high --runs 3
```

`--runs` 限制为 1–5。Pro 必须显式选择，不存在自动升级。建议先 dry-run 检查 `sampleCount`、`maxProviderRequests` 和 `maxCostUsd`，再决定是否付费执行。默认上限为 0.02 美元；累计已知成本达到上限后不再开始下一次请求，最终超过上限则汇总失败。由于真实成本只能在一次请求完成并返回 usage 后计算，这是一条请求间的观测边界，不是 Provider 侧预授权的硬预算。

输出协议固定为 NDJSON。Schema v2 的 dry-run 只有一条 `eval_plan`，其中 `sampleCount` 是逻辑样本数，`maxProviderRequests` 是包含最多一次反馈修复后的调用上限；真实执行每个样本一条 `eval_result`，最后一条 `eval_summary`。repair 结果包含每次尝试的短输出、测试状态和指标，但不记录完整 reasoning、工具结果、隐藏测试或凭据。

一次性 CLI 也可单独输出指标：

```bash
npm start -- --ephemeral --metrics --thinking high --approval deny "Reply with OK"
```

`[metrics]` 写到 stderr，普通答案仍写 stdout。

## 4. 固定任务与判定

| 任务 | 工具策略 | 通过条件 | 主要验证点 |
|---|---|---|---|
| `exact` | deny | 最终文本严格等于 `EVAL_OK` | 最小生成、reasoning/text 流 |
| `read-package` | auto-read | 调用工具成功且严格返回 package name | Tool Call、Schema、结果回填 |
| `missing-file-recovery` | auto-read | 工具失败且最终严格返回 `RECOVERED` | 错误结果回填和模型恢复 |
| `repair-js` | 临时目录内 write/edit | Agent/工具成功、测试通过、测试文件未变、源码已变 | 读代码、真实修改和确定性外部评分 |
| `repair-multi-file` | 临时目录内 write/edit | Agent/工具成功、两个目标源码都改变、原文件无缺失、入口和测试不变、无额外文件、测试通过 | 多文件定位、完整执行和防止投机修改 |
| `repair-feedback` | 临时目录内 write/edit；隐藏测试在目录外 | 第一轮测试失败、第二轮使用摘要恢复、两个目标源码改变、测试通过、工具错误不超过 5 次 | act → verify → repair 和反馈质量 |

前三项是低成本协议基线，最终输出保持全文严格匹配。repair 链路可能在工具轮次间产生可见的解释文本，因此模型文本只作为短诊断摘要，不参与通过判定；正确性由 Agent/工具状态、文件完整性和外部测试共同决定。`repair-feedback` 使用两个独立的 Pi 内存 Session，但共享同一临时工作区：第二个 Agent 根据测试摘要重新读取当前源码，不伪装成同一模型会话。修改类任务继续只在隔离目录执行。

## 5. 指标定义

| 指标 | 定义 | 注意事项 |
|---|---|---|
| `firstResponseMs` | 从提交到首个 reasoning/text/tool 事件 | 接近首个可观察 token，不等于网络层精确 TTFT |
| `firstTextMs` | 从提交到首个最终文本增量 | thinking 任务通常明显晚于首响应 |
| `durationMs` | 从提交到 `prompt()` 完成 | 包含工具轮次 |
| `reasoningChars` / `textChars` | 流式增量字符数 | SDK 未单列 reasoning token，因此不能伪称精确 token |
| `toolCalls/successes/errors` | 工具开始及执行结果计数 | 参数解析失败可能在工具开始前失败，应结合事件序列分析 |
| `retries/providerErrors` | Pi 自动重试和 Provider 错误事件数 | 用于判断稳定性，不记录凭据或完整响应 |
| `providerErrorCategories` | 本项目依据官方语义归类的 Provider 错误 | 只改善诊断，不改变 Pi 的重试决策 |
| `cacheHitRate` | `cacheRead / (input + cacheRead + cacheWrite)` | 基于 Pi 归一化 usage；DeepSeek 当前 cacheWrite 为 0，评测 Schema 仍以 0 表示无 prompt token |
| `tokens/costUsd` | Pi Session 累计统计 | 成本使用当前模型 catalog 单价，价格变化后需重新核对 |
| `eventSequence` | 去除连续重复后的事件类别，最多 64 项 | 便于检查主链路，不保存完整 reasoning 或工具内容 |
| `attemptCount/feedbackRounds` | 一个逻辑样本实际使用的 Agent 尝试和反馈轮数 | 用于区分任务样本与 Provider 请求 |
| `feedbackChecks` | 首次失败、反馈后恢复、工具错误上限 | 防止“最终碰巧通过但过程严重抖动”被记为可靠恢复 |

## 6. 错误诊断与重试边界

`src/deepseek-errors.ts` 消费 Pi 已归一化的错误字符串，并生成 category、status、retryable 和 action。它不发请求，也不自行 sleep/retry。

| 状态 | 分类 | 产品提示 | 重试边界 |
|---:|---|---|---|
| 400 | `invalid_format` | 检查请求体、工具 Schema 和 reasoning replay | 不自动建议重试 |
| 401 | `authentication` | 检查本地环境变量或 Pi 凭据 | 人工修复后再试 |
| 402 | `insufficient_balance` | 检查余额并充值 | 人工修复后再试 |
| 422 | `invalid_parameters` | 检查模型 ID 和请求参数 | 修改参数后再试 |
| 429 | `rate_limit` | 等待 Pi backoff，持续发生时降低并发 | 可重试 |
| 500 | `server_error` | 短暂等待，持续发生时联系服务方 | 可重试 |
| 503 | `server_overloaded` | 等待服务负载恢复 | 可重试 |
| 无状态网络错误 | `network` | 检查网络、代理和 DNS | 连接恢复后可重试 |

源码事实：Pi `isRetryableAssistantError()` 已识别限流、5xx 和常见网络文本，`AgentSession` 负责指数退避和 `auto_retry_*` 事件。本项目只把这些事件转成 DeepSeek 可行动诊断，避免产生第二套重试状态机。
当 `auto_retry_start` 已发生但错误文本无法细分时，界面以 Pi 的实际决定显示 `retryable=yes`，不会让静态分类与运行状态相互矛盾。

## 7. 受控 Smoke 与重复评测

所有调用使用本地忽略的 `.env`，未读取或打印密钥；Session 为内存模式。

| 模型 / thinking / 任务 | 结果 | 首响应 | 总耗时 | cache hit | 成本 |
|---|---:|---:|---:|---:|---:|
| Flash / high / exact | 通过 | 971 ms | 1347 ms | 92.75% | $0.000016352 |
| Flash / high / read-package | 通过，1 次工具成功 | 1054 ms | 2513 ms | 95.10% | $0.0001399272 |
| Flash / high / missing-file-recovery | 通过，1 次工具错误后恢复 | 1071 ms | 2497 ms | 97.54% | $0.0000966672 |
| Flash / max / exact | 通过 | 744 ms | 1049 ms | 0% | $0.00011578 |
| Pro / high / exact | 通过 | 835 ms | 1209 ms | 0% | $0.00032277 |
| Flash / high / repair-js | 通过，3 次工具成功，外部测试通过 | 1142 ms | 4212 ms | 68.95% | $0.0009056432 |
| Flash / high / repair-multi-file | 通过，6 次工具成功，两个目标文件修改且外部测试通过 | 1045 ms | 7579 ms | 88.71% | $0.0005783456 |
| Flash / high / repair-feedback | 通过；首轮失败、第二轮恢复；6 次工具成功、0 错误 | 1369 / 850 ms | 16330 ms | 92.15% / 96.59% | $0.0008691984 |

事实：既有任务与新增反馈恢复任务均完成预期链路。`repair-feedback` 的首次预验证曾超过 2 分钟且没有结果，因此增加了真实 Session abort；随后直接回填 TAP 输出虽然功能通过，却造成 36 次工具调用和 31 次工具错误。改成不含路径/堆栈的 evaluator 摘要后，最终样本用两轮、6 次成功工具调用和 0 次工具错误完成，且总成本下降到 $0.0008691984。推断限制：这是单个最终样本，不能据此宣称优化具有统计显著性；它只证明新闭环可工作，并提供了值得重复测量的反馈格式假设。

### 7.1 2026-07-16 repair-feedback 三次重复

固定 `deepseek-v4-flash + high`、同一 fixture 和短摘要策略，运行 3 个逻辑样本、最多 6 次请求，预算 `$0.01`。结果没有保存完整 reasoning、工具内容或会话。

| 指标 | 结果 |
|---|---:|
| 恢复成功 | 3/3 |
| 首轮按预期失败 | 3/3 |
| 第二轮恢复 | 3/3 |
| Provider 请求 | 6 |
| 工具调用 | 每样本 2 + 3 |
| 工具错误 | 0 |
| 首轮平均耗时 / 首响应 | 5183 ms / 608 ms |
| 反馈轮平均耗时 / 首响应 | 7481 ms / 566 ms |
| 首轮 / 反馈轮平均 cache hit | 92.23% / 97.12% |
| 平均单样本成本 | $0.000656251 |
| 总成本 | $0.001968753 |

源码确认事实：3 次都经过完整的“外部隐藏测试失败 → evaluator 最小摘要 → 新内存 Session 读取共享工作区 → 修复 → 隐藏测试通过”。设计推断：短摘要在这个固定小任务上表现稳定，并显著避免了之前 31 次工具错误的抖动；但样本同质且只有 3 次，不能推广为所有真实仓库或模型档位的统计结论。

## 8. 优化准入与回滚

任何 prompt、工具描述或上下文策略变化都按以下顺序验证：

1. 固定变更前 commit、Pi SDK、模型、thinking、任务和 fixture。
2. 先跑自动化，再以相同矩阵执行至少 3 次真实任务。
3. 同时比较完成率、工具成功率、错误恢复、首响应、总耗时、token、cache hit 和成本。
4. 质量不升、成本显著增加，或只在单次样本有效时，不进入默认路径。
5. 结果中只保留短输出、指标和必要错误分类；不提交 `.env`、完整 reasoning、会话 JSONL 或敏感日志。

## 9. 下一步

- 对 80 列恢复卡片做真实网络抖动观察；自动化继续用事件替身覆盖错误与重试，避免为了制造失败调用付费 API。
- 将 `repair-js`、`repair-multi-file` 也各重复至少 3 次，形成无反馈/多文件/反馈恢复三组基线。
- 用重复稳定前缀和冷/热两组运行单独研究缓存，不把自然命中当成可控实验。
- 量化大 read/tool result 的截断和按需读取策略。
- 只有在普通 Schema 失败样本足够明确后，再在 playground 研究 strict tool mode。
