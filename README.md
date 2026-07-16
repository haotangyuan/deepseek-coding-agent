# DeepSeek Coding Agent

一个以 DeepSeek 模型为优先、基于 [Pi](https://github.com/earendil-works/pi) SDK 构建的轻量 Coding Agent 学习项目。

当前已完成 M1–M5，并持续推进 M6/M7：显式 DeepSeek 模型、完整事件输出、安全工具审批、多轮 TUI、上下文资源透明化、可恢复的 Pi JSONL 会话，以及包含多文件修复、测试反馈恢复和成本边界的可重复评测。

## 项目目标

- 理解并实践 Coding Agent 的核心执行循环。
- 针对 DeepSeek 模型优化提示词、reasoning 和工具调用体验。
- 保持实现精简，形成可以独立开源和持续演进的 CLI 项目。
- 通过真实编码任务和自动化测试验证每次迭代。

## 当前状态

- 已接入 `@earendil-works/pi-coding-agent` SDK。
- 默认且仅允许 `deepseek` Provider，默认模型为 `deepseek-v4-flash`，不会回退到其他 Provider。
- 支持从命令行提交一次性任务，输出文本、reasoning、工具调用、工具结果、重试、错误和完成事件。
- 支持 `ask`、`auto-read`、`deny` 三种工具审批模式；默认 `ask`。
- Bash 审批支持“允许一次”或“当前进程允许完全相同命令”；不使用通配符、不跨进程/Session 恢复，命令变化后重新询问。
- 支持显式 `plan`/`build` Agent 模式；Plan 从 Pi 活动工具集合移除 write/edit/bash，Build 恢复审批控制的完整工具集，默认 `build + ask`。
- 直接复用 Pi 的 read/ls/grep 做受限仓库探索；read/ls/grep/write/edit 受工作区路径和 symlink 边界保护，write/edit/bash 在执行前展示并确认。
- 默认保护 `.env`、常见凭据目录/文件和 SSH 私钥名；公开的 `.env.example/.sample/.template` 仍可读写，明显 Bash 敏感路径字面量在审批前阻断。
- 成功执行修改类工具后展示 Git 工作区摘要，不自动提交。
- 每轮 settled 后展示 Completion Evidence：明确记录 write/edit 文件、实际 diff 查看、可识别验证结果和错误事实；不自动追加付费模型轮次，也不把未知命令猜成测试。
- Cache Inspector 展示本轮和 Session 累计 cache hit/miss/rate；`/cache` 可随时重看，只有相邻足量轮次下降至少 20pp 才提示事实型告警。
- 无任务参数时进入 DeepSeek 深海蓝风格的交互式 TUI，支持多行输入、多轮对话、折叠 reasoning、工具卡片、状态栏、steering 和取消；Provider/工具失败、自动重试和取消使用 80 列友好的紧凑恢复卡片。
- 展示真实加载的 AGENTS.md、Skills、Prompt Templates、工具和有效 System Prompt 大小；可临时关闭项目上下文并让 Pi 重载 Session。
- 默认使用 Pi `SessionManager` 持久化 JSONL，支持 workspace 内 continue/resume、标题、列表、树导航、fork/clone 和自动/手动 Compaction。
- 一次性任务支持显式 `off/high/max` thinking、内存 Session 和结构化指标；固定评测默认 dry-run，只有 `--live` 才调用真实 API。
- Provider 错误按 DeepSeek 官方 400/401/402/422/429/500/503 语义显示分类、是否可重试和下一步动作；原始详情先遮蔽敏感值。
- 暂未实现图形化会话选择器、跨工作区恢复、MCP 和多 Agent。

## 安装

要求 Node.js 22.19 或更高版本。

```bash
npm install --ignore-scripts
npm run build
```

## 环境变量

运行真实模型前，推荐通过环境变量配置凭据：

```bash
export DEEPSEEK_API_KEY="your-key"
```

也可以复制已被 Git 忽略的本地配置文件，`npm start` 会自动加载它：

```bash
cp .env.example .env
# 然后只在本地填写 .env 中的 DEEPSEEK_API_KEY
```

不要把真实密钥写入源码、README、命令历史或提交到 Git。CLI 也兼容 Pi AuthStorage 已保存的 DeepSeek 凭据；三处都没有凭据时，会在创建 AgentSession 前退出。错误输出会遮蔽常见 API Key 和 Bearer Token 形式。

## 模型选择与用法

直接启动多轮交互终端：

```bash
npm start
```

交互模式支持：

```text
/help
/status
/cache
/session
/sessions
/name [title]
/compact [instructions]
/tree [entry-id]
/fork <entry-id>
/clone
/model [deepseek-model-id]
/thinking [level]
/reasoning
/context
/agents
/skills
/prompts
/resources [on|off]
/mode [plan|build]
/clear
/exit
```

Enter 提交，Shift+Enter 换行。生成期间提交的新消息作为 steering 排队；Ctrl+C 取消当前运行，空闲时连续两次 Ctrl+C 退出。reasoning 默认只显示长度，通过 `/reasoning` 展开或重新折叠。

`/cache` 直接读取 Pi 已归一化的 DeepSeek usage：本轮通过提交前后 SessionStats 做差，Session 数值包含 JSONL 全历史的实际计费 usage。它不会为了诊断缓存再发送请求，也不会猜测命中下降原因。

`/context` 展示当前有效 System Prompt 的字符数和粗略 token、活动工具及资源数量；`/agents`、`/skills`、`/prompts` 展示真实来源路径和作用域。`/resources off` 只在当前进程内移除项目/祖先 AGENTS 和项目级 Skills/Prompts，再调用 Pi `AgentSession.reload()`；用户级资源继续保留。上下文开关不改变工具审批模式，两者是独立边界。

`/mode plan` 只允许空闲时切换，并通过 Pi `AgentSession.setActiveToolsByName()` 将下一轮工具缩减为 read/ls/grep；`/mode build` 恢复当前审批模式允许的工具。模式只影响当前进程，不写入 Session JSONL；恢复会话时使用 CLI 默认值或显式 `--mode`。

已加载的 Skill 可用 `/skill:name 参数` 显式调用，Prompt Template 可用 `/name 参数` 调用。模型可见的 Skills 仍由 Pi 按需读取，不会由本项目复制进 System Prompt。

会话默认保存在 Pi agentDir 下独立的 `deepseek-code-sessions` 目录，不与 Pi CLI 默认会话目录混用。`/sessions` 展示标题、创建/更新时间、模型和消息数；`/tree` 展示 append-only 消息树，`/tree <entry-id>`移动当前 leaf 而不删除旧分支。`/fork` 和 `/clone` 创建新 JSONL，并输出可用于恢复的新 ID。

也可以运行一次性任务：

默认模型：

```bash
npm start -- "Summarize this repository"
```

显式指定模型：

```bash
npm start -- --model deepseek-v4-flash "Read README.md and summarize it"
```

只读分析并输出方案：

```bash
npm start -- --mode plan --approval ask "Inspect this repository and propose a fix plan"
```

显式固定 thinking，并输出 TTFT、耗时、工具、token、cache 和成本指标：

```bash
npm start -- --ephemeral --metrics --thinking high --approval deny "Reply with OK"
```

继续当前工作区最近会话：

```bash
npm start -- --continue
```

按会话 ID 前缀或 JSONL 路径恢复：

```bash
npm start -- --resume 019f65e2
npm start -- --resume 019f65e2 "Continue the unfinished task"
```

恢复只允许会话头中的 cwd 与当前工作区一致，避免在错误目录执行工具。未显式传 `--model` 时恢复会话记录的 DeepSeek 模型；显式参数优先，历史中的非 DeepSeek Provider 会被拒绝。损坏文件和重复 ID 前缀会明确报错，不会静默新建会话。

也接受带 Provider 前缀的 `deepseek/deepseek-v4-flash`。任何非 `deepseek` Provider、未知模型或不可用凭据都会直接报错，不会自动选择 OpenAI、Anthropic 或其他模型。

普通文本增量写入标准输出；reasoning、工具调用参数、工具执行结果、重试、错误和 `[agent:complete]` 写入标准错误，便于脚本按通道处理。工具事件中的结构化值最多输出 4000 个字符，并经过敏感值遮蔽。

## 工具审批

Agent 模式与审批是两条独立轴：`plan` 决定模型是否能看到修改工具，`approval` 决定可见工具能否自动执行。默认 `build + ask`；`plan + ask` 仍只有 read/ls/grep，`build + auto-read` 也只有 read/ls/grep，`deny` 在任一模式下都不暴露工具。

默认 `ask` 模式自动允许工作区内的 read，并在每次 write、edit、bash 前请求确认：

```bash
npm start -- --approval ask "Fix the failing test"
```

交互审批中输入 `y` 只允许本次；Bash 审批可输入 `a`，在当前进程内记住完全相同的命令字符串。write/edit 始终逐次批准；危险命令和敏感路径不会因为已有命令授权而放行。

只允许读取：

```bash
npm start -- --approval auto-read "Analyze this repository"
```

完全禁用工具：

```bash
npm start -- --approval deny "Explain how to approach this task"
```

非交互环境中的 `ask` 会默认拒绝高影响工具。明显破坏性的 Bash 命令会在询问前直接阻断。审批不是沙箱：批准后的 Bash 仍拥有本地进程权限。完整边界见 [docs/tool-safety.md](docs/tool-safety.md)。

敏感路径保护是默认防泄漏规则，不是完整 Shell 解析器。间接脚本、运行时拼接和已批准程序仍可能访问本机权限范围内的文件；完整规则与误判边界见 [docs/sensitive-paths.md](docs/sensitive-paths.md)。

## 开发验证

```bash
npm run check
npm run build
npm test
```

自动化测试使用内存 ModelRegistry、AgentSession 测试替身、80×24 虚拟终端和临时目录中的真实 Pi SessionManager，不会调用真实 API。

固定 DeepSeek 评测默认只显示计划，不产生付费调用：

```bash
npm run build
npm run eval -- --task all --model deepseek-v4-flash --thinking high
npm run eval -- --live --task all --model deepseek-v4-flash --thinking high --runs 1 --max-cost-usd 0.02
npm run eval:compare -- results/deepseek-code.ndjson results/claude-code.ndjson
```

`--runs` 最多 5 次；默认观测成本上限为 0.02 美元，达到上限后不会开始下一次请求。单次请求的最终成本只能在 Provider 返回 usage 后得知，因此该参数不是预付费硬限额；超过上限会在汇总中标记失败。Pro 必须用 `--model deepseek-v4-pro` 显式选择。Schema v3 的 dry-run 同时显示逻辑样本数和最大 Provider 请求数；真实执行每个样本输出 `eval_result`，最后输出包含按任务通过率、延迟、成本和工具错误的 `eval_summary`。`eval:compare` 只读取已归一化的 Schema v3 NDJSON，并只比较各组共有的 `task + run` 样本；它不会自行调用 Claude Code、OpenCode 或其他 Agent。任务、格式、真实 smoke 和解释边界见 [docs/deepseek-evaluation.md](docs/deepseek-evaluation.md)。

`repair-js`、`repair-multi-file`、`repair-feedback` 和 `repair-config` 会在系统临时目录创建有缺陷的极小项目。评测器只自动批准 fixture 内的 write/edit，拒绝 Bash；Agent 结束后由评测器运行测试，确认指定源码确实改变、原文件没有缺失、受保护文件未变且没有创建额外文件，然后删除整个临时目录。`repair-feedback` 的隐藏回归测试位于 Agent 工作区外：第一次失败后，评测器只回填脱敏、截断且不含测试路径/堆栈的失败摘要，最多再执行一次 60 秒修复尝试。

## 当前限制

- 当前没有图形化 Session selector；恢复目标通过 `--resume <id|path>` 明确指定。
- `/fork` 和 `/clone` 创建新文件但不会在当前进程偷偷切换；按提示重新使用 `--resume` 进入新会话。
- Compaction summary 由当前 DeepSeek 模型生成，会产生一次模型请求；过短或刚压缩过的会话会由 Pi 拒绝重复压缩。
- `/context` 的 token 数按 4 字符约 1 token 粗估，不是 Provider tokenizer 的精确计数；资源开关重启进程后恢复开启。
- 工具审批是产品层防误操作机制，不提供 OS 级沙箱；项目发现的第三方 Extension 当前默认禁用。
- Plan Mode 是真实只读工具边界，但不强制模型输出固定格式的计划；当前模式不持久化，运行中或审批等待时不能切换。
- 不支持 MCP、多 Agent、IDE 插件或云端服务。

## 仓库边界

- 本仓库只开发自己的 Coding Agent。
- Pi 上游源码研究和贡献在相邻的 `pi` Fork 中进行。
- 本地 API 和破坏性操作实验在相邻的 `playground/pi-test` 中进行。

整体产品与技术规划见 [docs/product-roadmap.md](docs/product-roadmap.md)，Plan/Build 设计见 [docs/plan-build-mode.md](docs/plan-build-mode.md)，敏感路径规则见 [docs/sensitive-paths.md](docs/sensitive-paths.md)，进程内命令授权见 [docs/session-approvals.md](docs/session-approvals.md)，DeepSeek 评测见 [docs/deepseek-evaluation.md](docs/deepseek-evaluation.md)，持久会话设计见 [docs/persistent-sessions.md](docs/persistent-sessions.md)，上下文资源设计见 [docs/context-resources.md](docs/context-resources.md)，交互终端设计见 [docs/interactive-tui.md](docs/interactive-tui.md)，工具安全设计见 [docs/tool-safety.md](docs/tool-safety.md)，Pi SDK 升级记录见 [docs/pi-compatibility.md](docs/pi-compatibility.md)，源码学习顺序见 [docs/learning-roadmap.md](docs/learning-roadmap.md)。

## License

[MIT](LICENSE)
