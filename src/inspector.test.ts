import { describe, expect, it } from 'vitest'
import { WindowsProcessInspector } from './inspector.ts'

function fakeInspector(lines: string[], execLog: string[][] = [], options: { deadPids?: number[], clock?: { t: number } } = {}) {
  const clock = options.clock ?? { t: 0 }
  return new WindowsProcessInspector({
    exec(file, args) {
      execLog.push([file, ...args])
      if (file === 'taskkill') return ''
      return lines.join('\r\n')
    },
    kill(pid) {
      if ((options.deadPids ?? []).includes(pid)) throw new Error('ESRCH')
    },
    now: () => (clock.t += 300),
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

  it('caches the snapshot within the TTL (one exec per tick, #8)', () => {
    const log: string[][] = []
    const clock = { t: 0 }
    const inspector = new WindowsProcessInspector({
      exec(file, args) { log.push([file, ...args]); return SNAPSHOT.join('\r\n') },
      kill() {},
      now: () => clock.t,
    })
    inspector.isAlive({ pid: 200, started: '222' })
    inspector.isAlive({ pid: 300, started: '333' })
    inspector.processTree(100)
    expect(log.length).toBe(1)
    clock.t += 1000
    inspector.processTree(100)
    expect(log.length).toBe(2)
  })

  it('short-circuits isAlive for dead pids without any exec (#8)', () => {
    const log: string[][] = []
    const inspector = fakeInspector(SNAPSHOT, log, { deadPids: [200] })
    expect(inspector.isAlive({ pid: 200, started: '222' })).toBe(false)
    expect(log.length).toBe(0)
  })

  it('swallows taskkill failures on already-exited targets', () => {
    const inspector = new WindowsProcessInspector({
      exec() { throw new Error('not found') },
      kill() {},
      now: () => Date.now(),
    })
    expect(() => inspector.signalProcess({ pid: 1, started: '1' }, 'SIGKILL')).not.toThrow()
    expect(inspector.processTree(1)).toEqual([])
    expect(inspector.isAlive({ pid: 1, started: '1' })).toBe(false)
  })
})
