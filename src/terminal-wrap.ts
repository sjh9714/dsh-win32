/**
 * Windows terminal-handle wrapper: foreground signalling via control-character
 * injection.
 *
 * POSIX resolves the PTY's foreground process group and signals it directly.
 * Windows has no process groups, so the stock `signalForeground` path throws,
 * which turns a mid-command cancel (the harness sends SIGINT) into a transport
 * failure. ConPTY's own convention is the answer. writing the control
 * character into the PTY input makes the shell deliver the interrupt to
 * whatever is running, exactly like a user pressing Ctrl-C. Git Bash (MSYS)
 * forwards ^C as SIGINT to its foreground job.
 *
 * SIGINT and SIGTSTP map to control characters. SIGTERM/SIGKILL/SIGHUP have no
 * keyboard equivalent and stay on the stock path, which since the console-list
 * inspector resolves a real foreground now tree-kills that command rather than
 * throwing "cannot resolve foreground process group".
 */

import { spawnSync } from 'node:child_process'

interface TerminalHandleLike {
  readonly pid: number
  write(data: string): Promise<void>
  signalForeground(signal: string): Promise<number>
  terminate(): Promise<void>
}

const CONTROL_CHARS: Record<string, string> = {
  SIGINT: '\x03',
  SIGTSTP: '\x1a',
}

function taskkillTree(pid: number): void {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

/**
 * `dsh-tool-bash-persistent` wraps every command as
 *
 *   printf '%s\n' $'START'; eval -- $'CMD'; __dsh_persistent_bash_status=$?; ...
 *
 * and `eval --` is a bashism. POSIX shells do not accept `--` for the `eval`
 * special builtin, so busybox ash reads `--` as the command name and every
 * command in the sandboxed preset dies with `eval: --: not found` (exit 127).
 * Measured on busybox-w32 v1.38 by a user (#12) and reproduced here on dash,
 * which rules out a busybox quirk. `eval` cannot be shadowed either, since a
 * special builtin's name is rejected as a function name ("Bad function name").
 *
 * A single leading space inside the quoted word does the same job as `--`
 * portably. The argument no longer begins with `-`, so it never enters option
 * parsing, and leading whitespace is nothing to shell parsing. Measured on
 * both shells, `eval ' -n hi'` behaves exactly like bash's `eval -- '-n hi'`,
 * so this is safe to apply on the Git Bash preset too.
 *
 * The command is quoted with ANSI-C syntax, so the wrapper reads `eval -- $'…'`
 * and not `eval -- '…'`. Anchoring on the plain-quote form matched nothing in
 * production and shipped 0.8.1 with the rewrite disabled, so the `$` is load
 * bearing. The test fixture is built from the core's own quoting for the same
 * reason, since a hand-written wrapper can drift from what actually ships.
 *
 * Reported upstream at deepseek-harness#2271. This rewrite goes away when the
 * fix lands there.
 */
const WRAPPED_EVAL = "; eval -- $'"

export function toPortableEval(data: string): string {
  // Anchored on both ends of the known wrapper. A command that merely contains
  // the same text is left alone, and a chunked write simply does not match.
  if (!data.startsWith("printf '%s\\n' ") || !data.includes(WRAPPED_EVAL)) return data
  if (!data.trimEnd().endsWith('"$__dsh_persistent_bash_status"')) return data
  const at = data.indexOf(WRAPPED_EVAL)
  return `${data.slice(0, at)}; eval $' ${data.slice(at + WRAPPED_EVAL.length)}`
}

/** Marks an IPty whose kill has already been made signal-tolerant. */
const KILL_PATCHED = Symbol.for('dsh-win32.killPatched')

interface KillableTerminal {
  kill?: (signal?: string) => void
  [KILL_PATCHED]?: boolean
}

/**
 * Make the pty's `kill` tolerate a signal argument.
 *
 * node-pty throws `Signals not supported on windows.` when `kill` is given one,
 * and `stopShell` calls it exactly that way:
 *
 *   try { this.terminal.kill('SIGTERM') } catch { }   // swallowed
 *   await Promise.race([this.done, delay(this.graceMs)])
 *   try { this.terminal.kill('SIGKILL') } catch { }   // swallowed
 *   await Promise.race([this.done, delay(this.graceMs)])
 *
 * Both throws are caught as "the exit callback is authoritative", so nothing
 * ever signals the shell and both grace windows expire in full. Measured here,
 * that is 6s of a ~10s teardown of an idle terminal with no descendants, after
 * which `stopShell` throws and the tree-kill fallback below does the actual
 * work. `kill()` with no argument does terminate the shell, so dropping the
 * argument restores the intent of both phases.
 */
export function patchTerminalKill(handle: unknown): boolean {
  // `terminal` is internal to the stock handle rather than part of its public
  // type, so this is a structural reach and reports false if the shape moves.
  const terminal = (handle as { terminal?: KillableTerminal } | undefined)?.terminal
  if (terminal === undefined || typeof terminal.kill !== 'function') return false
  if (terminal[KILL_PATCHED] === true) return true
  const original = terminal.kill.bind(terminal)
  terminal.kill = function killIgnoringSignal(): void { original() }
  terminal[KILL_PATCHED] = true
  return true
}

/**
 * Wrap a live terminal handle: keyboard-equivalent signals are injected as
 * input, and a failed terminate falls back to a forced tree kill. Directly
 * spawned console apps (busybox ash observed on CI) can survive a ConPTY
 * kill, leaving `terminate()` to throw "terminal cleanup failed; surviving
 * pid" — taskkill /T /F is the reliable Windows fallback, then one retry.
 */
export function wrapTerminalHandle<H extends TerminalHandleLike>(handle: H, killTree: (pid: number) => void = taskkillTree): H {
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'signalForeground') {
        return async (signal: string): Promise<number> => {
          const controlChar = CONTROL_CHARS[signal]
          if (controlChar === undefined) return target.signalForeground(signal)
          await target.write(controlChar)
          // No pgid exists on Windows; the terminal pid is the honest stand-in
          // for "the session that received the keystroke".
          return target.pid
        }
      }
      if (property === 'write') {
        return (data: string): Promise<void> => target.write(toPortableEval(data))
      }
      if (property === 'terminate') {
        return async (): Promise<void> => {
          try {
            await target.terminate()
          } catch (error) {
            killTree(target.pid)
            try {
              await target.terminate()
            } catch {
              throw error
            }
          }
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
