# Core adoption notes: win32 ProcessInspector

Everything the core team needs to absorb the Windows process inspector, in one page. Written for deepseek-ai/deepseek-harness maintainers, discussion at [deepseek-harness#1889](https://github.com/deepseek-ai/deepseek-harness/discussions/1889).

## What it closes

`createProcessInspector` throws on win32 before `nodePty.spawn` is reached (`packages/subprocess/subprocess-local/src/process-inspector.ts`), which kills every PTY spawn and with it the minimal preset's persistent shell. Marked in your own architecture notes as a deferred follow-up. Together with the `shellPath` resolution fix staged in #1856, this is the remaining half.

## Files to take

| File | What it is | LOC |
|---|---|---|
| [`src/inspector.ts`](../src/inspector.ts) | `WindowsProcessInspector` implementing the `ProcessInspector` contract | ~130 |
| [`src/terminal-wrap.ts`](../src/terminal-wrap.ts) | Ctrl-C injection for `signalForeground` (keyboard-equivalent signals as PTY input, the ConPTY convention) | ~50 |
| [`src/inspector.test.ts`](../src/inspector.test.ts), [`src/terminal-wrap.test.ts`](../src/terminal-wrap.test.ts) | Unit specs (injectable OS boundary, no mocking framework) | ~120 |

Zero runtime dependencies beyond `node:child_process`. No koffi, no native code. The OS boundary is a small injectable (`exec`, `kill`, `now`), same shape as your `ProcessInspectorInternals`.

## Contract mapping

| `ProcessInspector` member | win32 implementation | Semantics |
|---|---|---|
| `processTree(rootPid)` | one CIM snapshot (`Get-CimInstance Win32_Process`, pid/ppid/CreationDate as FILETIME identity), children-first order, pid-recycle cycle guard | full fidelity |
| `isAlive(identity)` | snapshot lookup, pid AND start-identity match | full fidelity |
| `signalProcess(identity, sig)` | `taskkill /PID` (`/F` for SIGKILL), exited targets are success | full fidelity for kill sweeps |
| `signalGroup(pgid, sig)` | `taskkill /PID <pgid> /T` defensively | unreachable in practice (see next row) |
| `foregroundPgid(shellPid)` | returns `undefined` | honest degradation, no process groups on Windows |
| `isStdinWaiting(pgid)` | returns `false` | honest degradation |
| `processSession(sessionId)` | returns `[]` | honest degradation, no POSIX sessions |

The degradations are not free (credit [#7](https://github.com/sjh9714/dsh-win32/issues/7)). With `foregroundPgid` undefined, terminal-bash's readiness check loses its shell-vs-child discriminator (`undefined === undefined` passes silently), leaving prompt markers and silence as the only completion signals. A real win32 mapping exists, ConPTY's console process list (`getConsoleProcessList`, already bound in node-pty, ~81ms measured via a helper process), and it is the tracked follow-up. Mid-command cancel (the SIGINT path in `terminal-bash`'s `interruptOnce`) is restored by `terminal-wrap.ts`. SIGINT/SIGTSTP are delivered as `\x03`/`\x1a` PTY input, which MSYS bash and busybox ash forward to the foreground job. SIGTERM/SIGKILL against a foreground process keep the stock throwing behavior rather than pretending delivery.

## Evidence (all public, all reproducible)

- windows-latest CI on every push. Persistent state across writes (`STATE=x` then `echo $STATE`), interrupt of `sleep 60` observed as exit 130. [Workflow](../.github/workflows/ci.yml), any recent run.
- Real model session: variable and cwd survive between two bash tool calls (`persist:win42:...`).
- The full sandbox chain (`terminal-bash` confine, then the ACL runner, then the restricted token). busybox-w32 ash completes a send/read round-trip inside the WRITE_RESTRICTED token, and MSYS bash reproduces the known `cygheap TokenDefaultDacl 0xC0000022` startup death on the same path. One command reproduces it, `SANDBOX_MODE=workspace-write node scripts/sandbox-smoke.mjs` (busybox variant shown in the `busybox-sandboxed` CI job). Note your win32 CI currently excludes `terminal-bash` and `sandbox-local`, so this smoke is, as far as we know, the only exercise of that path on Windows.
- Independent third-party verification on real Windows hardware: [#1889 discussion](https://github.com/deepseek-ai/deepseek-harness/discussions/1889) (clone, rebuild, 17/17 tests).

## Suggested placement

Minimal-diff shape: a `Win32ProcessInspector` next to the Linux/Mac ones and one added branch in `createProcessInspector`. `terminal-wrap`'s behavior belongs in `LocalTerminalHandle.signalForeground` as a win32 branch (deliver control characters via `write` instead of resolving a pgid). The minimal preset then needs its win32 rows (`shellPath` per #1856).

## Known limits worth carrying over

- CIM snapshot costs one `powershell.exe` invocation (~900ms on a busy box). As of v0.6.0 the snapshot is TTL-cached (200ms) and `isAlive` short-circuits dead pids via `kill(pid, 0)`, so terminate's 25ms poll loop no longer burns its grace period on measurement ([#8](https://github.com/sjh9714/dsh-win32/issues/8)).
- Directly-spawned console apps can survive a ConPTY kill on Windows, so a `taskkill /T /F` fallback after a failed `terminate()` is advisable (we ship this as of v0.5).

## License

MIT. Relicense, reshape, split, or rewrite freely; attribution appreciated but not required. Happy to adjust tests or structure to your conventions on request.
