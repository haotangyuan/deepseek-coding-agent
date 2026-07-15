# DeepSeek Coding Agent

一个以 DeepSeek 模型为优先、基于 [Pi](https://github.com/earendil-works/pi) SDK 构建的轻量 Coding Agent 学习项目。

当前已完成 M1–M4：显式 DeepSeek 模型、完整事件输出、默认安全的工具审批、基于 Pi TUI 的多轮交互终端，以及可检查、可临时关闭的上下文资源。下一阶段将进入持久会话和 Compaction。

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
- read/write/edit 受工作区路径和 symlink 边界保护；write/edit/bash 在执行前展示并确认。
- 成功执行修改类工具后展示 Git 工作区摘要，不自动提交。
- 无任务参数时进入 DeepSeek 深海蓝风格的交互式 TUI，支持多行输入、多轮对话、折叠 reasoning、工具卡片、状态栏、steering 和取消。
- 展示真实加载的 AGENTS.md、Skills、Prompt Templates、工具和有效 System Prompt 大小；可临时关闭项目上下文并让 Pi 重载 Session。
- 使用 Pi 内置的 Coding Agent 工具与内存会话；进程退出后不保留会话。
- 暂未实现持久会话、Compaction、MCP 和多 Agent。

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
/model [deepseek-model-id]
/thinking [level]
/reasoning
/context
/agents
/skills
/prompts
/resources [on|off]
/clear
/exit
```

Enter 提交，Shift+Enter 换行。生成期间提交的新消息作为 steering 排队；Ctrl+C 取消当前运行，空闲时连续两次 Ctrl+C 退出。reasoning 默认只显示长度，通过 `/reasoning` 展开或重新折叠。

`/context` 展示当前有效 System Prompt 的字符数和粗略 token、活动工具及资源数量；`/agents`、`/skills`、`/prompts` 展示真实来源路径和作用域。`/resources off` 只在当前进程内移除项目/祖先 AGENTS 和项目级 Skills/Prompts，再调用 Pi `AgentSession.reload()`；用户级资源继续保留。上下文开关不改变工具审批模式，两者是独立边界。

已加载的 Skill 可用 `/skill:name 参数` 显式调用，Prompt Template 可用 `/name 参数` 调用。模型可见的 Skills 仍由 Pi 按需读取，不会由本项目复制进 System Prompt。

也可以运行一次性任务：

默认模型：

```bash
npm start -- "Summarize this repository"
```

显式指定模型：

```bash
npm start -- --model deepseek-v4-flash "Read README.md and summarize it"
```

也接受带 Provider 前缀的 `deepseek/deepseek-v4-flash`。任何非 `deepseek` Provider、未知模型或不可用凭据都会直接报错，不会自动选择 OpenAI、Anthropic 或其他模型。

普通文本增量写入标准输出；reasoning、工具调用参数、工具执行结果、重试、错误和 `[agent:complete]` 写入标准错误，便于脚本按通道处理。工具事件中的结构化值最多输出 4000 个字符，并经过敏感值遮蔽。

## 工具审批

默认 `ask` 模式自动允许工作区内的 read，并在每次 write、edit、bash 前请求确认：

```bash
npm start -- --approval ask "Fix the failing test"
```

只允许读取：

```bash
npm start -- --approval auto-read "Analyze this repository"
```

完全禁用工具：

```bash
npm start -- --approval deny "Explain how to approach this task"
```

非交互环境中的 `ask` 会默认拒绝高影响工具。明显破坏性的 Bash 命令会在询问前直接阻断。审批不是沙箱：批准后的 Bash 仍拥有本地进程权限。完整边界见 [docs/tool-safety.md](docs/tool-safety.md)。

## 开发验证

```bash
npm run check
npm run build
npm test
```

自动化测试使用内存 ModelRegistry、AgentSession 测试替身、80×24 虚拟终端和临时目录，不会调用真实 API。

## 当前限制

- TUI 当前只保留进程内单会话，不提供搜索、会话树或可持久化布局。
- 会话只存于内存，不支持 resume、fork、clone 或 compaction。
- `/context` 的 token 数按 4 字符约 1 token 粗估，不是 Provider tokenizer 的精确计数；资源开关重启进程后恢复开启。
- 工具审批是产品层防误操作机制，不提供 OS 级沙箱；项目发现的第三方 Extension 当前默认禁用。
- 不支持 MCP、多 Agent、IDE 插件或云端服务。

## 仓库边界

- 本仓库只开发自己的 Coding Agent。
- Pi 上游源码研究和贡献在相邻的 `pi` Fork 中进行。
- 本地 API 和破坏性操作实验在相邻的 `playground/pi-test` 中进行。

整体产品与技术规划见 [docs/product-roadmap.md](docs/product-roadmap.md)，上下文资源设计见 [docs/context-resources.md](docs/context-resources.md)，交互终端设计见 [docs/interactive-tui.md](docs/interactive-tui.md)，工具安全设计见 [docs/tool-safety.md](docs/tool-safety.md)，Pi SDK 升级记录见 [docs/pi-compatibility.md](docs/pi-compatibility.md)，源码学习顺序见 [docs/learning-roadmap.md](docs/learning-roadmap.md)。

## License

[MIT](LICENSE)
