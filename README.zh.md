# dsh-win32

让 DeepSeek Harness 在 Windows 上成为一等公民。

[English](./README.md) · [![ci](https://github.com/sjh9714/dsh-win32/actions/workflows/ci.yml/badge.svg)](https://github.com/sjh9714/dsh-win32/actions/workflows/ci.yml)

![before and after](./assets/hero.png)

| | 官方 DSH（Windows） | 装上 dsh-win32 |
|---|---|---|
| 极简模式 | 无法使用。持久 shell 一启动就抛 `terminal inspection is unsupported on platform win32` | **可用。真正的持久 Git Bash，状态跨调用保留** |
| 安装深坑 | koffi 崩溃链、PS 5.1 崩溃循环、localhost 403、System32 假 bash | 一条 `doctor` 命令逐项指出问题和修法 |
| 启动 | 每天早上去 GitHub 找 npx 命令 | `npx dsh-win32 setup`（可选桌面快捷方式） |

## 为什么做这个

社区反复实测说 DeepSeek 模型在 DSH 的极简模式下表现最好。但在 Windows 上，极简模式根本跑不起来：它的持久 bash 需要 PTY，而官方 subprocess 运行时在 win32 上解析平台进程探测器时直接抛错，连 node-pty 都没碰到。所有 Windows 用户都被挡在模型对齐得最好的那个模式之外。

dsh-win32 用三个部分补上这个缺口。

1. **Windows 版 subprocess 运行时。** 与官方运行时完全一致，只补上缺失的 win32 ProcessInspector（进程树与身份用 CIM，信号用 taskkill）。通过 bundle patch 仅在 win32 上替换，其他平台原样保留官方实现。
2. **`minimal-windows` 预设。** 忠实复刻官方极简模式，唯一改动是把 PTY shell 换成你机器上的 Git Bash。同样的完整 persona、同样的双工具、同样不做压缩。v0.4 新增 `minimal-windows-sandboxed`，基于 busybox-w32 ash 的变体，**不出 `workspace-write` ACL 沙箱**（`npx dsh-win32 setup --sandboxed`，经确认后下载 busybox）。windows-latest CI 实测，受限令牌下活下来的第一个持久 shell。
3. **旧编码读取，能覆盖的地方全覆盖。** 官方 DSH 对 GBK/UTF-16 文件直接拒读（`FS_NOT_TEXT`），前台 shell 里原生工具的 GBK 输出也会乱码。两个预设都挂载了文件读取器（`dsh-win32/fs`），文件读取路径自动嗅探解码 GBK/UTF-16；v0.5 起运行时对前台 shell 的 collect 输出同样处理。写入保持 UTF-8（编辑旧编码文件会转码，如实写明）。PTY 输出在插件层无法解码（node-pty 先行解码），随附 shell 默认 UTF-8 所以预设不受影响。
4. **doctor 体检。** 覆盖社区踩过的坑：koffi 3.1.3/3.1.4 损坏预编译（安装失败、目录选择器崩溃、会话保存闪退）、缺 PowerShell 7（5.1 回退在沙箱里 0xC0000142 崩溃循环）、localhost 与 127.0.0.1 的 403、System32 里的 WSL 假 bash。

## 安装

PowerShell 里一行。

```powershell
irm https://raw.githubusercontent.com/sjh9714/dsh-win32/master/install.ps1 | iex
```

它会把运行时 bundle 接入 web profile、安装预设、建桌面快捷方式并输出体检报告。想用 npx 也一样。

```sh
npx dsh-win32 setup              # bundle + 预设 + 体检
npx dsh-win32 setup --shortcut   # 同上，外加桌面快捷方式
```

预设立即出现在选择器里，无需重启。需要 [Git for Windows](https://git-scm.com)（`winget install Git.Git`）。

已经出问题了？`npx dsh-win32 doctor` 逐项指出已知的坑，`npx dsh-win32 fix` 自动修复能安全修的部分（pin 掉损坏的 koffi 预编译）。

## 自己写 preset 的注意事项（Windows）

如果你的 preset 挂载 `@deepseek-ai/dsh-terminal-bash` 却不显式配 `shellPath`，默认的 `/bin/bash` 在 Windows 上会命中 `C:\Windows\System32\bash.exe`（WSL 启动器），PTY 启动即退。请显式指向真正的 shell。

```yaml
- id: terminal-bash
  name: '@deepseek-ai/dsh-terminal-bash'
  config:
    shellPath: 'C:/Program Files/Git/usr/bin/bash.exe'
    shellArgs: ['--noprofile', '--norc', '-i']
```

用 `usr/bin/bash.exe` 而不是 `bin/bash.exe`。后者是 47KB 的 wrapper，会再拉起前者，PTY 的 pid 会落在 wrapper 上而不是 shell 上。来自 #6 用户报告。

## 实证

- CI 跑在真实 `windows-latest` 上：构建运行时、经它拉起持久 Git Bash PTY、验证状态跨写入保留（第一次 `STATE=x`，第二次 `echo $STATE`）。官方运行时在同一任务上必然失败，因为探测器缺口就在启动路径上。
- 单元测试覆盖进程树排序、PID 复用成环、身份匹配、信号映射。

## 诚实的限制（v0.5）

- 长命令中断已通过 Ctrl-C 注入实现（SIGINT/SIGTSTP 作为 PTY 输入，ConPTY 惯例）。对前台进程的 SIGTERM/SIGKILL 现在会通过 ConPTY console 列表解析出该命令并整树终止。真正没有 win32 对应物的是 stdin 等待探测，它恒为 `false`，因此命令完成仍靠提示符标记判定，而非精确的 stdin 探测。v0.5 起终端清理失败会回退到 `taskkill /T /F`（直接拉起的控制台程序可能扛过 ConPTY kill）。
- MSYS bash 在 `workspace-write` 受限令牌下仍然启动即死（实测签名 `TokenDefaultDacl, 0xC0000022`），所以 Git Bash 预设需要 `danger-full-access`。busybox 变体（`minimal-windows-sandboxed`）是沙箱内的答案；代价是 ash 而非 bash（没有数组、没有 `[[ ]]`）。
- 旧代码页原生工具的 PTY 输出无法在插件层重新解码：node-pty 在任何 DSH 代码运行之前就按 UTF-8 解码，且在 Windows 上拒绝编码覆盖。Git Bash 和 busybox 默认 UTF-8，随附预设不受影响。
- 基于 DSH `0.1.0-rc.6` 开发。DSH 是开发者预览版，官方已声明会有破坏性变更。版本锁定，每次 rc 更新快速跟进。

## License

MIT。预设组合复刻自官方极简模式（MIT）并注明出处。踩坑清单提炼自 DSH 官方讨论区的社区报告。
