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
    terminate(pid) { execLog.push(['terminate', String(pid)]) },
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
  it.each([0, -1])('rejects non-positive pid %i before touching Windows process APIs', pid => {
    const inspector = new WindowsProcessInspector({
      exec() { throw new Error('must not execute') },
      kill() { throw new Error('must not probe') },
      terminate() { throw new Error('must not terminate') },
      now() { throw new Error('must not read the clock') },
      consoleProcessList() { throw new Error('must not inspect a console') },
    })

    expect(inspector.processTree(pid)).toEqual([])
    expect(inspector.isAlive({ pid, started: '0' })).toBe(false)
    expect(inspector.foregroundPgid(pid)).toBeUndefined()
    expect(() => inspector.signalProcess({ pid, started: '0' }, 'SIGTERM')).not.toThrow()
    expect(() => inspector.signalProcess({ pid, started: '0' }, 'SIGKILL')).not.toThrow()
    expect(() => inspector.signalGroup(pid, 'SIGKILL')).not.toThrow()
  })

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


  describe('descendants and SIGTERM on win32 (#24)', () => {
    function inspectorWith(
      console: ConsoleProcessList | undefined,
      execLog: string[][] = [],
      deadPids: number[] = [],
    ) {
      return new WindowsProcessInspector({
        exec(file, args) {
          execLog.push([file, ...args])
          if (file !== 'taskkill') return SNAPSHOT.join('\r\n')
          // Without /F, taskkill asks a window to close. Console processes have
          // none, so the real thing exits 128 and leaves the target running.
          if (!args.includes('/F')) throw new Error('exit 128: could not be terminated')
          return ''
        },
        kill(pid) { if (deadPids.includes(pid)) throw new Error('ESRCH') },
        terminate(pid) { execLog.push(['terminate', String(pid)]) },
        now: () => 0,
        consoleProcessList: () => console,
      })
    }

    it('adds console attachments the parent walk cannot reach', () => {
      // MSYS severs the chain, so 400 has no path to root 100 through ppid.
      const tree = inspectorWith({ pids: [100, 400, 9001], self: 9001 }).processTree(100)
      expect(tree.map(m => m.pid)).toEqual([400, 300, 310, 200, 100])
      expect(tree.at(-1)).toEqual({ pid: 100, started: '111' })
    })

    it('never double-counts a pid the parent walk already found', () => {
      const tree = inspectorWith({ pids: [100, 200, 300, 9001], self: 9001 }).processTree(100)
      expect(tree.map(m => m.pid)).toEqual([300, 310, 200, 100])
    })

    it('skips the helper and anything gone from the snapshot', () => {
      const tree = inspectorWith({ pids: [100, 9001, 55555], self: 9001 }).processTree(100)
      expect(tree.map(m => m.pid)).toEqual([300, 310, 200, 100])
    })

    it('keeps the stock tree when the console cannot be read', () => {
      const tree = inspectorWith(undefined).processTree(100)
      expect(tree.map(m => m.pid)).toEqual([300, 310, 200, 100])
    })

    it('escalates SIGTERM to /F when the graceful form is refused', () => {
      const log: string[][] = []
      inspectorWith(undefined, log).signalProcess({ pid: 42, started: '1' }, 'SIGTERM')
      expect(log).toEqual([['taskkill', '/PID', '42'], ['terminate', '42']])
    })

    it('does not force-kill a target that exited during the graceful attempt', () => {
      const log: string[][] = []
      inspectorWith(undefined, log, [42]).signalProcess({ pid: 42, started: '1' }, 'SIGTERM')
      expect(log).toEqual([['taskkill', '/PID', '42']])
    })

    it('escalates the group form too, which is what a pipeline needs', () => {
      const log: string[][] = []
      inspectorWith(undefined, log).signalGroup(42, 'SIGTERM')
      expect(log).toEqual([['taskkill', '/PID', '42', '/T'], ['taskkill', '/PID', '42', '/T', '/F']])
    })

    it('uses TerminateProcess for SIGKILL instead of spawning taskkill', () => {
      const log: string[][] = []
      inspectorWith(undefined, log).signalProcess({ pid: 42, started: '1' }, 'SIGKILL')
      expect(log).toEqual([['terminate', '42']])
    })
  })

  describe('background jobs stay attached, so foreground is resolved over time (#11)', () => {
    /** Drive the inspector through a scripted sequence of console readings. */
    function sequence(readings: number[][]) {
      let index = 0
      const inspector = new WindowsProcessInspector({
        exec: () => SNAPSHOT.join('\r\n'),
        kill: () => {},
        terminate: () => {},
        now: () => 0,
        consoleProcessList: () => ({ pids: [...readings[Math.min(index, readings.length - 1)]!, 100], self: 9001 }),
      })
      return () => {
        const value = inspector.foregroundPgid(100)
        index += 1
        return value
      }
    }

    it('reports the shell once a foreground command has come and gone beside a background job', () => {
      // 200 is backgrounded first, then 300 runs in the foreground and exits.
      const next = sequence([
        [],           // idle
        [200],        // `sleep &` job appears; indistinguishable at this instant
        [200, 300],   // a foreground command starts
        [200, 300],   // still running
        [200],        // it exits, and 200 is exposed as the background job
        [200],        // stays exposed
      ])
      expect(next()).toBe(100)
      expect(next()).toBe(200)
      expect(next()).toBe(300)
      expect(next()).toBe(300)
      expect(next()).toBe(100)
      expect(next()).toBe(100)
    })

    it('does not let a stale console entry hand the foreground back to a background job', () => {
      // The console list outlives exit, and the CIM snapshot does not know 310,
      // so an unguarded newest-of pick would fall back to 200 mid-command.
      const next = sequence([
        [],
        [200],
        [200, 310],
        [200, 310],
        [200, 310],
      ])
      next()
      next()
      expect(next()).toBe(310)
      expect(next()).toBe(310)
      expect(next()).toBe(310)
    })

    it('keeps resolving later foreground commands once a job is known to be resting', () => {
      const next = sequence([
        [], [200], [200, 300], [200], [200, 310], [200], [200],
      ])
      next(); next(); next()
      expect(next()).toBe(100)
      expect(next()).toBe(310)
      expect(next()).toBe(100)
      expect(next()).toBe(100)
    })

    it('drops a resting job from memory when it exits', () => {
      const next = sequence([
        [], [200], [200, 300], [200], [], [300],
      ])
      next(); next(); next(); next()
      expect(next()).toBe(100)
      // 300 reappearing is a new command, not the resting entry it once was.
      expect(next()).toBe(300)
    })

    it('forgets per-terminal state when the console can no longer be read', () => {
      let list: ConsoleProcessList | undefined = { pids: [100, 200, 9001], self: 9001 }
      const inspector = new WindowsProcessInspector({
        exec: () => SNAPSHOT.join('\r\n'),
        kill: () => {},
        terminate: () => {},
        now: () => 0,
        consoleProcessList: () => list,
      })
      inspector.foregroundPgid(100)
      list = undefined
      expect(inspector.foregroundPgid(100)).toBeUndefined()
      list = { pids: [100, 200, 9001], self: 9001 }
      // State was dropped with the terminal, so 200 is a fresh command again.
      expect(inspector.foregroundPgid(100)).toBe(200)
    })
  })

  it('asks taskkill for the graceful form and TerminateProcess for the forceful one', () => {
    // A single pid has no tree to walk, so the forceful path does not pay the
    // ~1300ms taskkill spawn (#24). The graceful form has no native equivalent.
    const log: string[][] = []
    const inspector = fakeInspector([], log)
    inspector.signalProcess({ pid: 42, started: '1' }, 'SIGTERM')
    inspector.signalProcess({ pid: 42, started: '1' }, 'SIGKILL')
    expect(log).toContainEqual(['taskkill', '/PID', '42'])
    expect(log).toContainEqual(['terminate', '42'])
  })

  it('caches the snapshot within the TTL (one exec per tick, #8)', () => {
    const log: string[][] = []
    const clock = { t: 0 }
    const inspector = new WindowsProcessInspector({
      exec(file, args) { log.push([file, ...args]); return SNAPSHOT.join('\r\n') },
      kill() {},
      terminate() {},
      now: () => clock.t,
      consoleProcessList: () => undefined,
    })
    inspector.isAlive({ pid: 200, started: '222' })
    inspector.isAlive({ pid: 300, started: '333' })
    inspector.processTree(100)
    expect(log.length).toBe(1)
    clock.t += 1000
    inspector.processTree(100)
    expect(log.length).toBe(2)
  })


  it('keeps a snapshot at least as long as the fill cost, so a burst pays once', () => {
    // A fixed TTL shorter than the enumeration it caches expires before the next
    // caller arrives, which is how terminate paid for nine of them (#8 follow-up).
    const log: string[][] = []
    let clock = 0
    const inspector = new WindowsProcessInspector({
      exec(file, args) { log.push([file, ...args]); clock += 1300; return SNAPSHOT.join('\r\n') },
      kill() {},
      terminate() {},
      now: () => clock,
      consoleProcessList: () => undefined,
    })
    inspector.processTree(100)
    expect(log.length).toBe(1)
    clock += 900
    inspector.processTree(100)
    expect(log.length, 'still inside the measured fill cost').toBe(1)
    clock += 500
    inspector.processTree(100)
    expect(log.length, 'past it, so a fresh read').toBe(2)
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
      terminate() {},
      now: () => Date.now(),
    })
    expect(() => inspector.signalProcess({ pid: 1, started: '1' }, 'SIGKILL')).not.toThrow()
    expect(inspector.processTree(1)).toEqual([])
    expect(inspector.isAlive({ pid: 1, started: '1' })).toBe(false)
  })
})
