# Windows acceptance and recording runbook

[First-run guide](./windows-first-run.md) · [Full-session task #84](https://github.com/sjh9714/dsh-win32/issues/84) · [Recording task #86](https://github.com/sjh9714/dsh-win32/issues/86)

Reviewed on 2026-10-20. This is a procedure, not a successful Windows run. Keep separate results for the official Web host with stock Minimal, the normally installed Desktop UI, and the CLI component verifier. Do not substitute extracted Desktop payloads or a simulated agent for UI acceptance.

## Before running

- Use an explicitly available disposable native Windows VM or test account. Record Windows build and CPU architecture. Do not reuse a personal Windows account or profile. A new profile name alone does not isolate credentials and sessions.
- Record the selected DSH, Node/Electron, PowerShell, dsh-win32 and Desktop versions. Keep application name, channel, About version/build, bundled DSH version, public installer URL and published checksum separate. Verify the original installer before installing it. Do not silently choose a newer host or treat npm metadata as the installed identity.
- Current standalone dsh-win32 is 0.17.14 at this review. The existing Windows component CI is not proof that an arbitrary newly selected host works. Use current-mode setup, not `setup --legacy`, `--sandboxed`, or `dsh plugin add dsh-win32` as a migration path.
- Confirm prerequisites before installation. dsh-win32 does not install DSH or PowerShell. Preserve package-manager policy, including any 1,440-minute minimum release age and strict build approvals. Do not bootstrap missing tools or change global settings without separate approval.
- Model-backed tests require a named provider, model and explicitly approved cost cap for this Windows task. No such approval is implied by approval for another project. Without it, run only the component demonstration and mark model tests not run.
- Next is an experimental, community-maintained Desktop channel. Its [2.0.18-next notes](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.18-next) say it shares `~/.dsh` by default. `DSH_DESKTOP_NEXT_HOME` does not isolate AA shared sign-in/device binding. Use a separate Windows test account/VM, not only another profile or data directory.
- The [Stable 2.0.18 announcement](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.18) lists upstream DSH `0.2.1-rc.2` and says the next release will replace Stable with Next. Keep the selected channel explicit. Neither that transition nor the older component CI is a successful acceptance result for this release.

## Component demonstration without a model

Run only inside the prepared test environment with the intended installed Web host/profile. These examples pin the CLI, not DSH or its dependency graph. Replace `NAME` with the actual selected profile; do not run it literally or invent a profile to hide a failure.

```powershell
node --version
pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
where.exe pwsh
npx dsh-win32@0.17.14 doctor --profile NAME --json
```

Doctor warnings must be explained. A discovered PowerShell path does not prove confined startup. Current mode legitimately skips legacy-only checks. Do not require all checks to say pass, install a legacy bundle, or run `fix` without a matching diagnosed koffi failure.

For the actual setup demonstration, run once and record the exit code immediately.

```powershell
npx dsh-win32@0.17.14 setup --verify --profile NAME --no-shortcut
$LASTEXITCODE
```

`--no-shortcut` skips shortcut creation; it does not disable other setup behavior. Use no personal GitHub credentials in the disposable test account. Review setup's account-related behavior before running it. Do not answer prompts or use an authenticated account on someone else's behalf.

For verification without setup, use the alternative below rather than rerunning both paths solely for another green result.

```powershell
npx dsh-win32@0.17.14 verify --profile NAME --json
$LASTEXITCODE
```

Record the selected installed DSH version/source, each result and cleanup outcome. If the selected installation does not match the intended target, mark that target not run. A CLI pass is not normal Desktop UI, full Minimal, Blue or hook-enforcement acceptance. Retain artifacts when shutdown is unconfirmed.

## Real sessions, separately for Web and Desktop

Prepare two disposable sibling directories under a unique test root. Register only the workspace directory with the tested host. Keep the other directory outside the workspace and outside any separately writable temporary root. Use synthetic sample files and no personal data.

1. Launch the real selected host normally. Record its actual profile, stock preset and Workspace Write mode. Stop on an unexpected legacy preset, version or launcher.
2. Through two separate model-facing persistent shell calls in the same session, set a harmless environment value and working directory, then print both in a second call. Preserve the actual tool output, not only the model's description. Record the tool identity so a foreground executor is not mistaken for persistent PTY.
3. Ask the UI's real tools to read a synthetic file, create another file inside the workspace, and find a known filename/content using glob and grep. Verify the actual filesystem result and matches.
4. In an ordinary process, write and then remove a uniquely named control file in the disposable outside directory. This proves the path is normally writable. Ask the confined session to write that same path. Require a denial and independently verify that no file was created. A failed ordinary control makes the boundary test inconclusive, not passed. If confined writing succeeds, stop and retain evidence; do not continue with private data.
5. Start a bounded long-running operation through the UI, interrupt it, then verify the documented session recovery or replacement behavior and a subsequent operation. Track the owned child PID and exit. Do not infer cancellation from the UI button alone.
6. Stop the host/UI. Verify the test-owned processes have exited and the recorded listening ports have closed. Do not kill all Node, PowerShell or Desktop processes. Do not delete the test tree until containment and shutdown are confirmed.

Keep Defender, certificate verification, token/ACL restrictions and package policies unchanged. Do not patch ASAR or bundled runtimes, replace the interpreter, or switch to full access to make a test pass. Cargo TLS remains a separate upstream limitation even if a shell starts successfully.

## Recording and result sheet

A healthy component recording can satisfy its own part of #86 without waiting for model tests. Capture real Windows frames with the actual command, version, result and scope visible. Do not stage a failure, replace failed output or present an animation as a recording. Review every frame for credentials, private paths, notifications and personal workspace content before requesting publication approval.

Fill this table from observed results, leaving unexecuted rows as not run.

| Check | CLI components | Stock Minimal Web | Installed Desktop UI |
| --- | --- | --- | --- |
| Exact installed identity and source | not run | not run | not run |
| Persistent state | not run | not run | not run |
| Inside read/write | not run | not run | not run |
| Real UI glob/grep | not applicable | not run | not run |
| Outside-write control and denial | not run | not run | not run |
| Interrupt and subsequent operation | not run | not run | not run |
| Owned process/port cleanup | not run | not run | not run |
| Reviewed real recording | not run | not run | not run |

For each failure retain only the exact versions, check name, short redacted error, source/provenance, exit code and relevant owned-process outcome. Do not publish full logs or configuration. Keep #84, #86 and #55 open until their own acceptance criteria are met. Public comments, media and PR submissions require review and the project's per-item publication approval.
