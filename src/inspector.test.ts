import { describe, expect, it } from 'vitest'
import { WindowsProcessInspector } from './inspector.ts'

function fakeInspector(lines: string[], execLog: string[][] = []) {
  return new WindowsProcessInspector({
    exec(file, args) {
      execLog.push([file, ...args])
      if (file === 'taskkill') return ''
      return lines.join('\r\n')
    },
  })
}

// pid|ppid|started
const SNAPSHOT = [
  '100|1|111',
  '200|100|222',
  '300|200|333',
  '310|200|334',
  '400|9999|444',
  'garbage line',
  '4|0|0',
]

describe('WindowsProcessInspector', () => {
  it('builds the tree children-first with the root last', () => {
    const tree = fakeInspector(SNAPSHOT).processTree(100)
    expect(tree.map(m => m.pid)).toEqual([300, 310, 200, 100])
    expect(tree.at(-1)).toEqual({ pid: 100, started: '111' })
  })

  it('returns empty when the root is gone', () => {
    expect(fakeInspector(SNAPSHOT).processTree(555)).toEqual([])
  })

  it('survives pid-recycled parent cycles', () => {
    const cyclic = ['100|200|1', '200|100|2']
    expect(fakeInspector(cyclic).processTree(100).map(m => m.pid)).toEqual([200, 100])
  })

  it('isAlive matches pid AND start identity', () => {
    const inspector = fakeInspector(SNAPSHOT)
    expect(inspector.isAlive({ pid: 200, started: '222' })).toBe(true)
    expect(inspector.isAlive({ pid: 200, started: '999' })).toBe(false)
  })

  it('reports no foreground process group', () => {
    const inspector = fakeInspector(SNAPSHOT)
    expect(inspector.foregroundPgid(100)).toBeUndefined()
    expect(inspector.isStdinWaiting(100)).toBe(false)
    expect(inspector.processSession(100)).toEqual([])
  })

  it('signals through taskkill, forcing only SIGKILL', () => {
    const log: string[][] = []
    const inspector = fakeInspector([], log)
    inspector.signalProcess({ pid: 42, started: '1' }, 'SIGTERM')
    inspector.signalProcess({ pid: 42, started: '1' }, 'SIGKILL')
    expect(log).toContainEqual(['taskkill', '/PID', '42'])
    expect(log).toContainEqual(['taskkill', '/PID', '42', '/F'])
  })

  it('swallows taskkill failures on already-exited targets', () => {
    const inspector = new WindowsProcessInspector({
      exec() { throw new Error('not found') },
    })
    expect(() => inspector.signalProcess({ pid: 1, started: '1' }, 'SIGKILL')).not.toThrow()
    expect(inspector.processTree(1)).toEqual([])
    expect(inspector.isAlive({ pid: 1, started: '1' })).toBe(false)
  })
})
