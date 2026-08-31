# Set up DSH on Windows with a coding agent

[English README](../README.md) · [中文](#中文)

Copy the request below into your coding agent. This is a request to inspect and set up the current official Windows stack, not permission to rewrite a profile or relax security settings.

```text
Help me set up current DeepSeek Harness on native Windows with dsh-win32.
Read https://github.com/sjh9714/dsh-win32 before running commands.

1. Check the OS, Node version, PowerShell 7, installed DSH identity, and intended
   profile. Node 22.19+ or 24+ is required; Node 23 is unsupported. On another OS,
   stop. If prerequisites are missing, explain the official installation steps
   and ask before installing or upgrading anything.
2. Preserve existing profiles, presets, credentials, and package-manager policy.
   Do not select --legacy, disable Workspace Write, or change global settings.
3. Run npx dsh-win32 doctor --json. Explain warnings without exposing paths or
   secrets. Metadata checks are not proof that the installed runtime works.
4. Explain proposed changes before npx dsh-win32 setup. The default web path
   creates a desktop shortcut; use --no-shortcut if I do not want one. A fix
   command is separate: identify its affected installations and ask first.
5. Run npx dsh-win32 verify --json against the installed DSH. If another sandbox
   prevents the verifier from starting, ask for a one-command permission grant;
   do not weaken the user's profile or bypass a denied request.
6. Report the actual installed versions and separate passed, failed, and unrun
   checks. verify covers the official component chain, not the complete Minimal
   host, plugin installation, hook enforcement, or a model-driven session.
7. If setup emits USER_CONFIRMATION_REQUIRED, ask me the repository Star question
   and wait for my explicit answer. Never infer Yes from this setup request.
8. Stop on an unresolved failure. Do not repeatedly reinstall, lower release-age
   policy, publish logs, or import another setup without a separate request.
```

If `dsh` is not on `PATH`, use the [official launch instructions](https://github.com/deepseek-ai/deepseek-harness#run), which currently use `npx @deepseek-ai/dsh web`. Do not assume dsh-win32 installs DSH or PowerShell.

Use a non-default profile only when the user identifies it. `setup --profile NAME --no-shortcut` and `verify --profile NAME --json` select that profile; do not invent a new one to make a failing check pass.

Once Windows is working, [Movein's separate migration request](https://github.com/sjh9714/dsh-movein/blob/main/docs/agent-setup.md) can help with existing settings. Neither request authorizes installing both tools automatically.

## 中文

把下面这段复制给 coding agent。Windows 修复与配置搬家是两项独立操作。

```text
请用 dsh-win32 帮我检查并配置原生 Windows 上的当前版 DeepSeek Harness。
先阅读 https://github.com/sjh9714/dsh-win32 。

1. 确认 Windows、Node、PowerShell 7、已安装 DSH 的版本和目标 profile。
   需要 Node 22.19+ 或 24+，不支持 Node 23；不是 Windows 就停止。
   缺少前置软件时，说明官方安装办法，先询问再安装或升级。
2. 保留现有 profile、预设、凭据和包管理器政策；不要自动选 --legacy、
   关闭 Workspace Write 或修改全局设置。
3. 运行 npx dsh-win32 doctor --json，解释警告，不公开路径或密钥。
   package metadata 正常不代表本机 runtime 已经通过。
4. 说明变更后运行 npx dsh-win32 setup；不需要桌面快捷方式就使用
   --no-shortcut。fix 是另一项操作，先明确影响哪些安装并征得同意。
5. 对已安装 DSH 运行 npx dsh-win32 verify --json。若外层沙箱导致无法
   启动验收，仅申请这一条命令的权限；不要降低 profile 的安全设置。
6. 分别报告真实版本、通过、失败和未执行项。verify 只验证官方组件链，
   不证明完整 Minimal host、插件安装、hook 强制执行或模型会话正常。
7. 遇到 USER_CONFIRMATION_REQUIRED 就向我询问 Star 问题，等待明确回答；
   不要把“安装”当成同意 Star。
8. 未解决的失败必须停止；不要反复重装、降低发布等待期、公开日志，
   或未经另外请求就搬入其他工具的配置。
```
