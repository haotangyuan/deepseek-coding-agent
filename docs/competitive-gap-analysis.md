# DeepSeek Coding Agent 能力差距与改进顺序

> 最近核对：2026-07-16
> 项目提交基线：`b0750de88279df16db908c9261bbd9160da5fb6c`
> Pi 研究基线：`dcfe36c79702ec240b146c45f167ab75ecddd205`
> Pi SDK：`@earendil-works/pi-coding-agent@0.80.7`

## 1. 目的

本文把 Claude Code、Codex CLI、OpenCode 中值得学习的产品做法转成当前仓库可验证的工程缺口。判断依据依次是本项目源码、安装后的 Pi SDK 类型、相邻 Pi 源码、DeepSeek 官方文档和参考产品官方能力边界。

目标不是适配或追平其他 Agent 的功能数量，而是提升本项目自己的任务完成率、工具有效率、用户干预、缓存命中和成功任务成本。新的当前状态和实施顺序以 `docs/product-status-and-evolution.md` 为准。

## 2. 建议审计矩阵

| 建议能力 | 当前事实 | 判断 |
|---|---|---|
| 自建 DeepSeek Native Provider | Pi 已处理 V4 模型、thinking、reasoning replay、tool stream、usage 和错误；本项目只做 DeepSeek-only 选择 | 暂不复制协议层；只有兼容层出现可复现缺陷才补 Pi 或贡献上游 |
| 自建流式 Tool Call assembler | Pi AgentSession 已输出 parsed tool events，项目已有参数/结果事件测试 | 已由底座解决，不重复实现 |
| reasoning_content 回填 | Pi DeepSeek compat 使用 `requiresReasoningContentOnAssistantMessages` | 已由底座解决，继续用真实多轮工具任务回归 |
| ls/glob/grep | 0.80.7 内置 ls/find/grep；项目此前只暴露 read | 本轮启用 ls/grep；find 因 fd 缺失失败，完成依赖预检前不启用 |
| apply_patch | Pi 当前默认是精确 edit/write，没有 apply_patch | 先收集 edit 失败样本；没有数据前不新增第二套修改语义 |
| LSP/diagnostics | 当前没有 | P2；先从 TypeScript/Python diagnostics 的只读、显式命令开始，不先做通用 LSP 平台 |
| 修改后 diff/test completion gate | 已完成 settled 时 Completion Evidence，记录 write/edit、实际 diff、识别检查和错误事实 | 观察型 P1 已落地；是否升级为强制 Gate 必须由真实遗漏率数据决定 |
| Cache Inspector | 已完成本轮/Session hit、miss、rate、`/cache` 和足量轮次 20pp 下降提示 | P1 已落地；保持事实型观测，不猜测具体失效原因 |
| Plan/Build | 已有显式 CLI/TUI 状态；Plan 只暴露 read/ls/grep，Build 恢复审批控制工具 | P1 已落地；保持非持久、空闲切换，不把 Prompt 当权限边界 |
| Flash/Pro 自动路由 | 当前显式手动选择，避免付费升级惊喜 | 暂缓自动路由；先有分阶段任务数据，再考虑在清晰边界切换 |
| Tool Call repair | Pi Schema 错误会回填模型；尚无确定性 JSON 修复层 | 继续采集失败样本；默认不偷偷猜参数 |
| 权限规则与敏感文件 | 已有 workspace/symlink、三种审批模式、Plan/Build、敏感路径拒绝、危险 Bash 阻断和进程内精确命令授权 | P1 已落地；通配符规则与 OS sandbox 不在当前授权中伪实现 |
| 自动项目记忆 | 已有 AGENTS/Skills/Session/Compaction，没有自动写长期记忆 | 延后；自动记忆会引入陈旧上下文和前缀漂移 |
| 多 Agent/Explore 子 Agent | 当前没有，路线图明确 deferred | 单 Agent 闭环和评测稳定前不做 |
| 本项目真实任务评测 | 当前 7 个固定任务，覆盖协议、单/多文件、反馈恢复和配置解析 | 持续扩充异质任务，只衡量本项目自己的版本、prompt、工具和模型策略迭代 |

