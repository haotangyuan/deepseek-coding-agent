# 学习与迭代路线

## 1. Agent Loop

从 `packages/agent` 开始，追踪用户消息、模型输出、工具调用、工具结果回填和循环终止条件。

验证产物：画出一条真实请求的调用链，并用测试覆盖一次工具调用。

## 2. 模型抽象

阅读 `packages/ai` 的 Provider、Model、流式事件和 DeepSeek 实现。

验证产物：显式选择 DeepSeek 模型，并正确处理文本、reasoning 和工具调用事件。

## 3. Coding Agent 组装

阅读 `packages/coding-agent` 的 Session、默认工具、上下文文件和 SDK 工厂。

验证产物：实现最小的 read、edit、write、bash 工作流，并输出修改摘要。

## 4. 上下文治理

研究 `AGENTS.md`、会话持久化、恢复、分支和 compaction。

验证产物：长任务中可以恢复会话，压缩后仍保留目标、约束和关键文件信息。

## 5. TUI 与安全

最后阅读 `packages/tui`，并补充工具审批和安全边界。

验证产物：交互界面能够展示流式状态；写文件和执行命令前具有明确审批。

## 每轮学习模板

1. 定义一个具体问题。
2. 记录入口文件、关键类型和调用链。
3. 阅读对应测试。
4. 编写一个最小实验。
5. 把验证成功的机制移植到本项目。
6. 记录与 Codex CLI、Claude Code CLI 的差异和取舍。
