import { describe, expect, it } from 'vitest'
import { toPortableEval, wrapTerminalHandle } from './terminal-wrap.ts'

function fakeHandle() {
  const writes: string[] = []
  const signals: string[] = []
  return {
    writes,
    signals,
    pid: 777,
    async write(data: string) { writes.push(data) },
    async signalForeground(signal: string): Promise<number> {
      signals.push(signal)
      throw new Error('cannot resolve foreground process group')
    },
    async terminate() {},
  }
}

describe('wrapTerminalHandle', () => {
  it('injects Ctrl-C for SIGINT and reports the terminal pid', async () => {
    const inner = fakeHandle()
    const wrapped = wrapTerminalHandle(inner)
    await expect(wrapped.signalForeground('SIGINT')).resolves.toBe(777)
    expect(inner.writes).toEqual(['\x03'])
    expect(inner.signals).toEqual([])
  })

  it('injects Ctrl-Z for SIGTSTP', async () => {
    const inner = fakeHandle()
    await wrapTerminalHandle(inner).signalForeground('SIGTSTP')
    expect(inner.writes).toEqual(['\x1a'])
  })

  it('keeps the honest throwing path for non-keyboard signals', async () => {
    const inner = fakeHandle()
    await expect(wrapTerminalHandle(inner).signalForeground('SIGKILL')).rejects.toThrow('foreground')
    expect(inner.signals).toEqual(['SIGKILL'])
    expect(inner.writes).toEqual([])
  })

  it('falls back to a tree kill when terminate fails, then retries', async () => {
    const killed: number[] = []
    let attempts = 0
    const inner = {
      ...fakeHandle(),
      async terminate() {
        attempts += 1
        if (attempts === 1) throw new Error('terminal cleanup failed; surviving pid: 777')
      },
    }
    await wrapTerminalHandle(inner, pid => killed.push(pid)).terminate()
    expect(killed).toEqual([777])
    expect(attempts).toBe(2)
  })

  it('rethrows the original error when the retry also fails', async () => {
    const inner = {
      ...fakeHandle(),
      async terminate() { throw new Error('original failure') },
    }
    await expect(wrapTerminalHandle(inner, () => {}).terminate()).rejects.toThrow('original failure')
  })

  it('delegates every other member to the inner handle', async () => {
    const inner = fakeHandle()
    const wrapped = wrapTerminalHandle(inner)
    expect(wrapped.pid).toBe(777)
    await wrapped.write('ls\n')
    expect(inner.writes).toEqual(['ls\n'])
  })
})

describe('toPortableEval', () => {
  // Replicated from dsh-tool-bash-persistent so the fixture is the string that
  // actually reaches the PTY. 0.8.1 anchored on a hand-written plain-quote
  // wrapper, which matched nothing in production and shipped the rewrite
  // disabled while this suite stayed green.
  const quoteForBash = (value: string) =>
    `$'${value
      .replaceAll('\\', '\\\\')
      .replaceAll("'", "\\'")
      .replaceAll('\r', '\\r')
      .replaceAll('\n', '\\n')}'`
  const wrap = (command: string) =>
    `printf '%s\\n' ${quoteForBash('S1')}; eval -- ${quoteForBash(command)};`
    + ` __dsh_persistent_bash_status=$?; printf '%s%s\\n' ${quoteForBash('E1')}`
    + ` "$__dsh_persistent_bash_status"`

  it('replaces the bashism with the portable leading-space form', () => {
    expect(toPortableEval(wrap('echo ok'))).toBe(
      `printf '%s\\n' $'S1'; eval $' echo ok';`
      + ` __dsh_persistent_bash_status=$?; printf '%s%s\\n' $'E1'`
      + ` "$__dsh_persistent_bash_status"`,
    )
  })

  it('anchors on the ANSI-C quoting the core emits, not on plain quotes', () => {
    // The regression that shipped in 0.8.1. The wrapper carries a `$` between
    // the separator and the quote, so a plain-quote anchor never fires and the
    // sandboxed preset keeps dying with `eval: --: not found`.
    const wrapped = wrap('MARK=box7')
    expect(wrapped).toContain("; eval -- $'")
    expect(toPortableEval(wrapped)).not.toBe(wrapped)
    expect(toPortableEval(wrapped)).not.toContain('eval -- ')
  })

  it('rewrites only the wrapper, never a match inside the command', () => {
    // quoteForBash escapes every quote, so the command's own copy of the
    // wrapper text arrives escaped and cannot be mistaken for the real one.
    const rewritten = toPortableEval(wrap(`echo "; eval -- $'x"`))
    expect(rewritten.match(/; eval \$' /g)).toHaveLength(1)
  })

  it('leaves anything that is not the wrapper alone', () => {
    const notWrappers = [
      '\x03',
      'echo hello\n',
      "eval -- $'bare'",
      `printf '%s\\n' $'S1'; eval -- $'no tail'`,
    ]
    for (const data of notWrappers) expect(toPortableEval(data)).toBe(data)
  })
})
