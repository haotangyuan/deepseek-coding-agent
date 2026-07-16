# 敏感路径默认保护

> 最近验证：2026-07-16
> 实现位置：`src/tool-policy.ts`

## 1. 目标

防止 Coding Agent 在普通探索或修改任务中把常见本地凭据读入模型上下文。规则位于 ToolPolicy，不依赖 Prompt，也不读取文件内容后再判断。

## 2. 默认拒绝集合

文件工具拒绝：

- `.env` 以及 `.env.local`、`.env.production` 等非公开变体。
- `.envrc`、`.netrc`、`.npmrc`、`.pypirc`。
- `auth.json`、`credentials.json`、`secrets.json`、`service-account.json`、`service_account.json`。
- `.ssh`、`.aws`、`.gnupg`、`.kube`、`.secrets` 路径段。
- `id_rsa`、`id_dsa`、`id_ecdsa`、`id_ed25519`。

以下公开模板放行：

- `.env.example`
- `.env.sample`
- `.env.template`
- 以这三个后缀结尾的变体，例如 `.env.production.template`

规则对大小写归一化，并同时用于 read、ls、grep、write 和 edit。越过工作区的路径仍由既有 workspace/realpath/symlink 规则优先拒绝。

## 3. Bash 边界

Bash 命令在危险命令检查和用户审批之前扫描明显的路径字面量，例如：

```text
cat .env
ls $HOME/.ssh
cat config/credentials.json
```

命中后直接返回阻断原因，不展示文件内容，也不弹出允许选项。

这不是 Shell parser 或数据防泄漏系统，不能可靠识别：

- 字符串拼接或编码后的路径。
- 脚本内部、子进程或解释器运行时构造的访问。
- 已批准程序自行访问的其他文件。
- 文件系统检查与执行之间的竞态条件。

因此敏感路径规则只能被描述为常见误操作护栏。需要强保证时，应替换 Bash operations 并使用容器或 micro-VM 隔离。

## 4. 与其他策略的关系

- Plan Mode 不暴露 Bash/write/edit，但 read/ls/grep 仍经过敏感路径检查。
- Build Mode 不绕过敏感路径拒绝。
- `ask` 不允许用户在当前调用中覆盖敏感路径硬拒绝，避免凭据先进入审批预览或模型结果。
- `auto-read` 只读不等于“可读取所有文件”。
- `deny` 仍然优先禁用全部工具。

## 5. 验证

自动化测试使用临时目录和虚构 sentinel，不读取本机凭据，覆盖：

- `.env`、`.env.local`、凭据文件和敏感目录拒绝。
- read/ls/grep/write/edit 的统一行为。
- 公开 `.env` 模板允许。
- Bash 明显路径字面量在审批前拒绝。
- 拒绝时不会调用审批回调。

真实 `deepseek-v4-flash` Smoke 要求模型尝试读取路径名 `.env`：Tool Result 明确拒绝、Agent 正常完成、输出无 key 形态且工作区不变。验证没有展示或保存本地 `.env` 内容。
