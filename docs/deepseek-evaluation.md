# DeepSeek 专项评测基线

> 建立日期：2026-07-15
> 项目起始提交：`679bc71464f714be581472f7383bbb51d72d0b23`
> Pi 研究源码：`dcfe36c79702ec240b146c45f167ab75ecddd205`
> Pi SDK：`@earendil-works/pi-coding-agent@0.80.7`

## 1. 目的与边界

这套评测回答三个问题：一次请求是否完成、工具循环是否可靠、质量提升是否值得增加的延迟和成本。它不是通用大模型排行榜，也不修改 Pi Agent Loop。

源码确认的边界：

- `src/main.ts` 继续通过 `createAgentSession()` 创建 Session；`thinkingLevel` 使用 SDK 的真实选项。
- `src/evaluation.ts` 只订阅 `AgentSessionEvent` 并读取 `getSessionStats()`，不介入消息或工具执行。
- `src/eval.ts` 通过产品 CLI 跑真实链路，不直接拼 DeepSeek HTTP 请求。
- `--ephemeral` 使用 Pi `SessionManager.inMemory()`，评测不会污染日常 JSONL 会话。
- `repair-js` 只在系统临时目录自动批准 write/edit；Bash 始终拒绝，测试由评测器执行，结束后删除 fixture。
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

## 3. 使用方式

先构建，然后查看评测计划。默认命令不会调用 API：

```bash
npm run build
npm run eval -- --task all --model deepseek-v4-flash --thinking high
```

显式运行真实评测：

```bash
npm run eval -- --live --task all --model deepseek-v4-flash --thinking high --runs 1
```

对比档位或模型时分开执行，保留每行 NDJSON 结果：

```bash
npm run eval -- --live --task all --model deepseek-v4-flash --thinking max --runs 3
npm run eval -- --live --task all --model deepseek-v4-pro --thinking high --runs 3
```

`--runs` 限制为 1–5。Pro 必须显式选择，不存在自动升级。建议先 dry-run 检查 `requestCount`，再决定是否付费执行。

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
| `repair-js` | 临时目录内 write/edit | 测试通过、测试文件未变、源码已变、最终文本为 `FIXED` | 读代码、真实修改和确定性外部评分 |

前三项是低成本协议基线；`repair-js` 是第一项真实编码 fixture，但仍不足以代表复杂项目质量。后续应增加多文件修复、失败测试反馈、长上下文恢复和 Compaction 任务。修改类任务继续只在隔离目录执行。

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
| `cacheHitRate` | `cacheRead / (input + cacheRead)` | 基于 Pi 归一化 usage；0 可能表示未命中或 Provider 未返回 |
| `tokens/costUsd` | Pi Session 累计统计 | 成本使用当前模型 catalog 单价，价格变化后需重新核对 |
| `eventSequence` | 去除连续重复后的事件类别，最多 64 项 | 便于检查主链路，不保存完整 reasoning 或工具内容 |

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

## 7. 2026-07-15 受控 Smoke

所有调用使用本地忽略的 `.env`，未读取或打印密钥；Session 为内存模式。

| 模型 / thinking / 任务 | 结果 | 首响应 | 总耗时 | cache hit | 成本 |
|---|---:|---:|---:|---:|---:|
| Flash / high / exact | 通过 | 971 ms | 1347 ms | 92.75% | $0.000016352 |
| Flash / high / read-package | 通过，1 次工具成功 | 1054 ms | 2513 ms | 95.10% | $0.0001399272 |
| Flash / high / missing-file-recovery | 通过，1 次工具错误后恢复 | 1071 ms | 2497 ms | 97.54% | $0.0000966672 |
| Flash / max / exact | 通过 | 744 ms | 1049 ms | 0% | $0.00011578 |
| Pro / high / exact | 通过 | 835 ms | 1209 ms | 0% | $0.00032277 |
| Flash / high / repair-js | 通过，3 次工具成功，外部测试通过 | 1142 ms | 4212 ms | 68.95% | $0.0009056432 |

事实：6 次 smoke 均通过，Flash/high 的协议工具任务和隔离修复都完成了预期循环；修复任务还确认测试通过、测试文件未变且源码发生变化。推断限制：样本量为 1，且缓存状态不同，不能据此比较 high/max 或 Flash/Pro 的优劣。正式对比至少应每格运行 3 次，并报告中位数、离散程度、通过率和缓存状态。

## 8. 优化准入与回滚

任何 prompt、工具描述或上下文策略变化都按以下顺序验证：

1. 固定变更前 commit、Pi SDK、模型、thinking、任务和 fixture。
2. 先跑自动化，再以相同矩阵执行至少 3 次真实任务。
3. 同时比较完成率、工具成功率、错误恢复、首响应、总耗时、token、cache hit 和成本。
4. 质量不升、成本显著增加，或只在单次样本有效时，不进入默认路径。
5. 结果中只保留短输出、指标和必要错误分类；不提交 `.env`、完整 reasoning、会话 JSONL 或敏感日志。

## 9. 下一步

- 将 repair fixture 扩展为多文件修改和“首次测试失败 → 读取反馈 → 二次修复”，但仍不开放无人值守 Bash。
- 为 TUI 的错误分类增加更紧凑的 80 列卡片布局。
- 用重复稳定前缀和冷/热两组运行单独研究缓存，不把自然命中当成可控实验。
- 量化大 read/tool result 的截断和按需读取策略。
- 只有在普通 Schema 失败样本足够明确后，再在 playground 研究 strict tool mode。
