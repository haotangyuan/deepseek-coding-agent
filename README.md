# DeepSeek Coding Agent

一个以 DeepSeek 模型为优先、基于 [Pi](https://github.com/earendil-works/pi) SDK 构建的轻量 Coding Agent 学习项目。

当前仓库只提供最小的 SDK 接入骨架。后续将围绕 Agent Loop、工具执行、上下文治理、会话恢复、权限确认和终端交互逐步迭代。

## 项目目标

- 理解并实践 Coding Agent 的核心执行循环。
- 针对 DeepSeek 模型优化提示词、reasoning 和工具调用体验。
- 保持实现精简，形成可以独立开源和持续演进的 CLI 项目。
- 通过真实编码任务和自动化测试验证每次迭代。

## 当前状态

- 已接入 `@earendil-works/pi-coding-agent` SDK。
- 支持从命令行提交一次性任务并输出流式文本。
- 暂未实现独立 TUI、审批系统、持久会话和 DeepSeek 专项策略。

## 准备运行

要求 Node.js 22.19 或更高版本。

```bash
npm install --ignore-scripts
export DEEPSEEK_API_KEY="your-key"
npm run build
npm start -- "Summarize this repository"
```

Pi 的模型认证和选择机制仍在快速演进。开始正式开发前，应先确认当前 SDK 版本的模型选择方式，并为 DeepSeek 增加显式配置。

## 仓库边界

- 本仓库只开发自己的 Coding Agent。
- Pi 上游源码研究和贡献在相邻的 `pi` Fork 中进行。
- 本地 API 和破坏性操作实验在相邻的 `playground/pi-test` 中进行。

学习顺序见 [docs/learning-roadmap.md](docs/learning-roadmap.md)。

## License

[MIT](LICENSE)
