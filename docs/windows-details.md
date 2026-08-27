# Windows details

> Current DSH includes official persistent PowerShell and a Windows ACL sandbox. The shell, preset, filesystem, and busybox sections below document the explicit `--legacy` path and the evidence behind earlier releases. The default `npx dsh-win32 setup` no longer installs those components.

[English storefront](../README.md) · [中文](../README.zh.md)

**Add a persistent Git Bash or Workspace Write ash shell to DSH on Windows.**

> [!IMPORTANT]
> DSH rc.8 and later include a Windows process inspector and use persistent PowerShell in the stock Minimal preset. dsh-win32 is now an alternative-shell package, not the only way to run Minimal on Windows. Release 0.15.1 remains on DSH rc.6 because `@deepseek-ai/dsh-subprocess-local@0.1.1-rc.2` still pins the measured `node-pty@1.2.0-beta.15` Windows regression. Use stock Minimal on current DSH or follow [the upstream report](https://github.com/deepseek-ai/deepseek-harness/discussions/2851) before installing these custom PTY presets.

[中文](../README.zh.md)

<p>
<a href="https://www.npmjs.com/package/dsh-win32"><img src="https://img.shields.io/npm/v/dsh-win32?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
<a href="https://github.com/sjh9714/dsh-win32/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/sjh9714/dsh-win32/ci.yml?style=flat-square&label=CI" alt="CI"></a>
<a href="https://github.com/sjh9714/dsh-win32/stargazers"><img src="https://img.shields.io/github/stars/sjh9714/dsh-win32?style=flat-square" alt="stars"></a>
<img src="https://img.shields.io/badge/platform-win32-0078D4?style=flat-square" alt="win32">
<img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT">
</p>

![a whole bug fix, run inside the sandbox](../assets/shot-persistent-sandboxed.png)

A real screenshot. At `Workspace Write`, the agent runs the tests to see them fail, reads the source to find the bug, fixes it, and runs again for `all tests passed`.

## Legacy preset path

```powershell
npx dsh-win32 setup --legacy --sandboxed
```

This explicit legacy command installs the busybox ash preset for an rc.6-era DSH profile. It does not replace the stock Minimal preset on current DSH. The Git Bash legacy preset requires [Git for Windows](https://git-scm.com) (`winget install Git.Git`). The sandboxed preset does not require Git Bash.

Setup leaves a **"DeepSeek Harness"** shortcut on your desktop, so starting it is a **double-click** rather than a command you look up every morning (pass `--no-shortcut` if you would rather not have one). It opens a console; use the **exact** url that console prints. `npx @deepseek-ai/dsh web` still works.

Once it is up.

1. On the `Workspaces` row in the sidebar, click the folder icon and **add a workspace first**. Until you do, the composer is greyed out and will not take input
2. Pick **Minimal (Windows, sandboxed)** in the preset picker
3. Leave the permission badge on **Workspace Write**

Want Git Bash instead of busybox? `npx dsh-win32 setup --legacy` installs the other preset. Pick **Minimal (Windows)** and switch the badge to `danger-full-access`. The difference between the two is the first item below.

Something not working? `npx dsh-win32 doctor` names each known trap.

## What dsh-win32 adds

| Capability | Current stock DSH on Windows | dsh-win32 0.16.0 legacy mode on rc.6 |
|---|---|---|
| Minimal shell | persistent PowerShell on rc.8 and later | persistent Git Bash in full access, or busybox ash in Workspace Write |
| Git Bash in Workspace Write | MSYS dies under the restricted token | not attempted. the sandboxed preset uses native busybox ash instead |
| Legacy-encoded reads | no documented GBK or UTF-16 fallback | GBK and UTF-16 file reads, plus decoded foreground collect output |
| Windows diagnosis | standard host errors and logs | one `doctor` command for the measured Windows traps |
| Custom preset setup | not needed for stock Minimal | `npx dsh-win32 setup --legacy`, then a desktop shortcut |

## Why this exists

The project began when DSH rc.7 and earlier could not construct the stock Minimal PTY on Windows. DSH rc.8 closed that core gap with a Windows process inspector and a PowerShell composition. The remaining product is narrower. It offers Git Bash for users who want a Unix-like shell, busybox ash for the Workspace Write lane where MSYS cannot start, legacy-encoding reads, and a doctor for recurring Windows setup failures.

dsh-win32 closes that gap with four pieces.

1. **A Windows-aware subprocess runtime for the supported rc.6 host.** Same stock runtime, plus the then-missing win32 ProcessInspector (process trees and identity via CIM, signalling via taskkill). DSH rc.8 now has its own upstream inspector. The plugin does not claim compatibility with that newer line while its pinned node-pty version remains broken on this path.
2. **The `minimal-windows` agent preset.** A faithful copy of the official Minimal composition with one change, the PTY shell is your Git Bash. Same complete persona, same two tools, no compaction. v0.4 adds `minimal-windows-sandboxed`, a variant on busybox-w32 ash that STAYS inside the `workspace-write` ACL sandbox (`npx dsh-win32 setup --legacy --sandboxed`, downloads busybox on consent). Measured on windows-latest CI, the first persistent shell that survives the restricted token.
3. **Legacy-encoding reads, everywhere they can exist.** Stock DSH refuses GBK/UTF-16 files outright (`FS_NOT_TEXT`) and garbles GBK output of native tools in the foreground shell. Both presets mount a filesystem reader (`dsh-win32/fs-confined` since v0.11, which also fences editor writes by the session permission mode) that sniffs and decodes GBK/UTF-16 on file reads, and since v0.5 the runtime decodes foreground-shell collect output the same way. Writes stay UTF-8, so editing a legacy file converts it. Deliberate and documented. PTY output stays undecodable at the plugin layer (node-pty decodes first), and shipped shells default to UTF-8 so the presets are unaffected.
4. **A doctor.** Diagnoses the traps the community found the hard way. It checks broken koffi 3.1.3/3.1.4 prebuilts and verifies that the installed package actually loads at runtime, then checks missing PowerShell 7 (the 5.1 fallback is reported to crash with 0xC0000142 in the packaged desktop app, though a confined 5.1 starts fine on this CLI path), the localhost vs 127.0.0.1 origin 403, and the WSL bash.exe imposter in System32.

## Current DSH setup

One line, in PowerShell.

```powershell
npx dsh-win32 setup
```

This checks the official persistent PowerShell and Workspace Write stack, applies only measured repairs, and creates a desktop shortcut. It does not install a custom preset or wire the legacy runtime bundle.

The PowerShell installer performs the same current-path setup.

```powershell
irm https://raw.githubusercontent.com/sjh9714/dsh-win32/master/install.ps1 | iex
```

## Legacy install

Activating the plugin directly installs the old custom preset into `$DSH_HOME/.agent-presets/`. Use this only for an rc.6-era profile that cannot move to current DSH.

```sh
dsh plugin --profile web add dsh-win32
```

The explicit npx path wires the runtime bundle, installs the preset, creates a desktop shortcut, and prints a health report.

```sh
npx dsh-win32 setup --legacy                # bundle + preset + health report
npx dsh-win32 setup --legacy --no-shortcut  # same, without the desktop shortcut
```

![the preset picker](../assets/shot-preset-picker.png)

The preset appears in the picker immediately. The Git Bash preset requires [Git for Windows](https://git-scm.com) (`winget install Git.Git`). The sandboxed preset uses busybox ash and does not require Git Bash.

The sandboxed variant (`minimal-windows-sandboxed`) only installs through `setup --legacy --sandboxed`, because it needs busybox-w32 and busybox is GPLv2. Downloading it silently during plugin activation would be both a licence and a consent problem. Wiring the bundle also needs pnpm, because `dsh plugin add` installs into the profile directory with it. Legacy setup enables pnpm through corepack when it is missing, and `doctor --legacy` reports it either way.

Something already broken? `npx dsh-win32 doctor` names each known trap. `npx dsh-win32 fix` repairs what it safely can. For koffi it installs 3.1.2 without the lifecycle script, forces the optional platform package to relink, and verifies a real runtime load afterward.

`doctor` also emits machine-readable results for CI and support use.

```sh
npx dsh-win32 doctor --json
```

The output is the community `dsh-doctor/v1` envelope ([deepseek-harness#1719](https://github.com/deepseek-ai/deepseek-harness/discussions/1719)), with the contract's 0 / 1 / 2 exit codes (all pass / any warn / any fail). The `skip` status in it is ours. A check like `git_bash` is neither a pass nor a failure on Linux, it does not apply, and with only three states an implementation has to either lie or poison a cross-platform CI run. `skip` carries a mandatory reason and counts as neither.

**`dsh-doctor/v1` vocabulary r5 compatible.** Drafted by [@ciceroyang](https://github.com/ciceroyang) (ciceroyang/dsh-doctor), reviewed by [@sjh9714](https://github.com/sjh9714) (dsh-win32) and [@moonquake2004](https://github.com/moonquake2004).

The status literals are `pass`, `warn`, `fail` and `skip`. `node` is two-state on purpose, `pass` inside the declared range and `warn` outside it, which matches npm's EBADENGINE semantics and avoids a `fail` boundary that nothing declares.

## Current upstream boundaries outside the doctor

`doctor` can inspect package declarations and measured local runtime failures. `verify` can exercise the installed official PowerShell component chain in a disposable home and workspace. Neither can safely rewrite a user's profile, install a test plugin, or issue a model-driven tool call merely to claim that these separate upstream paths work.

- [`dsh plugin add` path handling on Windows](https://github.com/deepseek-ai/deepseek-harness/discussions/2485) can split local paths containing spaces; relative paths can also bind to the caller's working directory. Use a published package specifier where possible. For a local package, stage it at a space-free absolute path and read the installed manifest back.
- [Hook bridge enforcement on Windows](https://github.com/deepseek-ai/deepseek-harness/discussions/2485) can lose an interpreter's blocking exit code through PowerShell. Separately, [`continue:false` can be logged as stop without halting execution](https://github.com/deepseek-ai/deepseek-harness/discussions/1514). A harmless unconditional deny canary after hook edits and DSH upgrades is the only end-to-end proof while those reports remain unresolved.

A green dsh-win32 `verify` report intentionally makes no claim about either path. Its machine-readable `boundary` names the plugin installer and hook bridges as excluded.

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

`irm raw.githubusercontent.com...` 和 busybox 的 `frippery.org` 在部分网络环境下可能无法直连。当前 DSH 检查可用 `npx dsh-win32 setup`（npm 源可换 npmmirror）。旧版 busybox 预设需要 `npx dsh-win32 setup --legacy --sandboxed --busybox <路径>`。

## Receipts

- CI runs on real `windows-latest`. It builds the runtime, spawns a persistent Git Bash PTY through it, and proves state survives across writes (`STATE=x` in one call, `echo $STATE` in the next). The same job fails on the stock runtime by construction of the inspector gap.
- Unit tests cover the inspector's tree ordering, pid-recycle cycles, identity matching, and signal mapping.

## Honest limitations

- Interrupting a running command works through Ctrl-C injection (SIGINT/SIGTSTP as PTY input, the ConPTY convention). SIGTERM/SIGKILL against a foreground process resolve the command through the ConPTY console list and tree-kill it. What has no win32 answer is stdin-wait probing, which stays `false`, so the harness settles a finished command on the prompt marker rather than on an exact stdin probe. Since v0.5 a failed terminal teardown falls back to `taskkill /T /F` (directly spawned console apps can survive a ConPTY kill).
- MSYS bash still dies under the `workspace-write` ACL restricted token (measured signature `cygheap_user::init: NtSetInformationToken (TokenDefaultDacl), 0xC0000022`), so the Git Bash preset needs `danger-full-access`. The busybox variant (`minimal-windows-sandboxed`) is the sandbox-safe answer. The trade-off is ash instead of bash (no arrays, no `[[ ]]`).
- `foregroundPgid` has to answer with one pid, but every stage of a pipeline attaches to the console. That is enough for the readiness discriminator, which only needs shell against not-shell, but not for signalling, so `signalGroup` **re-resolves and fans out** over the terminal's current non-background attachments ([#24](https://github.com/sjh9714/dsh-win32/issues/24)). Measured on `sleep 90 | cat | cat`: all three stages cleared by SIGTERM, against all three surviving before. The residual is the race. If the job changed between the resolve and the signal, only the original pid is reached, which is the old behaviour. Background jobs are excluded by `resting`, so this cannot widen into work the user did not ask to cancel. SIGINT is unaffected, it goes through Ctrl-C injection and the shell signals its whole job. Newest is deliberate rather than oldest: a lingering background job is older than the foreground command, so oldest would both mis-target the signal and report a busy foreground while the shell sits at the prompt, which is the discriminator failure [#7](https://github.com/sjh9714/dsh-win32/issues/7) was about.
- The official bash tool wraps every command as `eval -- $'...'` (note the `$`, since `quoteForBash` emits ANSI-C quoting), and `eval --` is a bashism. POSIX shells do not accept `--` for the `eval` special builtin, so busybox ash reads `--` as the command name and every command in the sandboxed preset failed with `eval: --: not found` (exit 127), reported in [#12](../../../issues/12) on busybox-w32 v1.38 and reproduced here on dash, which rules out a busybox quirk. `eval` cannot be shadowed either, since a special builtin's name is rejected as a function name. So the rewrite happens at the layer that writes to the PTY, turning it into the portable equivalent (one leading space inside the quotes). That `$` is load bearing. 0.8.1 anchored the rewrite on a plain single quote, which never matched the production string, so the rewrite fired zero times and the sandboxed preset kept dying under a claim that it was fixed. 0.9.1 is the first release where it actually works. The rewrite matches the full shape of the official wrapper only, and it is behaviour-identical on bash including the leading-dash case `--` exists to guard. Reported at [deepseek-harness#2271](https://github.com/deepseek-ai/deepseek-harness/discussions/2271); this goes away when the fix lands there. **The rewrite covers shells that implement ANSI-C quoting, not every POSIX shell.** It keeps the `$'...'`, and that is itself a bashism. busybox ash implements it, which is why the CI sandbox gate is green on exactly this form, but dash does not: `$'abc'` yields the literal `$abc` there, so the error moves from `eval: --: not found` to `eval: $: not found` and stays exit 127. Full POSIX coverage needs `quoteForBash` to have a plain single-quote escaping path, which is upstream's call. busybox ash is the one lane supported here.
- **The write fence inherits a Windows gap from core's `writableRoots`.** That allow-list contains the POSIX literal `/tmp`, and on Windows `realpathSync.native('/tmp')` resolves it against the current drive, so an existing `C:\tmp` becomes a writable root. `C:\tmp` is modifiable by all Authenticated Users on a default install, which makes it a machine-shared staging area rather than the per-user temp the mode documents. The ACL sandbox denies shell writes there, so the two write planes disagree on the same path. Reported upstream in [#2562](https://github.com/deepseek-ai/deepseek-harness/discussions/2562) by Binhna / @maycuatroi1. Until core changes it, treat `C:\tmp` as outside the fence on Windows.
- PTY output of legacy-codepage native tools cannot be re-decoded at the plugin layer. node-pty decodes as UTF-8 before any DSH code runs and refuses an encoding override on Windows. Git Bash and busybox default to UTF-8, so the shipped presets are unaffected.
- **win32 has no graceful terminate for a console process, so `SIGTERM` escalates when the graceful form is refused.** taskkill without `/F` asks a window to close, and a console process has none, so it exits 128 and leaves the target running; the old code read that failure as "already gone", which made `SIGTERM` a no-op against every MSYS command. The graceful attempt is still made, and the escalation to a forced kill happens only when taskkill reports failure **and** the process is still alive, so a target that exits on its own is never force-killed. **Nothing is being given up here**: the graceful form cannot work on this platform at all, so the choice is a forced kill or no kill, not graceful against forced. See [#24](https://github.com/sjh9714/dsh-win32/issues/24).
- Developed against DSH `0.1.0-rc.6`. DSH is a developer preview with breaking changes announced. version pinned, fast-patch policy on every rc bump.

## Related

[dsh-lean](https://github.com/sjh9714/dsh-lean) — cut the DSH prompt prefix 53% by removing the delegation, goal and job tools a single-agent session never calls. `npx dsh-lean audit` shows where your own session's tokens went, nothing installed.

## License

MIT. The preset composition mirrors the official Minimal preset (MIT) with credit. Trap inventory distilled from community reports in the DSH discussions.