## 3. 本轮落地与证据

### Pi 原生仓库发现

- `ls`：目录排序与条目/字节截断由 Pi 实现。
- `grep`：ripgrep、`.gitignore`、匹配/字节/长行截断由 Pi 实现。
- 两者进入 `ask` 与 `auto-read` 的稳定工具集合，并复用现有 workspace/realpath/symlink 检查。
- `find` 真实调用因缺少 `fd` 返回错误，因此没有进入默认集合。

这比让模型用 Bash 做 `find/grep` 更安全，也比大范围 read 更节省上下文。工具顺序固定为 `read, ls, grep, write, edit, bash`，避免每轮动态重排工具 Schema。

### 反馈恢复重复评测

`repair-feedback` 三次重复全部成功，工具错误为 0，平均单样本成本约 `$0.000656`。它支持“短而可行动的验证反馈优于原始 TAP 倾倒”这一局部结论，但不能替代更异质的真实仓库任务。

### Plan/Build 工具边界

- `--mode plan` 和 TUI `/mode plan` 都把下一轮活动工具固定为 read/ls/grep。
- TUI 通过 Pi `setActiveToolsByName()` 热切换，Pi 同步重建工具相关 System Prompt。
- ToolPolicy 保留第二道阻断，即使绕过模型可见列表直接提交 write/edit/bash，也不会进入审批或执行。
- Build 不等于自动执行；仍由 `ask/auto-read/deny` 决定授权。

### 敏感路径默认保护

- 文件工具默认拒绝 `.env` 非模板变体、常见凭据目录/文件和 SSH 私钥名。
- `.env.example/.sample/.template` 明确放行，避免破坏正常项目配置教学和生成。
- Bash 对明显路径字面量在审批前拒绝；文档不宣称能覆盖变量拼接、脚本间接访问或任意程序行为。

### 进程内精确 Bash 授权

- `y` 允许一次；`a` 只记住完全相同的 Bash command 字符串。
- 授权不写入 Session，重启后消失；命令变化立即重新审批。
- write/edit 不支持批量放行；危险命令和敏感路径先于授权缓存检查。

## 4. 下一步顺序

1. **环境与兼容诊断：** 建立 Doctor 和 Pi 发布版升级门，避免运行时才发现 Key、工具依赖或 SDK 漂移。
2. **TUI 高频交互：** 命令/文件补全、Session/Tree 选择器和可展开工具卡。
3. **本轮 Diff/Undo：** 为 write/edit 建立冲突安全的文件 checkpoint，不伪装成完整系统回滚。
4. **Completion Gate 评估：** 先统计 Evidence 中缺少 diff/验证的比例，再提供用户显式触发的 verify/diff/undo 闭环。

apply_patch、LSP、自动路由和子 Agent 只有在上述闭环有数据后再进入实现，避免把项目做成功能堆叠。

## 5. 官方事实边界

- DeepSeek [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) 仍明确包含 reasoning content 与工具轮次语义。
- DeepSeek [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) 提供 strict mode，但本项目仍把本地校验和权限作为独立边界。
- DeepSeek [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) 返回 cache hit/miss token，支持后续 Cache Inspector。
- Claude Code [Permissions](https://docs.anthropic.com/en/docs/claude-code/permissions) 与 [Hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) 说明权限和生命周期拦截属于 Harness 能力。
- OpenCode [Tools](https://opencode.ai/docs/tools/) 与 [Permissions](https://opencode.ai/docs/permissions/) 展示 grep/glob/LSP 和 allow/ask/deny 的产品边界。

这些资料只用于确定产品问题，不代表要复制对方命令面或内部实现。
