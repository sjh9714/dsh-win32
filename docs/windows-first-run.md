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

## Verify the installed stack

```powershell
npx dsh-win32 verify --json
```

This uses temporary files and the installed official components to check persistent PowerShell state, workspace read/write, outside-write denial, cancellation, and cleanup. It needs no model account. A pass establishes this component chain; the complete stock Minimal session and hook enforcement are separate checks.

When a coding agent's outer sandbox blocks the verifier, request access for this one command. The verifier's own inner Workspace Write boundary stays enabled. Preserve any snapshot the command retains after an unconfirmed shutdown.

## If only DSH Desktop fails

A successful CLI component check does not validate Electron's packaged process-launch chain. Keep the exact Desktop version, bundled DSH version, and short error separate from the CLI result.

Match the error to its own upstream path; an open issue does not necessarily mean no fix has shipped. Release status checked on **2026-09-14**:

| Reported error | Evidence and boundary |
| --- | --- |
| `0xC0000142` / `STATUS_DLL_INIT_FAILED`, or a PTY startup failure associated with restricted-token launch | [Desktop PR #266](https://github.com/anywhere-labs/dsh-desktop/pull/266) investigates the Electron-to-Windows-ACL runner path. A generic PTY startup message alone does not establish this cause. |
| `Windows Job runner exited with exit code 0 before proving its managed range empty` | [#924](https://github.com/anywhere-labs/dsh-desktop/issues/924) and [#933](https://github.com/anywhere-labs/dsh-desktop/issues/933) track this signature. [PR #927](https://github.com/anywhere-labs/dsh-desktop/pull/927) added Node mode for Electron's private Windows Job runner, without changing the target command's environment. The fix shipped in [Desktop 2.0.9](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.9) and remains in 2.0.10. |
| `Cannot mix BigInt and other types` during bundled-skill discovery or ASAR directory metadata access | [PR #973](https://github.com/anywhere-labs/dsh-desktop/pull/973), included in [Desktop 2.0.10](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.10), removes ASAR packaging and adds packaged-filesystem checks. An unrelated BigInt error is not evidence of this cause. |

Desktop 2.0.10 bundles DSH `0.1.5-rc.2`. Its [release-commit CI](https://github.com/anywhere-labs/dsh-desktop/actions/runs/34783941380) passed the Stable and Beta Windows package checks and installer/portable builds. The [Windows report on PR #927](https://github.com/anywhere-labs/dsh-desktop/pull/927#issuecomment-5620391833) demonstrated the runner mechanism with a local modification to 2.0.7, not a corrected release installation. Neither that report nor a build pass establishes a complete packaged Desktop/Minimal session, PTY cancellation, or cleanup.

For an older Desktop with the Job-runner or ASAR signature, record the failing version, quit the application, and use its official release/update instructions before repeating the same task with unchanged permissions. Record the installed version and whether the original error recurs. dsh-win32 has not independently validated the corrected Windows installer; keep that result separate from the CLI component check and keep the full-session acceptance gate in place.

Do not disable antivirus, widen the session's permissions, replace packaged runtime files, or assume the Job-runner or ASAR changes repair the restricted-token ACL path. dsh-win32's `fix` currently repairs verified koffi problems only. Retain any remaining failure and follow the matching upstream report.

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
