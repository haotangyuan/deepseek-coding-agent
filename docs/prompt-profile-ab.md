# Prompt Profile 重复 A/B 记录

> 执行日期：2026-07-16
> 产品提交：`96df7a6b334b52a4f4dba989cff27ae4b32466bd`
> Pi 研究基线：`dcfe36c79702ec240b146c45f167ab75ecddd205`
> Pi SDK：`@earendil-works/pi-coding-agent@0.80.7`
> 模型与档位：`deepseek-v4-flash` / `high`

## 1. 问题

显式 `deepseek` Prompt Profile 追加一段稳定的 inspect → edit → diff → validate → report 工作流。实验要回答：与不追加产品提示的 `pi` Profile 相比，它是否稳定提高修复成功率，或者在成功率相同的情况下减少工具错误、耗时和成本。

## 2. 方法

- 固定同一产品提交、Pi SDK、模型、thinking、fixture 和 evaluator。
- 分别运行 `repair-js`、`repair-multi-file`、`repair-feedback`，每个 Profile 每项 3 次，共 18 个逻辑样本。
- `repair-feedback` 每个样本最多包含一次 evaluator-owned 失败反馈，因此两档最大 Provider 请求数均为 12。
- 每条命令先 dry-run；真实命令显式使用 `--live`，单矩阵成本观测上限为 `$0.02`。
- 自动化审批只允许系统临时 fixture 中的 write/edit；Bash 拒绝；评测后删除 fixture。
- 不保存完整 reasoning、工具结果、Session JSONL 或 API Key。本文件只记录聚合指标。

命令模板：

```bash
npm run eval -- --live --task <task> \
  --model deepseek-v4-flash --thinking high \
  --prompt-profile <pi|deepseek> --runs 3 --max-cost-usd 0.02
```

## 3. 结果

| 任务 | Profile | 通过 | 平均耗时 | 总成本 | 工具调用 | 工具错误 | Provider 错误 |
|---|---|---:|---:|---:|---:|---:|---:|
| repair-js | pi | 3/3 | 3845ms | $0.0010773 | 9 | 0 | 0 |
| repair-js | deepseek | 3/3 | 4692ms | $0.0022891 | 9 | 0 | 0 |
| repair-multi-file | pi | 3/3 | 7977ms | $0.0019394 | 20 | 0 | 0 |
| repair-multi-file | deepseek | 3/3 | 7893ms | $0.0018884 | 18 | 0 | 0 |
| repair-feedback | pi | 3/3 | 16828ms | $0.0033587 | 20 | 0 | 0 |
| repair-feedback | deepseek | 3/3 | 17202ms | $0.0025973 | 23 | 0 | 0 |
| **合计** | **pi** | **9/9** | **9550ms/样本** | **$0.0063754** | **49** | **0** | **0** |
| **合计** | **deepseek** | **9/9** | **9929ms/样本** | **$0.0067748** | **50** | **0** | **0** |

相对 `pi`，`deepseek` 总体平均耗时高 4.0%，总成本高 6.3%，多 1 次工具调用。它在多文件任务上略省耗时与成本，在反馈恢复任务上成本低 22.7%，但反馈任务平均耗时高 2.2% 且多 3 次工具调用。所有样本均通过，因此没有观察到质量收益。

缓存只按实际响应观察，没有人为清空或预热。不同 Profile 的请求前缀本来就不同，且 DeepSeek 缓存是 best-effort；本次缓存差异不能单独归因于提示质量，也不用于决定胜负。

## 4. 决策

1. 默认 Profile 保持 `pi`。
2. `deepseek` 继续作为显式实验入口，便于未来在更难、能拉开成功率的任务上迭代。
3. 不增加自动 Profile 或模型路由；用户选择与评测配置保持可见、可重复。
4. 不继续为现有短提示做措辞微调。当前任务成功率已经饱和，继续调词只会增加过拟合风险。
5. 跨模块、长日志和验证失败任务已在后续实验中完成同矩阵复测；结果仍不支持切换默认值，详见 `high-discrimination-profile-ab.md`。

## 5. 结论边界

这组结果只适用于当前三个小型 fixture、Flash/high 和所记录的提交。它证明现有 DeepSeek Prompt 没有成为默认路径的依据，不证明任何产品提示在更复杂任务上都无效。
