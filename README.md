# DeepSeek Coding Agent

一个以 DeepSeek 模型为优先、基于 [Pi](https://github.com/earendil-works/pi) SDK 构建的轻量 Coding Agent 学习项目。

当前 M1 已实现显式 DeepSeek 模型选择、一次性任务执行和完整事件输出。后续将围绕交互体验、上下文治理、会话恢复和权限确认逐步迭代。

## 项目目标

- 理解并实践 Coding Agent 的核心执行循环。
- 针对 DeepSeek 模型优化提示词、reasoning 和工具调用体验。
- 保持实现精简，形成可以独立开源和持续演进的 CLI 项目。
- 通过真实编码任务和自动化测试验证每次迭代。

## 当前状态

- 已接入 `@earendil-works/pi-coding-agent` SDK。
- 默认且仅允许 `deepseek` Provider，默认模型为 `deepseek-v4-flash`，不会回退到其他 Provider。
- 支持从命令行提交一次性任务，输出文本、reasoning、工具调用、工具结果、重试、错误和完成事件。
- 使用 Pi 内置的 Coding Agent 工具与内存会话；进程退出后不保留会话。
- 暂未实现独立 TUI、审批系统、持久会话、Compaction、MCP 和多 Agent。

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

## 开发验证

```bash
npm run check
npm run build
npm test
```

自动化测试使用内存 ModelRegistry 和 AgentSession 测试替身，不会调用真实 API。

## 当前限制

- 仅支持一次性非交互任务，没有完整 TUI。
- 会话只存于内存，不支持 resume、fork、clone 或 compaction。
- 沿用 Pi 默认 Coding Agent 工具；本项目尚未增加产品层审批和完整权限系统。
- 不支持 MCP、多 Agent、IDE 插件或云端服务。

## 仓库边界

- 本仓库只开发自己的 Coding Agent。
- Pi 上游源码研究和贡献在相邻的 `pi` Fork 中进行。
- 本地 API 和破坏性操作实验在相邻的 `playground/pi-test` 中进行。

学习顺序见 [docs/learning-roadmap.md](docs/learning-roadmap.md)。

## License

[MIT](LICENSE)
