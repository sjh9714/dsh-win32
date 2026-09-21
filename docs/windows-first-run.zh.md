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

从 dsh-win32 **0.17.12** 开始，可在当前模式下用一条命令完成 setup，再执行一次组件验收：

```powershell
npx dsh-win32 setup --verify
```

使用 `--profile NAME --no-shortcut` 可保留选定的 profile 并跳过快捷方式。普通 `setup` 行为不变。可选验收会另行报告实际安装的 DSH 版本与来源，不把 setup 查询到的 registry metadata 当作已安装证据；验收失败或环境不受支持时以非零退出。它不会安装缺少的软件，也不会改写 profile 或包管理器政策。`setup --legacy --verify` 会在执行旧版安装之前被明确拒绝。

不需要 setup 或需要机器可读输出时，仍可单独运行：

```powershell
npx dsh-win32 verify --json
```

这个命令不需要模型或 API key。它在临时环境中检查 PowerShell 的持久状态、工作区内读写、工作区外写入拒绝、中断和清理。失败或未执行的项目必须保留为失败或未执行，不能写成“全部支持”。

若 agent 的外层沙箱阻止验收程序启动，只为这条 verify 命令申请一次权限；内层被测 PowerShell 仍须保持 ACL 限制。不要改变用户日常使用的安全设置。

通过之后仍有明确边界：它没有启动完整 stock Minimal host，没有验证插件安装、hook 强制执行或模型工作流。使用时选择官方 **Minimal** 并保持 **Workspace Write**，不要把组件结果宣传成完整 TUI 验证。

## 4. 只有 DSH Desktop 失败时

CLI 组件验收通过不等于 Electron 打包后的进程链通过。分别记录 Desktop 版本、内置 DSH 版本和最短错误；issue 关闭或构建通过也不是完整会话证据。以下发布状态核对于 **2026-09-21**，最新 [Desktop 2.0.13](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.13) 内置 DSH `0.1.5-rc.2`：

| 错误特征 | 上游证据与边界 |
| --- | --- |
| 无控制台宿主的受限令牌 shell 启动报 `0xC0000142` / `STATUS_DLL_INIT_FAILED` | [PR #990](https://github.com/anywhere-labs/dsh-desktop/pull/990) 已随 [Desktop 2.0.11](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.11) 发布，2.0.13 也包含它。[PR #266](https://github.com/anywhere-labs/dsh-desktop/pull/266) 未合并而关闭，不代表 #990 尚未发布。普通 PTY 报错本身不能证明是这个原因。 |
| `Windows Job runner exited with exit code 0 before proving its managed range empty` | [PR #927](https://github.com/anywhere-labs/dsh-desktop/pull/927) 和 [#931](https://github.com/anywhere-labs/dsh-desktop/pull/931) 修复私有 Electron Job runner 路径，自 [2.0.9](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.9) 起发布。维护者[按这个原始特征关闭了 #933](https://github.com/anywhere-labs/dsh-desktop/issues/933#issuecomment-5748645422)，不是宣布后续所有终端问题已解决。 |
| `PTY shell exited during startup`，ConPTY runner 无输出并以 `127` 退出 | [#1051](https://github.com/anywhere-labs/dsh-desktop/issues/1051) 仍开放：Windows 11 用户报告 2.0.13 配合 Store/MSIX PowerShell 的持久终端启动失败，未做全新 profile 对照。这不是我们的独立复现，且与 #990 覆盖的一次性执行器不同。 |
| 内置技能发现或 ASAR 目录元数据访问时出现 `Cannot mix BigInt and other types` | [PR #973](https://github.com/anywhere-labs/dsh-desktop/pull/973) 取消 ASAR 打包并增加打包后文件系统检查，已包含在 [Desktop 2.0.10](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.10) 中。其他位置的 BigInt 错误不一定同源。 |
| Cargo/Schannel 在 Workspace Write 下访问 crates.io 报 `SEC_E_NO_CREDENTIALS`（`0x8009030e`） | 我们的[独立 TLS 复现](https://github.com/deepseek-ai/deepseek-harness/discussions/986#discussioncomment-18494537) 尚未解决。shell 能启动不代表 HTTPS 可用；不要关闭证书验证或放宽权限来凑出通过结果。 |

我们的 [2026-09-18 payload 检查](https://github.com/anywhere-labs/dsh-desktop/issues/924#issuecomment-5725248498) 核对官方 **2.0.11 x64 Setup.exe 的校验和后，只解包，没有安装**。Windows Server 2022/2025 分别搭配 Node 22.19 和 payload 中的 Electron 43.3.0/Node 24.18.1，共四组通过前台 PowerShell 启动、工作区内写入、外部写入拒绝、中断及直接子进程退出、context 清理。Desktop 路径使用发布的 `DesktopWindowsPwshSandbox`。这没有验收正常 Desktop UI、持久 PTY、glob/grep、hook、Blue、stock Minimal 或模型会话，也不独立证明 2.0.13 正常。

同次检查中，Cargo 1.98.1 获取 `itoa 1.0.15` 的四组非限制对照都成功，四组 Workspace Write 都在 TLS 处失败。因此[诊断 run 为红色](https://github.com/sjh9714/dsh-win32/actions/runs/35307547925)，它没有调用 dsh-win32 runtime；独立的 [dsh-win32 0.17.11 发布 CI 为绿色](https://github.com/sjh9714/dsh-win32/actions/runs/35307413235)。[固定版本的诊断源码](https://github.com/sjh9714/dsh-win32/blob/501f6f8516713f47fe8ef7690b7527ee90b34dec/scripts/upstream-windows-probe.mjs) 没有包含在 npm 包中。

旧版 Desktop 若匹配某个已发布修复，先记录失败版本、退出应用，再按官方更新说明升级，并在不改变权限的前提下重试同一任务，记录真实安装版本及剩余错误。继续保留[完整会话门槛](https://github.com/sjh9714/dsh-win32/issues/84)和 [Blue 门槛](https://github.com/sjh9714/dsh-win32/issues/55)。不要关闭 Defender/杀毒软件、TLS 验证或 Workspace Write，也不要替换打包 runtime。dsh-win32 的 `fix` 只修复已确认的 koffi 问题，不修复这些尚未解决的上游故障。

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
