# Get past a DSH startup problem on Windows

[README](../README.md) · [中文](./windows-first-run.zh.md) · [Coding-agent request](./agent-setup.md)

Use this when the official DSH Windows installation will not start PowerShell, or after a runtime update leaves you unsure what failed. dsh-win32 checks the current official stack and repairs specific known failures. It does not install DSH, PowerShell, Git, or WSL.

## Find the failing step

In native PowerShell, check the prerequisites and run the diagnostic:

```powershell
node --version
pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
npx dsh-win32 doctor --json
```

Use PowerShell 7 and DSH-supported Node 22.19+ or 24+; Node 23 is unsupported. Install missing prerequisites using their official instructions. Record the actual installed DSH identity when several launchers are present.

If the diagnosis identifies a known broken koffi version or a real koffi load failure, review the affected installation before running:

```powershell
npx dsh-win32 fix
npx dsh-win32 doctor --json
```

If no supported repair applies, retain the failed check and its short error. Repeated installation is not a diagnosis. Keep Workspace Write and package-manager policy in place.

## Verify the installed stack

```powershell
npx dsh-win32 verify --json
```

This uses temporary files and the installed official components to check persistent PowerShell state, workspace read/write, outside-write denial, cancellation, and cleanup. It needs no model account. A pass establishes this component chain; the complete stock Minimal session and hook enforcement are separate checks.

When a coding agent's outer sandbox blocks the verifier, request access for this one command. The verifier's own inner Workspace Write boundary stays enabled. Preserve any snapshot the command retains after an unconfirmed shutdown.

## Open your first session

`npx dsh-win32 setup` checks the current setup and creates the Web-profile desktop shortcut. Use `--no-shortcut` if you do not want one. Launch DSH using the shortcut or its [official instructions](https://github.com/deepseek-ai/deepseek-harness#run), add a workspace, and select stock **Minimal** with **Workspace Write**.

If you already configured a model provider, ask for one small task in a disposable workspace, such as reading a sample README. Record separately whether the UI opened, the tool ran, and the expected answer appeared. A model task can incur normal provider usage. Without a provider, mark that task **not run** rather than inferring success from `verify`.

Once the host works, [Movein's first-task guide](https://github.com/sjh9714/dsh-movein/blob/main/docs/first-task.md) explains how to try existing coding-agent configuration. It is optional.

## Share a result or record a demonstration

We are collecting first-run feedback: [versions, intended task, and the step reached](https://github.com/sjh9714/dsh-win32/issues/new?template=first-run.md). A still-blocked attempt helps as much as a success. Share only a short redacted error or synthetic reproduction, never full configuration, credentials, private paths, or workspace contents.

For a real Windows recording, use an empty sample workspace and a clean terminal. Show the observed failure, the supported repair only if one is needed, then the same check succeeding. If the machine is healthy, label the clip as a healthy-stack check; do not invent a failure. Show a model-backed task only if it actually ran. Review every frame before publishing.

The README's existing GIF is a reproduced animation, not that recording. A component-check clip also must not be labelled as a complete Blue/Minimal session test.
