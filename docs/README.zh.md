# dsh-win32

## 修好 Windows 上的 DSH，不需要 WSL

**官方 PowerShell。Workspace Write。一条命令。**

```powershell
npx dsh-win32 setup
```

当前版 DeepSeek Harness 已经自带持久 PowerShell 和 Windows ACL 沙箱。dsh-win32 会检查这套官方能力，定位已知的 Windows 故障，只执行能够验证安全的修复，并创建桌面快捷方式。

当前路径不会安装 Git、PowerShell、busybox、WSL，也不会把另一个 DSH bundle 写进 profile。

[English](../README.md) · [Windows 实证与旧版细节](./windows-details.md)

<p>
<a href="https://www.npmjs.com/package/dsh-win32"><img src="https://img.shields.io/npm/v/dsh-win32?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
<a href="https://github.com/sjh9714/dsh-win32/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/sjh9714/dsh-win32/ci.yml?style=flat-square&label=CI" alt="CI"></a>
<a href="https://github.com/sjh9714/dsh-win32/stargazers"><img src="https://img.shields.io/github/stars/sjh9714/dsh-win32?style=flat-square" alt="stars"></a>
<img src="https://img.shields.io/badge/platform-win32-0078D4?style=flat-square" alt="win32">
</p>

## 当前安装流程

**可复现的安装演示，不是真实录屏。**

![当前 DSH 上的 dsh-win32 安装流程](../assets/demo.gif)

这条命令会完成下面的工作。

- 检查官方持久 PowerShell 和 Workspace Write package
- 检查 PowerShell 7 与已知损坏的 koffi runtime
- 为 Web profile 创建 `DeepSeek Harness` 桌面快捷方式
- 不修改官方 profile 和 Minimal 预设
- 输出第一次会话所需的准确步骤

安装后打开 DSH，添加工作区，选择官方 **Minimal**，权限保持 **Workspace Write**。

## 体检与安全修复

```powershell
npx dsh-win32 doctor
npx dsh-win32 doctor --json
npx dsh-win32 fix
```

`doctor` 检查官方 Windows stack 和本机已知故障。JSON 输出遵循 `dsh-doctor/v1`。

`fix` 只处理已知损坏或真实加载失败的 koffi 版本，修复后会再次执行加载验证。

## 旧版 DSH

DSH rc.6 及更早版本没有当前官方 PowerShell stack。原来的 Git Bash 和 busybox 预设仍保留，但必须显式选择。

```powershell
npx dsh-win32 setup --legacy
npx dsh-win32 setup --legacy --sandboxed
npx dsh-win32 doctor --legacy
```

旧版 Git Bash 预设需要 `danger-full-access`。旧版 busybox 预设可以留在 Workspace Write。两个路径都不会自动安装 Git。

## 限制

- 当前路径检查 npm 上发布的 DSH package metadata，不能证明另一个缓存中的 launcher 正在运行同一版本
- `verify` 只验收官方 PowerShell、terminal、subprocess、Workspace Write policy 与 ACL sandbox 组件链，不会启动完整 Minimal host，也不会验证插件安装或 hook 强制执行
- `verify` 会自行创建 Workspace Write policy 和受 Windows ACL 约束的 PowerShell 子进程。如果调用它的 agent 已经位于另一层 Workspace Write 或 Windows ACL 沙箱内，请只为这一条 verify 命令批准一次非沙箱/full-access 执行；嵌套的受限 token/ConPTY 可能在 PowerShell 启动前停住。内层验收边界不会被绕过，工作区外写入仍必须被拒绝。
- Windows 上的本地 `dsh plugin add` 路径可能因空格被拆分；本地包请暂存到不含空格的绝对路径，并回读实际安装的 package（[上游 #2485](https://github.com/deepseek-ai/deepseek-harness/discussions/2485)）
- hook 日志不能单独证明拦截生效；Windows PowerShell 可能丢失 interpreter hook 的阻塞退出码，而 `{"continue": false}` 也可能只记录 stop 却继续运行。修改 hook 或升级 DSH 后，请用无害的必拒绝 canary 确认目标动作真的被拦住（[上游 #2485](https://github.com/deepseek-ai/deepseek-harness/discussions/2485)、[#1514](https://github.com/deepseek-ai/deepseek-harness/discussions/1514)）
- 推荐 PowerShell 7，但 dsh-win32 不会自动安装
- 旧版 busybox 会话使用 ash，不是 Bash
- 编辑旧编码文件后会保存为 UTF-8
- 上游 Windows 路径问题修好前，把 `C:\tmp` 视为旧版写入围栏之外

## License

MIT.
