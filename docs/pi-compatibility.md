# Pi SDK 兼容性记录

> 最近验证：2026-07-15
> 项目 SDK：`@earendil-works/pi-coding-agent@0.80.7`
> 项目 TUI：`@earendil-works/pi-tui@0.80.7`
> 对照发布范围：`v0.80.6..v0.80.7`
> Pi 研究源码：`dcfe36c79702ec240b146c45f167ab75ecddd205`

## 1. 记录目的

Pi 的 `main`、npm 发布包和本项目升级节奏彼此独立。本文记录每次 SDK 升级实际核对过的接口、行为与验证结果，防止仅凭版本号判断兼容性。

固定原则：

- 项目依赖 npm 已发布的精确版本，不直接依赖相邻 Pi 工作区。
- Pi `main` 只用于源码研究和预判未来变化。
- 每次升级都检查安装后的 `.d.ts` 和 model catalog，不凭经验猜 API。
- 自动化测试不访问真实 API；通过后再运行一次受控的 DeepSeek smoke。

## 2. 0.80.6 → 0.80.7 结论

结论：**当前 M1 调用链兼容，无需修改业务代码。**

本项目使用的接口：

| 接口/行为 | 0.80.7 核对结果 | 项目影响 |
|---|---|---|
| `CreateAgentSessionOptions.model` | 保留 | 继续显式传入 DeepSeek Model |
| `createAgentSession()` | 保留 | 创建方式不变 |
| `AgentSessionEvent` | M1 使用的 text/thinking/tool/retry/settled 事件保留 | 事件格式器无需修改 |
| `ModelRegistry.find(provider,id)` | 保留 | DeepSeek-only 查找不变 |
| `ModelRegistry.hasConfiguredAuth(model)` | 保留 | 凭据前置检查不变 |
| `SessionManager.inMemory()` | 保留 | M3 多轮仍使用内存会话 |
| `AgentSession.prompt/steer/abort` | 保留 | M3 复用多轮、排队和取消语义 |
| `AgentSession.setModel/setThinkingLevel/getSessionStats` | 保留 | M3 命令和状态栏直接复用 |
| `TUI/ProcessTerminal/Editor/Markdown` | 0.80.7 类型与真实终端已验证 | M3 不复制输入编辑和差分刷新 |
| `ResourceLoader.getSkills/getPrompts/getAgentsFiles` | 0.80.7 类型和真实 loader 已验证 | M4 直接展示运行时资源快照 |
| `DefaultResourceLoader` overrides | skills/prompts/agentsFiles override 已验证 | 临时过滤项目资源，不复制扫描逻辑 |
| `AgentSession.reload()` | 0.80.7 类型和集成测试已验证 | 资源开关后重建 runtime 与 System Prompt |
| `SessionManager.create/open/continueRecent/list` | 0.80.7 类型和临时目录集成测试已验证 | M5 直接使用 Pi JSONL，不自定义格式 |
| `SessionManager.getTree/branch/createBranchedSession/forkFrom` | append-only 行为已验证 | 文本树、同文件分支、fork 与 clone |
| `AgentSession.compact/navigateTree/waitForIdle` | 类型、源码和事件模型已核对 | 手动压缩、leaf 导航和安全退出 |
| `CreateAgentSessionOptions.thinkingLevel` | 0.80.7 类型确认，真实 Flash high/max 与 Pro high 通过 | CLI 显式固定评测档位；resume 未显式指定时保留历史值 |
| `AgentSession.getSessionStats` | token、cacheRead/cacheWrite、cost 类型和真实 usage 已验证 | M6 结构化指标直接读取，不自行重算 Provider token |
| `deepseek-v4-flash` | catalog 中存在 | 默认模型可用 |
| `deepseek-v4-pro` | catalog 中存在 | 可显式选择，但不自动升级 |
| DeepSeek compat | 仍为 OpenAI Completions、`thinkingFormat: "deepseek"`、reasoning replay | 继续由 Pi 处理协议兼容 |

## 3. 上游变化及判断

`0.80.7` 的主要底层变化：

- `ToolResultMessage` 增加 `addedToolNames`，支持缓存友好的延迟工具加载。
- OpenAI-compatible session affinity 改用 `sessionAffinityFormat` 表达。
- ModelRegistry 增加 Radius OAuth/custom provider 能力。
- 修复部分 Provider 的认证、reasoning replay、usage 和错误报告。
- 默认 System Prompt 移除日期，减少跨日期缓存失效。

这些变化没有改变当前 DeepSeek M1 的公共调用方式。延迟工具加载主要影响支持原生 deferred tools 的 Provider；DeepSeek 继续使用正常的 `Context.tools`。System Prompt 稳定性改进对后续 DeepSeek context cache 评测有正向价值。

## 4. 安装后事实核对

安装包中的真实类型与模型文件已检查：

- `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts`
- `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/deepseek.models.js`

安装版本与 lockfile 均为 `0.80.7`，npm audit 报告 0 个漏洞。

## 5. 验证记录

2026-07-15（M6 错误诊断与 repair fixture）：

