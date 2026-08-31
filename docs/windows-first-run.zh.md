# DSH 在 Windows 上 PowerShell 启动失败：先诊断，再验证

[English README](../README.md) · [中文 README](./README.zh.md) · [给 coding agent 的指令](./agent-setup.md#中文)

当前 DSH 已经自带持久 PowerShell 与 Windows ACL 沙箱。遇到启动失败时，不必先换成 WSL 或旧版 Git Bash 预设。下面按“缺前置软件、已知 runtime 故障、真实组件验收”分开处理。

这是一份操作指南，不是本次新增的 Windows 录屏。仓库现有 GIF 是重现动画；Windows CI 的组件链验收也不等于完整 Minimal 会话验收。

## 1. 先确认环境

在 PowerShell 中检查：

```powershell
node --version
pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
npx dsh-win32 doctor --json
```

需要原生 Windows、PowerShell 7 和 Node 22.19+ 或 24+，不支持 Node 23。缺少前置软件时先按官方说明安装；dsh-win32 不负责安装 PowerShell、Git、WSL 或 DSH。

`doctor` 会检查发布的 DSH Windows package contract，并定位已知本机问题。只看到官方 package metadata 正常，还不能判断某个缓存中的 launcher 真能启动。

## 2. 只处理已确认的问题

如果诊断指出 koffi 的已知坏版本或实际加载失败，先确认受影响的安装与变更范围，再运行：

```powershell
npx dsh-win32 fix
npx dsh-win32 doctor --json
```

没有对应故障就跳过修复。不要为消除报错而关闭 Workspace Write、改变全局 pnpm 配置，或自动切到 `--legacy`。

完成前置检查后，可创建默认 Web profile 的桌面快捷方式：

```powershell
npx dsh-win32 setup
```

不需要快捷方式时使用 `npx dsh-win32 setup --no-shortcut`。当前 setup 保留官方 profile 和预设；启动入口参见 [DSH 官方说明](https://github.com/deepseek-ai/deepseek-harness#run)。

## 3. 验证真正安装的组件，而不只看命令成功

```powershell
npx dsh-win32 verify --json
```

这个命令不需要模型或 API key。它在临时环境中检查 PowerShell 的持久状态、工作区内读写、工作区外写入拒绝、中断和清理。失败或未执行的项目必须保留为失败或未执行，不能写成“全部支持”。

若 agent 的外层沙箱阻止验收程序启动，只为这条 verify 命令申请一次权限；内层被测 PowerShell 仍须保持 ACL 限制。不要改变用户日常使用的安全设置。

通过之后仍有明确边界：它没有启动完整 stock Minimal host，没有验证插件安装、hook 强制执行或模型工作流。使用时选择官方 **Minimal** 并保持 **Workspace Write**，不要把组件结果宣传成完整 TUI 验证。

## 4. 已有 Claude Code 配置怎么办？

Windows 正常之后，可以另行使用 [dsh-movein](https://github.com/sjh9714/dsh-movein)。在原项目目录先预演：

```powershell
npx dsh-movein
```

确认目标、冲突与不支持项后才添加 `--apply`。这不是 Windows 修复的必需步骤，也不会自动搬入会话历史。先看 [Movein 的安全试用例子](https://github.com/sjh9714/dsh-movein/blob/main/docs/first-migration.zh.md)。

## 反馈哪类信息有用？

在 [issue](https://github.com/sjh9714/dsh-win32/issues) 中说明 Node、DSH、dsh-win32 版本，以及失败的检查名称。只提供已脱敏的最小复现，不上传整个配置、终端日志、路径、凭据或工作区内容。

如果实际解决了你的问题，欢迎在 [GitHub 仓库](https://github.com/sjh9714/dsh-win32) 自愿 Star。它不是安装、排错或获得帮助的条件。
