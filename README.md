# dsh-win32

First-class Windows for DeepSeek Harness.

[中文](./README.zh.md) · [![ci](https://github.com/sjh9714/dsh-win32/actions/workflows/ci.yml/badge.svg)](https://github.com/sjh9714/dsh-win32/actions/workflows/ci.yml)

![before and after](./assets/hero.png)

| | Stock DSH on Windows | With dsh-win32 |
|---|---|---|
| Minimal preset | dead. every persistent-shell spawn throws `terminal inspection is unsupported on platform win32` | **works. real persistent Git Bash, state survives across tool calls** |
| Install traps | koffi segfault chain, PS 5.1 crash loop, localhost 403, WSL bash confusion | one `doctor` command that names each trap and its fix |
| Setup | find the npx command on GitHub every morning | `npx dsh-win32 setup` (+ optional desktop shortcut) |

## Why this exists

The community keeps reporting that DeepSeek models do their best work in DSH's Minimal preset. On Windows that preset does not run at all. Its persistent bash needs a PTY, and the stock subprocess runtime resolves a platform process inspector that throws on win32 before node-pty is even reached. Every Windows user has been locked out of the mode the model is best aligned with.

dsh-win32 closes that gap with three pieces.

1. **A Windows-aware subprocess runtime.** Same stock runtime, plus the missing piece, a win32 ProcessInspector (process trees and identity via CIM, signalling via taskkill). Swapped in by bundle patch on win32 only. Other platforms keep the stock row untouched.
2. **The `minimal-windows` agent preset.** A faithful copy of the official Minimal composition with one change, the PTY shell is your Git Bash. Same complete persona, same two tools, no compaction. v0.4 adds `minimal-windows-sandboxed`, a variant on busybox-w32 ash that STAYS inside the `workspace-write` ACL sandbox (`npx dsh-win32 setup --sandboxed`, downloads busybox on consent) — measured on windows-latest CI, the first persistent shell that survives the restricted token.
3. **A legacy-encoding filesystem reader (`dsh-win32/fs`).** Stock DSH refuses GBK/UTF-16 files outright (`FS_NOT_TEXT`), so agents cannot open Chinese-locale legacy projects. Both presets mount a reader that sniffs and decodes GBK and UTF-16 transparently on reads. Writes stay UTF-8, so editing a legacy file converts it — deliberate and documented.
4. **A doctor.** Diagnoses the traps the community found the hard way. broken koffi 3.1.3/3.1.4 prebuilts (install failures, folder-picker and session-save crashes), missing PowerShell 7 (the 5.1 fallback crash-loops with 0xC0000142 inside the sandbox), the localhost vs 127.0.0.1 origin 403, and the WSL bash.exe imposter in System32.

## Install

One line, in PowerShell.

```powershell
irm https://raw.githubusercontent.com/sjh9714/dsh-win32/master/install.ps1 | iex
```

That wires the runtime bundle into your web profile, installs the preset, creates a desktop shortcut, and prints a health report. Prefer npx? Same thing.

```sh
npx dsh-win32 setup              # bundle + preset + health report
npx dsh-win32 setup --shortcut   # same, plus the desktop shortcut
```

The preset appears in the picker immediately. Requires [Git for Windows](https://git-scm.com) (`winget install Git.Git`).

Something already broken? `npx dsh-win32 doctor` names each known trap. `npx dsh-win32 fix` repairs what it safely can (pins the broken koffi prebuilt).

## Receipts

- CI runs on real `windows-latest`. It builds the runtime, spawns a persistent Git Bash PTY through it, and proves state survives across writes (`STATE=x` in one call, `echo $STATE` in the next). The same job fails on the stock runtime by construction of the inspector gap.
- Unit tests cover the inspector's tree ordering, pid-recycle cycles, identity matching, and signal mapping.

## Honest limitations (v0.4)

- Interrupting a running command works through Ctrl-C injection (SIGINT/SIGTSTP as PTY input, the ConPTY convention). SIGTERM/SIGKILL against a foreground process stay unsupported on Windows and error honestly.
- MSYS bash still dies under the `workspace-write` ACL restricted token (measured: `cygheap_user::init: NtSetInformationToken (TokenDefaultDacl), 0xC0000022`), so the Git Bash preset needs `danger-full-access`. The busybox variant (`minimal-windows-sandboxed`) is the sandbox-safe answer; trade-off is ash instead of bash (no arrays, no `[[ ]]`).
- PTY output of legacy-codepage native tools cannot be re-decoded at the plugin layer. node-pty decodes as UTF-8 before any DSH code runs and refuses an encoding override on Windows. Git Bash and busybox default to UTF-8, so the shipped presets are unaffected.
- Developed against DSH `0.1.0-rc.6`. DSH is a developer preview with breaking changes announced. version pinned, fast-patch policy on every rc bump.

## License

MIT. The preset composition mirrors the official Minimal preset (MIT) with credit. Trap inventory distilled from community reports in the DSH discussions.
