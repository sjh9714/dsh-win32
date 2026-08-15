# dsh-windows

First-class Windows for DeepSeek Harness.

[中文](./README.zh.md) · [![ci](https://github.com/sjh9714/dsh-windows/actions/workflows/ci.yml/badge.svg)](https://github.com/sjh9714/dsh-windows/actions/workflows/ci.yml)

| | Stock DSH on Windows | With dsh-windows |
|---|---|---|
| Minimal preset | dead. every persistent-shell spawn throws `terminal inspection is unsupported on platform win32` | **works. real persistent Git Bash, state survives across tool calls** |
| Install traps | koffi segfault chain, PS 5.1 crash loop, localhost 403, WSL bash confusion | one `doctor` command that names each trap and its fix |
| Setup | find the npx command on GitHub every morning | `npx dsh-windows setup` (+ optional desktop shortcut) |

## Why this exists

The community keeps reporting that DeepSeek models do their best work in DSH's Minimal preset. On Windows that preset does not run at all. Its persistent bash needs a PTY, and the stock subprocess runtime resolves a platform process inspector that throws on win32 before node-pty is even reached. Every Windows user has been locked out of the mode the model is best aligned with.

dsh-windows closes that gap with three pieces.

1. **A Windows-aware subprocess runtime.** Same stock runtime, plus the missing piece, a win32 ProcessInspector (process trees and identity via CIM, signalling via taskkill). Swapped in by bundle patch on win32 only. Other platforms keep the stock row untouched.
2. **The `minimal-windows` agent preset.** A faithful copy of the official Minimal composition with one change, the PTY shell is your Git Bash. Same complete persona, same two tools, no compaction.
3. **A doctor.** Diagnoses the traps the community found the hard way. broken koffi 3.1.3/3.1.4 prebuilts (install failures, folder-picker and session-save crashes), missing PowerShell 7 (the 5.1 fallback crash-loops with 0xC0000142 inside the sandbox), the localhost vs 127.0.0.1 origin 403, and the WSL bash.exe imposter in System32.

## Install

```sh
dsh plugin --profile web add dsh-windows   # wires the runtime bundle
npx dsh-windows setup                      # installs the preset + prints a health report
npx dsh-windows setup --shortcut           # same, plus a desktop shortcut
```

The preset appears in the picker immediately. Requires [Git for Windows](https://git-scm.com) (`winget install Git.Git`).

## Receipts

- CI runs on real `windows-latest`. It builds the runtime, spawns a persistent Git Bash PTY through it, and proves state survives across writes (`STATE=x` in one call, `echo $STATE` in the next). The same job fails on the stock runtime by construction of the inspector gap.
- Unit tests cover the inspector's tree ordering, pid-recycle cycles, identity matching, and signal mapping.

## Honest limitations (v0.1)

- Foreground process-group inspection has no Windows equivalent, so interrupting a long-running command inside the persistent shell is degraded. planned as Ctrl-C injection in v0.2.
- Behavior under the Windows ACL restricted-token sandbox is not yet verified. MSYS-based shells are known to struggle there. if the shell fails to start under `workspace-write`, run the session `danger-full-access` until v0.2. Reports welcome.
- Developed against DSH `0.1.0-rc.6`. DSH is a developer preview with breaking changes announced. version pinned, fast-patch policy on every rc bump.

## License

MIT. The preset composition mirrors the official Minimal preset (MIT) with credit. Trap inventory distilled from community reports in the DSH discussions.
