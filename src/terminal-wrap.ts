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

interface TerminalHandleLike {
  readonly pid: number
  write(data: string): Promise<void>
  signalForeground(signal: string): Promise<number>
}

const CONTROL_CHARS: Record<string, string> = {
  SIGINT: '\x03',
  SIGTSTP: '\x1a',
}

/** Wrap a live terminal handle so keyboard-equivalent signals are injected as input. */
export function wrapTerminalHandle<H extends TerminalHandleLike>(handle: H): H {
  return new Proxy(handle, {
    get(target, property) {
      if (property !== 'signalForeground') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (signal: string): Promise<number> => {
        const controlChar = CONTROL_CHARS[signal]
        if (controlChar === undefined) return target.signalForeground(signal)
        await target.write(controlChar)
        // No pgid exists on Windows; the terminal pid is the honest stand-in
        // for "the session that received the keystroke".
        return target.pid
      }
    },
  })
}
