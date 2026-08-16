import { describe, expect, it } from 'vitest'
import { WindowsProcessInspector } from './inspector.ts'
import type { ConsoleProcessList } from './console-list.ts'

interface FakeOptions {
  deadPids?: number[]
  clock?: { t: number }
  /** Omitted means the console query is unavailable, the degraded case. */
  console?: ConsoleProcessList
  consoleLog?: number[]
}

function fakeInspector(lines: string[], execLog: string[][] = [], options: FakeOptions = {}) {
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
    consoleProcessList(shellPid) {
      options.consoleLog?.push(shellPid)
      return options.console
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

  it('keeps the honest degradations that have no win32 mapping', () => {
    const inspector = fakeInspector(SNAPSHOT)
    expect(inspector.isStdinWaiting(100)).toBe(false)
    expect(inspector.processSession(100)).toEqual([])
  })

  describe('foregroundPgid via the console list (#7)', () => {
    it('returns the shell itself when only the shell and helper are attached', () => {
      // What terminal-bash needs to see "the shell is back at its prompt".
      const inspector = fakeInspector(SNAPSHOT, [], { console: { pids: [100, 9001], self: 9001 } })
      expect(inspector.foregroundPgid(100)).toBe(100)
    })

    it('returns the attached command when one is running', () => {
      const inspector = fakeInspector(SNAPSHOT, [], { console: { pids: [9001, 200, 100], self: 9001 } })
      expect(inspector.foregroundPgid(100)).toBe(200)
    })

    it('degrades to undefined when the console cannot be read', () => {
      // Shell already exited, node-pty missing, helper unwritable. Never guess.
      expect(fakeInspector(SNAPSHOT).foregroundPgid(100)).toBeUndefined()
    })

    it('queries the console of the shell it was asked about', () => {
      const consoleLog: number[] = []
      fakeInspector(SNAPSHOT, [], { console: { pids: [100], self: 9001 }, consoleLog }).foregroundPgid(100)
      expect(consoleLog).toEqual([100])
    })

    it('picks the most recently started stage of a pipeline', () => {
      // 300 started at 333, 310 at 334; both are attached to the same console.
      const inspector = fakeInspector(SNAPSHOT, [], { console: { pids: [9001, 300, 310, 100], self: 9001 } })
      expect(inspector.foregroundPgid(100)).toBe(310)
    })

    it('compares FILETIME start identities beyond Number precision', () => {
      // These two collapse to the same double; only BigInt tells them apart.
      const rows = ['100|1|1', '500|100|133700000000000001', '600|100|133700000000000002']
      const inspector = fakeInspector(rows, [], { console: { pids: [9001, 500, 600, 100], self: 9001 } })
      expect(inspector.foregroundPgid(100)).toBe(600)
    })

    it('falls back to a candidate the snapshot does not know', () => {
      const inspector = fakeInspector(SNAPSHOT, [], { console: { pids: [9001, 7001, 7002, 100], self: 9001 } })
      expect([7001, 7002]).toContain(inspector.foregroundPgid(100))
    })

    it('costs no snapshot exec in the single-candidate case', () => {
      const log: string[][] = []
      fakeInspector(SNAPSHOT, log, { console: { pids: [9001, 200, 100], self: 9001 } }).foregroundPgid(100)
      expect(log).toEqual([])
    })
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
