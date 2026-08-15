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
 * SIGINT and SIGTSTP map to control characters. SIGTERM/SIGKILL/SIGHUP have
 * no keyboard equivalent and keep the stock (throwing) behavior rather than
 * pretending a delivery happened.
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
