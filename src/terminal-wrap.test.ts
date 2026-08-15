import { describe, expect, it } from 'vitest'
import { wrapTerminalHandle } from './terminal-wrap.ts'

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

  it('delegates every other member to the inner handle', async () => {
    const inner = fakeHandle()
    const wrapped = wrapTerminalHandle(inner)
    expect(wrapped.pid).toBe(777)
    await wrapped.write('ls\n')
    expect(inner.writes).toEqual(['ls\n'])
  })
})
