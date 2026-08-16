# dsh-win32

First-class Windows for DeepSeek Harness.

[中文](./README.md) · [![ci](https://github.com/sjh9714/dsh-win32/actions/workflows/ci.yml/badge.svg)](https://github.com/sjh9714/dsh-win32/actions/workflows/ci.yml)

![before and after](./assets/hero.png)

| | Stock DSH on Windows | With dsh-win32 |
|---|---|---|
| Persistent shell in the sandbox | impossible. MSYS dies under the restricted token | **works, on busybox ash. the only one we know of** |
| Minimal preset | dead. every persistent-shell spawn throws `terminal inspection is unsupported on platform win32` | **works. real persistent Git Bash, state survives across tool calls** |
| Foreground command | unresolvable. parent links are severed by MSYS fork emulation | resolved from the ConPTY console list (~81ms) |
| Install traps | koffi segfault chain, PS 5.1 crash loop, localhost 403, WSL bash confusion | one `doctor` command that names each trap and its fix |
| Setup | find the npx command on GitHub every morning | `npx dsh-win32 setup` (+ optional desktop shortcut) |

## Why this exists

The community keeps reporting that DeepSeek models do their best work in DSH's Minimal preset. On Windows that preset does not run at all. Its persistent bash needs a PTY, and the stock subprocess runtime resolves a platform process inspector that throws on win32 before node-pty is even reached. Every Windows user has been locked out of the mode the model is best aligned with.

dsh-win32 closes that gap with three pieces.

1. **A Windows-aware subprocess runtime.** Same stock runtime, plus the missing piece, a win32 ProcessInspector (process trees and identity via CIM, signalling via taskkill). Swapped in by bundle patch on win32 only. Other platforms keep the stock row untouched.
2. **The `minimal-windows` agent preset.** A faithful copy of the official Minimal composition with one change, the PTY shell is your Git Bash. Same complete persona, same two tools, no compaction. v0.4 adds `minimal-windows-sandboxed`, a variant on busybox-w32 ash that STAYS inside the `workspace-write` ACL sandbox (`npx dsh-win32 setup --sandboxed`, downloads busybox on consent). Measured on windows-latest CI, the first persistent shell that survives the restricted token.
3. **Legacy-encoding reads, everywhere they can exist.** Stock DSH refuses GBK/UTF-16 files outright (`FS_NOT_TEXT`) and garbles GBK output of native tools in the foreground shell. Both presets mount a filesystem reader (`dsh-win32/fs`) that sniffs and decodes GBK/UTF-16 on file reads, and since v0.5 the runtime decodes foreground-shell collect output the same way. Writes stay UTF-8, so editing a legacy file converts it. Deliberate and documented. PTY output stays undecodable at the plugin layer (node-pty decodes first), and shipped shells default to UTF-8 so the presets are unaffected.
4. **A doctor.** Diagnoses the traps the community found the hard way. broken koffi 3.1.3/3.1.4 prebuilts (install failures, folder-picker and session-save crashes), missing PowerShell 7 (the 5.1 fallback crash-loops with 0xC0000142 inside the sandbox), the localhost vs 127.0.0.1 origin 403, and the WSL bash.exe imposter in System32.

## Install

One line, in PowerShell.

The ecosystem-convention one-liner. Activating the plugin installs the preset into `$DSH_HOME/.agent-presets/`, and never overwrites one that is already there.

```sh
dsh plugin --profile web add dsh-win32
```

Or let a script do the wiring, in PowerShell.

```powershell
irm https://raw.githubusercontent.com/sjh9714/dsh-win32/master/install.ps1 | iex
```

That wires the runtime bundle into your web profile, installs the preset, creates a desktop shortcut, and prints a health report. Prefer npx? Same thing.

```sh
npx dsh-win32 setup              # bundle + preset + health report
npx dsh-win32 setup --shortcut   # same, plus the desktop shortcut
```

The preset appears in the picker immediately. Requires [Git for Windows](https://git-scm.com) (`winget install Git.Git`).

The sandboxed variant (`minimal-windows-sandboxed`) only installs through `setup --sandboxed`, because it needs busybox-w32 and busybox is GPLv2. Downloading it silently during plugin activation would be both a licence and a consent problem. Wiring the bundle also needs pnpm, because `dsh plugin add` installs into the profile directory with it. `setup` enables pnpm through corepack when it is missing, and `doctor` reports it either way.

Something already broken? `npx dsh-win32 doctor` names each known trap. `npx dsh-win32 fix` repairs what it safely can (pins the broken koffi prebuilt).

`doctor` also emits machine-readable results for CI and support use.

```sh
npx dsh-win32 doctor --json
```

The output is the community `dsh-doctor/v1` envelope ([deepseek-harness#1719](https://github.com/deepseek-ai/deepseek-harness/discussions/1719)), with the contract's 0 / 1 / 2 exit codes (all pass / any warn / any fail). The `skip` status in it is ours. A check like `git_bash` is neither a pass nor a failure on Linux, it does not apply, and with only three states an implementation has to either lie or poison a cross-platform CI run. `skip` carries a mandatory reason and counts as neither.

## Writing your own preset on Windows

If your preset mounts `@deepseek-ai/dsh-terminal-bash` without an explicit `shellPath`, the default `/bin/bash` resolves to `C:\Windows\System32\bash.exe` on Windows, the WSL launcher, and the PTY exits at startup. Point it at the real shell instead.

```yaml
- id: terminal-bash
  name: '@deepseek-ai/dsh-terminal-bash'
  config:
    shellPath: 'C:/Program Files/Git/usr/bin/bash.exe'
    shellArgs: ['--noprofile', '--norc', '-i']
```

Use `usr/bin/bash.exe` rather than `bin/bash.exe`. The latter is a 47KB wrapper that respawns the former, so the PTY pid ends up pointing at the wrapper instead of the shell. Reported by a user in #6.

## China network note · 中国网络提示

`irm raw.githubusercontent.com...` 和 busybox 的 `frippery.org` 在部分网络环境下可能无法直连。替代路径：安装用 `npx dsh-win32 setup`（npm 源可换 npmmirror），busybox 手动下载后用 `npx dsh-win32 setup --sandboxed --busybox <路径>` 指定。

## Receipts

- CI runs on real `windows-latest`. It builds the runtime, spawns a persistent Git Bash PTY through it, and proves state survives across writes (`STATE=x` in one call, `echo $STATE` in the next). The same job fails on the stock runtime by construction of the inspector gap.
- Unit tests cover the inspector's tree ordering, pid-recycle cycles, identity matching, and signal mapping.

## Honest limitations (v0.5)

- Interrupting a running command works through Ctrl-C injection (SIGINT/SIGTSTP as PTY input, the ConPTY convention). SIGTERM/SIGKILL against a foreground process resolve the command through the ConPTY console list and tree-kill it. What has no win32 answer is stdin-wait probing, which stays `false`, so the harness settles a finished command on the prompt marker rather than on an exact stdin probe. Since v0.5 a failed terminal teardown falls back to `taskkill /T /F` (directly spawned console apps can survive a ConPTY kill).
- MSYS bash still dies under the `workspace-write` ACL restricted token (measured signature `cygheap_user::init: NtSetInformationToken (TokenDefaultDacl), 0xC0000022`), so the Git Bash preset needs `danger-full-access`. The busybox variant (`minimal-windows-sandboxed`) is the sandbox-safe answer. The trade-off is ash instead of bash (no arrays, no `[[ ]]`).
- `foregroundPgid` has to answer with one pid, but every stage of a pipeline attaches to the console. It resolves the newest attachment, so SIGTERM/SIGKILL against `a | b | c` tree-kill that stage and its descendants and leave the sibling stages running until the pipe breaks; POSIX would reach all three through the shared pgid. SIGINT is unaffected, it goes through Ctrl-C injection and the shell signals its whole job. Newest is deliberate rather than oldest: a lingering background job is older than the foreground command, so oldest would both mis-target the signal and report a busy foreground while the shell sits at the prompt, which is the discriminator failure [#7](https://github.com/sjh9714/dsh-win32/issues/7) was about. Tracked in [#11](https://github.com/sjh9714/dsh-win32/issues/11).
- The official bash tool wraps every command as `eval -- '...'`, and `eval --` is a bashism. POSIX shells do not accept `--` for the `eval` special builtin, so busybox ash reads `--` as the command name and every command in the sandboxed preset failed with `eval: --: not found` (exit 127), reported in [#12](../../issues/12) on busybox-w32 v1.38 and reproduced here on dash, which rules out a busybox quirk. `eval` cannot be shadowed either, since a special builtin's name is rejected as a function name. So the rewrite happens at the layer that writes to the PTY, turning it into the portable equivalent (one leading space inside the quotes). It matches the full shape of the official wrapper only, and it is behaviour-identical on bash including the leading-dash case `--` exists to guard. Reported at [deepseek-harness#2271](https://github.com/deepseek-ai/deepseek-harness/discussions/2271); this goes away when the fix lands there.
- PTY output of legacy-codepage native tools cannot be re-decoded at the plugin layer. node-pty decodes as UTF-8 before any DSH code runs and refuses an encoding override on Windows. Git Bash and busybox default to UTF-8, so the shipped presets are unaffected.
- Developed against DSH `0.1.0-rc.6`. DSH is a developer preview with breaking changes announced. version pinned, fast-patch policy on every rc bump.

## License

MIT. The preset composition mirrors the official Minimal preset (MIT) with credit. Trap inventory distilled from community reports in the DSH discussions.
