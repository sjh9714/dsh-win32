# dsh-win32

## Fix DSH on Windows. No WSL.

**Official PowerShell. Workspace Write. One command.**

```powershell
npx dsh-win32 setup
```

Current DeepSeek Harness already includes persistent PowerShell and a Windows ACL sandbox. dsh-win32 checks that official stack, finds known Windows failures, applies the repairs it can prove safe, and creates a desktop shortcut.

It does not install Git, PowerShell, busybox, WSL, or another DSH bundle on the current path.

[中文](./docs/README.zh.md) · [Windows evidence and legacy details](./docs/windows-details.md)

Using a coding agent? [Copy the setup and verification request](https://github.com/sjh9714/dsh-win32/blob/master/docs/agent-setup.md). For a guided walkthrough, see [Windows troubleshooting in Chinese](https://github.com/sjh9714/dsh-win32/blob/master/docs/windows-first-run.zh.md).

Start with the [Windows first-run walkthrough](./docs/windows-first-run.md) if DSH will not launch or a check fails. It follows one problem from diagnosis through the next verification step. [Share your first-run result](https://github.com/sjh9714/dsh-win32/issues/new?template=first-run.md), including attempts that are still blocked.

<p>
<a href="https://www.npmjs.com/package/dsh-win32"><img src="https://img.shields.io/npm/v/dsh-win32?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
<a href="https://github.com/sjh9714/dsh-win32/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/sjh9714/dsh-win32/ci.yml?style=flat-square&label=CI" alt="CI"></a>
<a href="https://github.com/sjh9714/dsh-win32/stargazers"><img src="https://img.shields.io/github/stars/sjh9714/dsh-win32?style=flat-square" alt="stars"></a>
<img src="https://img.shields.io/badge/platform-win32-0078D4?style=flat-square" alt="win32">
<img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT">
</p>

## See the current setup

**Reproduced setup flow. This is not a screen recording.**

![Reproduced dsh-win32 setup on current DSH](./assets/demo.gif)

The command checks the official persistent PowerShell and Workspace Write packages, creates the shortcut, and leaves the profile on the stock Minimal preset.

## What setup does

- Checks the latest published DSH Windows package contract
- Checks PowerShell 7 and known broken koffi runtimes
- Creates a `DeepSeek Harness` desktop shortcut for the Web profile
- Leaves the official profile and preset unchanged
- Shows the exact next steps for a first session

After setup, open DSH, add a workspace, choose the stock **Minimal** preset, and keep **Workspace Write** enabled.

Use another profile without creating a shortcut.

```powershell
npx dsh-win32 setup --profile desktop --no-shortcut
```

`--sandboxed` remains accepted for old notes and scripts. Current DSH already provides the sandbox, so the flag makes no extra change.

## Live verification of an installed stack

```powershell
npx dsh-win32 verify
npx dsh-win32 verify --json
```

`verify` is a model- and API-key-free acceptance run against an **already installed** `@deepseek-ai/dsh` dependency tree. It does not use registry metadata as proof. In an isolated temporary home and workspace it invokes the installed model-facing persistent `pwsh` tool through the official terminal, subprocess, Workspace Write policy, and Windows ACL sandbox components.

A pass requires all of these live observations:

- 64-bit PowerShell 7 launches and reports a real executable
- two `pwsh` calls retain the same PTY, current directory, and environment state
- exact content is written and read inside the temporary workspace
- a normal-process control can write the isolated outside target, while confined PowerShell is denied and creates no file
- the shell recovers after denial; cancellation tears down its PTY; a replacement call works; and a second cancellation tears down cleanly
- every runtime resource, temporary home, and temporary workspace is removed

No user DSH profile, config, workspace, or PowerShell profile is loaded or changed. Secret-bearing environment variables are not passed to the worker, and reports contain no tested paths or terminal output. Native Windows and a DSH-supported Node release are required; Node 23 is explicitly unsupported.

If a timeout or output limit leaves worker or descendant containment unconfirmed, verification fails and preserves the isolated snapshot instead of deleting files under a potentially live process.

`verify` creates its own Workspace Write policy and Windows ACL-confined PowerShell child. If you run it from an agent that is already inside another Workspace Write or Windows ACL sandbox, approve one unsandboxed/full-access execution for **this verify command only**; otherwise the nested restricted-token/ConPTY layers can stall before PowerShell launches. This does not bypass the acceptance boundary: the inner child under test remains confined, and the outside-write denial is still required to pass. Worker timeouts report only a fixed, path-free progress checkpoint so nested-launch stalls can be distinguished without exposing terminal output or environment values.

The boundary is deliberate: this composes the installed official components and invokes the real persistent tool, but it does not start the complete stock Minimal host/preset, run the plugin installer, execute hook bridges, or make a model request. A pass must therefore be read as component-chain acceptance, not as an end-to-end stock-session or hook-enforcement claim.

The repository CI installs `@deepseek-ai/dsh@latest` from scratch and runs this acceptance on real Windows. Pushes, pull requests, and manual runs cover npm and strict pnpm layouts on Node 22.19 and 24. A weekly upstream watch retains both installers on Node 22.19, so a new DSH publication is checked even when dsh-win32 itself has not changed.

## Doctor and safe repair

```powershell
npx dsh-win32 doctor
npx dsh-win32 doctor --json
npx dsh-win32 fix
```

`doctor` verifies the published DSH Windows package contract and checks local Windows failures. Its JSON output follows the `dsh-doctor/v1` envelope. Use `verify` when you need live evidence from the installed stack rather than registry metadata.

`fix` only repairs installed koffi versions that are known broken or fail a real runtime load. It verifies the load again after repair.

## Upstream plugin and hook boundaries

Two current DSH control paths sit outside repairs that dsh-win32 can safely apply:

- On Windows, `dsh plugin add` can split a local package path containing spaces, and relative package paths can resolve from an unexpected working directory ([upstream #2485](https://github.com/deepseek-ai/deepseek-harness/discussions/2485)). Prefer a published package specifier. If a local package is unavoidable, stage it at a space-free absolute path and read back the installed package identity rather than trusting a successful command alone.
- Hook logs are not proof that enforcement happened. An interpreter-backed Claude Code hook can lose its blocking exit code through PowerShell on Windows ([upstream #2485](https://github.com/deepseek-ai/deepseek-harness/discussions/2485)), while a `{"continue": false}` result can be recorded as `decision: stop` without halting the run ([upstream #1514](https://github.com/deepseek-ai/deepseek-harness/discussions/1514)). After changing hooks or upgrading DSH, run a harmless unconditional deny canary and confirm the target action is actually blocked.

`doctor` cannot prove either behavior from package metadata, and `verify` deliberately avoids user profiles, hook configuration, model requests, and plugin installation. They therefore do not report these upstream paths as passing. The canary remains a user-controlled end-to-end check until DSH exposes a safe, isolated hook acceptance interface.

## Bring an existing setup

Once the Windows checks pass, [dsh-movein](https://github.com/sjh9714/dsh-movein) can preview importing an existing Claude Code, Codex, or OpenCode setup. It is optional and separate from Windows setup: dsh-win32 does not install it for you.

Start with a preview in the project you want to move. Do not add `--apply` until you have reviewed the destinations, conflicts, and unsupported settings.

```powershell
npx dsh-movein
```

Moving configuration does not prove hook enforcement or a complete stock Minimal session. Keep the verification boundaries above.

## Legacy DSH

DSH rc.6 and older did not ship the current official PowerShell stack. The previous Git Bash and busybox presets remain available behind an explicit flag.

```powershell
npx dsh-win32 setup --legacy
npx dsh-win32 setup --legacy --sandboxed
npx dsh-win32 doctor --legacy
```

The legacy Git Bash preset needs `danger-full-access`. The legacy busybox preset can run in Workspace Write. Neither path installs Git automatically.

[Read the implementation evidence, compatibility history, and complete legacy limitations](./docs/windows-details.md).

## Honest limits

- `doctor` checks published package metadata; `verify` separately reports and loads the selected installed DSH identity.
- `verify` does not boot the complete stock Minimal host/preset, so host wiring and UI session ownership remain outside its pass claim.
- Neither command validates `dsh plugin add` path handling or hook enforcement; see the upstream boundaries above.
- PowerShell 7 is recommended. dsh-win32 does not install it.
- A legacy busybox session uses ash rather than Bash.
- Editing a legacy encoded file writes UTF-8.
- Treat `C:\tmp` as outside the expected legacy write fence until the upstream Windows path issue is fixed.

## License

MIT.
