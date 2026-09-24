# Diagnose DSH startup and session failures on Windows

[README](../README.md) · [中文](./windows-first-run.zh.md) · [Coding-agent request](./agent-setup.md)

Use this when the official DSH Windows installation will not start PowerShell, a running session disconnects, or a runtime update leaves you unsure what failed. dsh-win32 checks the current official stack and repairs specific known failures. It does not install DSH, PowerShell, Git, or WSL.

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

## If DSH skips the legacy dsh-win32 bundle

An error such as `skipping profile bundle "dsh-win32"` with peer range `>=0.1.0-rc.5 <0.1.0-rc.7` concerns the **legacy plugin**, not the standalone CLI. This distinction matters for [#89](https://github.com/sjh9714/dsh-win32/issues/89), reported with DSH `0.1.7-rc.1`.

That host requires [`ProcessInspector.snapshot()` to return an object with `tree()`, `session()`, and `alive()`](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/subprocess/subprocess-local/src/process-inspector.ts#L34). The legacy dsh-win32 inspector returns an array. A bounded test using the published 0.17.12 inspector and synthetic process data reproduces `TypeError: inspector.snapshot(...).tree is not a function`. This is a contract test, not a Windows session test. The host also [already supplies its own Windows inspector](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/subprocess/subprocess-local/src/process-inspector.ts#L549). Cold startup and `--dump-config` do not exercise persistent-terminal readiness, cancellation, or cleanup.

- Do not widen the peer range, use `allow-version` as a repair, or copy the old preset directory into a new host. Legacy presets remain rc.6-era support; this is not a claim of support for every release before 0.1.7.
- Record the actual DSH version and launcher, then inspect the affected profile with `npx dsh-win32 doctor --profile NAME --json`. Doctor uses published metadata for the current package check; that metadata does not identify the running host.
- Before migrating an existing profile, stop its session and review its configuration and custom presets. Use the [offline disable and uninstall procedure](./uninstall.md) when the old bundle must be disconnected, including when DSH itself cannot start. Preview `npx dsh-win32@0.17.14 disable --profile NAME`, then add `--apply` to back up and change only the bundle list. Review manual patch/preset references separately; do not delete the profile or discard custom configuration.
- Use the official stock Minimal preset with Workspace Write, and the standalone `npx dsh-win32 verify --profile NAME --json` for component evidence. The verifier reports its selected installed version/source; confirm that these match the host you intend to test. A pass does not prove profile migration, the complete UI session, or another host version.

If the stock profile still fails, report the exact DSH, Node and dsh-win32 versions, selected verification version/source, failing check and a short redacted error. Do not publish full profiles, paths, terminal logs, or credentials. Keep Workspace Write and package-manager policy unchanged.

## Verify the installed stack

From dsh-win32 **0.17.12**, combine current-mode setup and one installed-stack check:

```powershell
npx dsh-win32 setup --verify
```

Add `--profile NAME --no-shortcut` to keep a selected profile and skip the shortcut. Ordinary `setup` is unchanged. The optional check reports the actually installed DSH version/source, separately from setup's registry metadata, and returns nonzero for a failed or unsupported verification. It does not install missing prerequisites or change profile/package-manager policy. `setup --legacy --verify` is rejected before legacy setup runs.

For verification without setup, or for machine-readable results, keep using:

```powershell
npx dsh-win32 verify --json
```

This uses temporary files and the installed official components to check persistent PowerShell state, workspace read/write, outside-write denial, cancellation, and cleanup. It needs no model account. A pass establishes this component chain; the complete stock Minimal session and hook enforcement are separate checks.

When a coding agent's outer sandbox blocks the verifier, request access for this one command. The verifier's own inner Workspace Write boundary stays enabled. Preserve any snapshot the command retains after an unconfirmed shutdown.

## If only DSH Desktop fails

A successful CLI component check does not validate Electron's packaged process-launch chain. Keep the exact Desktop version, bundled DSH version, and short error separate from the CLI result.

Match the error to its own upstream path; issue closure and a green build are not complete-session evidence. Release status checked on **2026-09-21**. The latest [Desktop 2.0.13](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.13) bundles DSH `0.1.5-rc.2`:

| Reported error | Evidence and boundary |
| --- | --- |
| `0xC0000142` / `STATUS_DLL_INIT_FAILED` in consoleless restricted-token shell startup | [PR #990](https://github.com/anywhere-labs/dsh-desktop/pull/990) shipped in [Desktop 2.0.11](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.11) and is included in 2.0.13. [PR #266](https://github.com/anywhere-labs/dsh-desktop/pull/266) was closed without merging; that does not make #990 unreleased. A generic PTY error does not identify this cause. |
| `Windows Job runner exited with exit code 0 before proving its managed range empty` | [PR #927](https://github.com/anywhere-labs/dsh-desktop/pull/927) and [#931](https://github.com/anywhere-labs/dsh-desktop/pull/931) repair the private Electron Job-runner path, shipped since [2.0.9](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.9). The maintainer [closed #933 for that original signature](https://github.com/anywhere-labs/dsh-desktop/issues/933#issuecomment-5748645422), not every later terminal failure. |
| `PTY shell exited during startup`, with a silent ConPTY runner exit `127` | [#1051](https://github.com/anywhere-labs/dsh-desktop/issues/1051) remains open: a Windows 11 user reports persistent-terminal failure on 2.0.13 with Store/MSIX PowerShell. A fresh-profile comparison was not run. This report is not our independent reproduction and is distinct from the foreground executor fixed by #990. |
| `Cannot mix BigInt and other types` during bundled-skill discovery or ASAR directory metadata access | [PR #973](https://github.com/anywhere-labs/dsh-desktop/pull/973), included in [Desktop 2.0.10](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.10), removes ASAR packaging and adds packaged-filesystem checks. An unrelated BigInt error is not evidence of this cause. |
| Cargo/Schannel `SEC_E_NO_CREDENTIALS` (`0x8009030e`) fetching crates.io under Workspace Write | Our [separate TLS reproduction](https://github.com/deepseek-ai/deepseek-harness/discussions/986#discussioncomment-18494537) remains unresolved. Shell startup succeeding does not prove HTTPS works. Do not disable certificate checks or widen permissions to turn this into a pass. |

Our [2026-09-18 payload probe](https://github.com/anywhere-labs/dsh-desktop/issues/924#issuecomment-5725248498) verified the official **2.0.11 x64 Setup.exe checksum, then extracted it without installing it**. On Windows Server 2022 and 2025, using Node 22.19 and the payload's Electron 43.3.0/Node 24.18.1, the four combinations passed foreground PowerShell startup, inside writes, outside-write denial, cancellation/direct-child termination, and context cleanup. The Desktop path used its released `DesktopWindowsPwshSandbox` implementation. This was not normal Desktop UI, persistent PTY, glob/grep, hooks, Blue, stock Minimal, or model-session acceptance, and it does not independently validate 2.0.13.

In that same probe, Cargo 1.98.1 fetched `itoa 1.0.15` in each unconfined control but failed TLS in all four Workspace Write cases. The [diagnostic run is red](https://github.com/sjh9714/dsh-win32/actions/runs/35307547925) because that TLS test failed; it did not invoke dsh-win32's runtime. The separate [dsh-win32 0.17.11 release CI is green](https://github.com/sjh9714/dsh-win32/actions/runs/35307413235). The [pinned diagnostic source](https://github.com/sjh9714/dsh-win32/blob/501f6f8516713f47fe8ef7690b7527ee90b34dec/scripts/upstream-windows-probe.mjs) was not shipped in the npm package.

For an older Desktop with a matching released fix, record the failing version, quit the application, and follow its official update instructions before repeating the same task with unchanged permissions. Record the actual installed version and any remaining error. Keep the [full-session gate](https://github.com/sjh9714/dsh-win32/issues/84) and [Blue gate](https://github.com/sjh9714/dsh-win32/issues/55) in place. Do not disable Defender/antivirus, TLS verification, or Workspace Write, and do not replace packaged runtime files. dsh-win32's `fix` repairs verified koffi problems only, not the remaining upstream failures.

## If a running session disconnects with `spillAll` / `ENOENT`

An `ENOENT` from `OutputCollector.spillAll` while opening a `dsh-subprocess-*` output file matches [upstream #2252](https://github.com/deepseek-ai/deepseek-harness/discussions/2252). If an external cleanup removes the temporary output directory, the next output overflow can throw from a stream callback and terminate the host. A generic disconnect alone does not establish this cause.

On 2026-09-16, an isolated Node test of the unchanged collector class extracted from the published `@deepseek-ai/dsh-subprocess-local@0.1.5-rc.1` archive reproduced an uncaught `ENOENT` after deletion before the first spill; a healthy directory and a no-spill control passed. This was a macOS collector-level test, not a complete DSH host or Windows session test. The inspected `0.1.5-rc.2` source and `0.1.6-alpha.1`'s relocated `output.ts` still contain the unguarded spill writes; upgrading to those versions is not an established repair.

- Record the actual DSH and Node versions and only the short, redacted error. Preserve the profile and session history.
- Once the failed process has exited, restart through your existing DSH launcher. Do not delete temporary directories used by a running DSH process.
- `doctor`, `fix`, and a passing `verify` do not repair or rule out this failure. The legacy Win32 collector has its own I/O protection, but current setup does not replace the official collector. Do not install the legacy bundle as a workaround or patch packaged runtime files in place.

Keep Workspace Write, antivirus, and package-manager policy unchanged. Follow the upstream fix and verify its exact released version before treating the problem as resolved.

## Open your first session

`npx dsh-win32 setup` checks the current setup and creates the Web-profile desktop shortcut. Use `--no-shortcut` if you do not want one. Launch DSH using the shortcut or its [official instructions](https://github.com/deepseek-ai/deepseek-harness#run), add a workspace, and select stock **Minimal** with **Workspace Write**.

If you already configured a model provider, ask for one small task in a disposable workspace, such as reading a sample README. Record separately whether the UI opened, the tool ran, and the expected answer appeared. A model task can incur normal provider usage. Without a provider, mark that task **not run** rather than inferring success from `verify`.

Once the host works, [Movein's first-task guide](https://github.com/sjh9714/dsh-movein/blob/main/docs/first-task.md) explains how to try existing coding-agent configuration. It is optional.

## Share a result or record a demonstration

We are collecting first-run feedback: [versions, intended task, and the step reached](https://github.com/sjh9714/dsh-win32/issues/new?template=first-run.md). A still-blocked attempt helps as much as a success. Share only a short redacted error or synthetic reproduction, never full configuration, credentials, private paths, or workspace contents.

For a real Windows recording, use an empty sample workspace and a clean terminal. Show the observed failure, the supported repair only if one is needed, then the same check succeeding. If the machine is healthy, label the clip as a healthy-stack check; do not invent a failure. Show a model-backed task only if it actually ran. Review every frame before publishing.

The README's existing GIF is a reproduced animation, not that recording. A component-check clip also must not be labelled as a complete Blue/Minimal session test.
