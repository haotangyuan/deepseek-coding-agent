# Pi SDK 兼容性记录

> 最近验证：2026-07-15
> 项目 SDK：`@earendil-works/pi-coding-agent@0.80.7`
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
| `SessionManager.inMemory()` | 保留 | M1 仍使用内存会话 |
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

- 本次只验证 M1 的一次性 CLI 主链，没有验证持久 Session、Compaction 或 TUI；对应里程碑实现时需补充兼容测试。
- Pi 研究 commit `dcfe36c7` 比 `v0.80.7` tag 多两个提交，不能把未发布源码行为视为 npm 包能力。
- DeepSeek API 与 model catalog 可能独立于 Pi 发版变化；真实模型可用性仍需以官方文档、`/models` 和受控 smoke 为准。