| 验证 | 结果 |
|---|---|
| `npm run check` / `npm run build` | 通过 |
| `npm test` | 37/37 通过，不调用真实 API |
| DeepSeek 错误分类 | 400/401/402/422/429/500/503、网络和未知错误通过 |
| Pi 重试边界 | 保留 `isRetryableAssistantError` 与 AgentSession backoff，不新增重试状态机 |
| Flash/high repair-js | 读取、修改、外部测试和完整性检查通过；3 次工具成功 |
| Fixture 安全 | 只自动批准临时目录 write/edit，拒绝 Bash，结束后删除目录 |

真实修复 Smoke 只保留短输出、聚合指标和检查结果，不保存源码、reasoning 或会话。

2026-07-15（M6 评测基线）：

| 验证 | 结果 |
|---|---|
| `npm run check` / `npm run build` | 通过 |
| `npm test` | 32/32 通过，不调用真实 API |
| Eval dry-run | 显示模型、thinking、任务和 requestCount，不调用 API |
| Flash/high 固定任务 | exact、read 工具成功、missing-file 工具错误恢复均通过 |
| Flash/max、Pro/high | exact 可用性 smoke 通过 |
| Session | `--ephemeral` 使用 Pi in-memory Session，不生成 JSONL |
| 安全 | `.env` 被 Git 忽略；输出未包含 API Key |

完整数值和解释限制见 `docs/deepseek-evaluation.md`。

2026-07-15（M5）：

| 验证 | 结果 |
|---|---|
| `npm run check` | 通过 |
| `npm run build` | 通过 |
| `npm test` | 28/28 通过 |
| SessionManager 集成测试 | 创建、列表、continue、resume、分支、fork/clone、损坏文件通过 |
| Compaction 上下文测试 | summary 与最近约束共同恢复，旧 entry 不改写 |
| TUI 替身测试 | session/list/name/compact/tree/fork/clone 通过 |
| 真实 DeepSeek Smoke | 两进程 create → resume 成功，恢复上一轮上下文 |
| 真实 TUI | 100×32，session/sessions/tree/exit 正常 |
| Provider/工具错误 | 无 |

Smoke 只记录模型 ID、Session ID 前缀、事件类型和成功状态，不记录 API Key、完整 reasoning 或 JSONL 内容。

2026-07-15（M4）：

| 验证 | 结果 |
|---|---|
| `npm run check` | 通过 |
| `npm run build` | 通过 |
| `npm test` | 23/23 通过 |
| 真实终端 | 100×32，context/resource reload 正常 |
| DeepSeek 模型 | `deepseek-v4-flash` |
| 真实 Smoke | 成功，收到 thinking 与最终文本，返回 idle |
| 资源变化 | AGENTS 1 → 0；用户级 Skills 28 → 28 |
| 有效 System Prompt | 13,960 → 13,397 字符 |
| 工具调用/错误 | 无 |

Smoke 使用极短只读提示，不记录 API Key、完整 reasoning 或会话文件。

2026-07-15：

| 验证 | 结果 |
|---|---|
| `npm run check` | 通过 |
| `npm run build` | 通过 |
| `npm test` | 8/8 通过 |
| DeepSeek 模型 | `deepseek-v4-flash` |
| 真实 Smoke | 成功，退出码 0 |
| 输出 | 3 bytes |
| 事件终止 | reasoning 增量后收到 `agent:complete` |
| 工具调用 | 无 |
| Provider/工具错误 | 无 |

Smoke 只记录模型、成功状态、输出长度和事件类型，不记录 API Key、完整 reasoning 或会话内容。

## 6. 后续升级检查清单

1. 记录升级前后 SDK 版本和对应 Pi tag。
2. 阅读 coding-agent、agent、ai、tui 的目标版本 Changelog。
3. 检查 `CreateAgentSessionOptions`、`AgentSessionEvent`、ModelRegistry 和 SessionManager 类型。
4. 检查 DeepSeek model catalog、base URL、API 类型和 compat 字段。
5. 检查默认工具列表、Tool Result 和 reasoning replay 行为。
6. 使用 `npm install --ignore-scripts --save-exact` 更新依赖和 lockfile。
7. 运行 check/build/test。
8. 使用本地忽略的 `.env` 做一次低成本 smoke。
9. 更新本文和 `product-roadmap.md`，再做 staged secret scan。

## 7. 已知边界

- M3 已验证 Pi TUI 差分渲染、多行 Editor、Markdown 流更新，以及 AgentSession 的多轮、steer、abort、模型/thinking 和统计接口。
- M4 已验证 ResourceLoader 的 AGENTS 顺序、Skills/Prompts 作用域、override 和 AgentSession reload；上下文 token 仍是产品层粗估。
- M5 已验证 Pi JSONL 的恢复、append-only tree 和 Compaction context；自动化不调用真实模型生成 summary。
- M6 基线已验证显式 thinking、SessionStats usage 和 DeepSeek 工具错误恢复；单次 smoke 不构成模型性能结论。
- M6 错误分类只改善产品提示，不改变 Pi 的重试与 Provider 协议；repair fixture 不授予无人值守 Bash。
- Pi 研究 commit `dcfe36c7` 比 `v0.80.7` tag 多两个提交，不能把未发布源码行为视为 npm 包能力。
- DeepSeek API 与 model catalog 可能独立于 Pi 发版变化；真实模型可用性仍需以官方文档、`/models` 和受控 smoke 为准。
