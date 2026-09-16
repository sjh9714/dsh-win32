# DSH 在 Windows 上的启动与会话故障：先诊断，再验证

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

## 4. 只有 DSH Desktop 失败时

CLI 组件验收通过不等于 Electron 打包后的进程链通过。分别记录 Desktop 版本、内置 DSH 版本和最短错误；不能仅凭 issue 仍然开放就判断修复尚未发布。以下发布状态核对于 **2026-09-14**：

| 错误特征 | 上游证据与边界 |
| --- | --- |
| `0xC0000142` / `STATUS_DLL_INIT_FAILED`，或与受限令牌启动有关的 PTY 失败 | [Desktop PR #266](https://github.com/anywhere-labs/dsh-desktop/pull/266) 调查 Electron 到 Windows ACL runner 的路径。普通 PTY 启动报错本身不能证明是这个原因。 |
| `Windows Job runner exited with exit code 0 before proving its managed range empty` | [#924](https://github.com/anywhere-labs/dsh-desktop/issues/924) 和 [#933](https://github.com/anywhere-labs/dsh-desktop/issues/933) 记录了该特征。[PR #927](https://github.com/anywhere-labs/dsh-desktop/pull/927) 只为 Electron 的私有 Windows Job runner 启用 Node 模式，不改变目标命令的环境。修复已包含在 [Desktop 2.0.9](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.9) 中，2.0.10 继续保留。 |
| 内置技能发现或 ASAR 目录元数据访问时出现 `Cannot mix BigInt and other types` | [PR #973](https://github.com/anywhere-labs/dsh-desktop/pull/973) 取消 ASAR 打包并增加打包后文件系统检查，已包含在 [Desktop 2.0.10](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.10) 中。其他位置的 BigInt 错误不一定同源。 |

Desktop 2.0.10 内置 DSH `0.1.5-rc.2`。[发布提交的 CI](https://github.com/anywhere-labs/dsh-desktop/actions/runs/34783941380) 已通过 Stable/Beta 的 Windows 打包检查及安装包、Portable 构建。[PR #927 的 Windows 实测](https://github.com/anywhere-labs/dsh-desktop/pull/927#issuecomment-5620391833) 验证的是本地修改后的 2.0.7 中的 runner 机制，不是修复后发布的安装包。这些证据都不能替代完整 Desktop/Minimal 会话、PTY 中断与清理的验收。

旧版 Desktop 出现对应的 Job runner 或 ASAR 错误时，先记录失败版本、退出应用，再按其官方发布或更新说明升级，并在不改变权限的前提下重试同一任务。记录实际安装版本及原错误是否重现。dsh-win32 尚未独立验证修复后的 Windows 安装包；请与 CLI 组件结果分开记录，继续保留完整会话验收门槛。

不要关闭杀毒软件、扩大权限、替换应用内的 runtime 文件，也不要假设 Job runner 或 ASAR 修复能解决受限令牌 ACL 路径。dsh-win32 的 `fix` 目前只修复已确认的 koffi 问题。仍失败时保留最短错误，并跟进对应上游报告。

## 5. 运行中因 `spillAll` / `ENOENT` 断开

如果打开 `dsh-subprocess-*` 输出文件时，`OutputCollector.spillAll` 报 `ENOENT`，请对照[上游 #2252](https://github.com/deepseek-ai/deepseek-harness/discussions/2252)。外部清理删除临时输出目录后，下一次输出溢出可能在 stream 回调中抛出未捕获异常，导致宿主退出。普通断连本身不能证明是这个原因。

2026-09-16，我们从已发布的 `@deepseek-ai/dsh-subprocess-local@0.1.5-rc.1` 归档中提取未修改的 collector 类，在隔离 Node 子进程里复现了首次 spill 前删除目录后的 `ENOENT`；正常目录和关闭 spill 的对照通过。这是 macOS 上的 collector 级测试，不是完整 DSH host 或 Windows 会话验收。检查到的 `0.1.5-rc.2` 源码及 `0.1.6-alpha.1` 移到 `output.ts` 的实现仍未保护该写入；不能把升级到这些版本当作已验证修复。

- 记录真实 DSH、Node 版本和最短脱敏错误，保留 profile 与会话历史。
- 确认失败进程已退出后，通过原来的 DSH 入口重启。不要删除仍在运行的 DSH 使用的临时目录。
- `doctor`、`fix` 和通过的 `verify` 都不能修复或排除该故障。旧版 Win32 collector 有自己的 I/O 保护，但当前 setup 不会替换官方 collector；不要把安装旧版 bundle 或直接修改打包 runtime 当作修复。

保持 Workspace Write、杀毒软件和包管理器政策不变。跟进上游修复，并核对实际发布版本后再判断问题是否解决。

## 6. 已有 Claude Code 配置怎么办？

Windows 正常之后，可以另行使用 [dsh-movein](https://github.com/sjh9714/dsh-movein)。在原项目目录先预演：

```powershell
npx dsh-movein
```

确认目标、冲突与不支持项后才添加 `--apply`。这不是 Windows 修复的必需步骤，也不会自动搬入会话历史。先看 [Movein 的安全试用例子](https://github.com/sjh9714/dsh-movein/blob/main/docs/first-migration.zh.md)。

## 反馈哪类信息有用？

在 [issue](https://github.com/sjh9714/dsh-win32/issues) 中说明 Node、DSH、dsh-win32 版本，以及失败的检查名称。只提供已脱敏的最小复现，不上传整个配置、终端日志、路径、凭据或工作区内容。

如果实际解决了你的问题，欢迎在 [GitHub 仓库](https://github.com/sjh9714/dsh-win32) 自愿 Star。它不是安装、排错或获得帮助的条件。
