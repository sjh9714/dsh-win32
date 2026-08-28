/**
 * Windows ProcessInspector for the DSH local subprocess runtime.
 *
 * The stock runtime resolves a platform inspector lazily on every PTY spawn
 * and throws on win32, which is why the persistent shell (and with it the
 * Minimal preset) is dead on Windows. This inspector implements the same
 * contract with Windows facilities: process trees and identity via CIM
 * (Win32_Process), signalling via taskkill, foreground resolution via the
 * ConPTY console process list. Sessions and stdin-wait probing have no win32
 * equivalent and degrade honestly (empty and false), which costs the harness
 * only the exact-probe settle path, not the shell itself.
 */

import { execFileSync } from 'node:child_process'
import { queryConsoleProcessList } from './console-list.ts'
import type { ConsoleProcessList } from './console-list.ts'

export interface ProcessIdentity {
  pid: number
  started: string
}

/** OS boundary, injectable for deterministic tests. */
export interface WindowsInspectorInternals {
  exec(file: string, args: string[]): string
  /** Zero-signal liveness probe; throws when the pid does not exist. */
  kill(pid: number, signal: 0): void
  /**
   * Force-terminate one process. Windows has no signals, so this is
   * TerminateProcess and matches `taskkill /F` in effect, at ~0.2ms against
   * ~1300ms for spawning taskkill. It cannot reach a tree, so the `/T` paths
   * still shell out.
   */
  terminate(pid: number): void
  now(): number
  /**
   * Process list of the console `shellPid` owns, plus the pid of the helper
   * that read it. Undefined when the query is unavailable.
   */
  consoleProcessList(shellPid: number): ConsoleProcessList | undefined
}

const DEFAULT_INTERNALS: WindowsInspectorInternals = {
  exec: (file, args) => execFileSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
  kill: (pid, signal) => { process.kill(pid, signal) },
  terminate: pid => { process.kill(pid) },
  now: () => Date.now(),
  consoleProcessList: shellPid => queryConsoleProcessList(shellPid),
}

/**
 * Floor for how long a process-table snapshot stays usable (#8). Terminate polls
 * every 25ms per member, so a short TTL turns N execs per tick into one.
 *
 * A fixed 200ms was self-defeating: the enumeration it caches costs ~1300ms on a
 * busy box, so back-to-back callers always found the entry expired and paid full
 * price every time. `terminate()` alone issued nine, ~12s of a 20s teardown. The
 * TTL therefore also tracks the cost of the last fill, which self-tunes to the
 * machine rather than assuming a number.
 *
 * Widening this does not delay noticing a death. `isAlive` settles the dead case
 * through `kill(pid, 0)` before it ever reads the snapshot, so staleness only
 * affects confirming a pid that is still alive, and the identity check bounds
 * pid reuse to one TTL.
 */
const SNAPSHOT_TTL_FLOOR_MS = 200

// Culture-invariant snapshot: pid, ppid, creation time as FILETIME int64.
const LIST_COMMAND = '$ErrorActionPreference="Stop"; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '
  + '"$($_.ProcessId)|$($_.ParentProcessId)|$(if ($_.CreationDate) { [long]$_.CreationDate.ToFileTime() } else { 0 })" }'

interface ProcessRow extends ProcessIdentity {
  ppid: number
}

/**
 * Per-terminal memory for foreground resolution.
 *
 * The console list answers "attached to this console", not "owns the
 * foreground", and Windows has no query for the latter. A backgrounded job stays
 * attached for its whole life, so a point-in-time read cannot tell it from the
 * command the user is waiting on. The difference only shows over time: a
 * foreground command exits before the shell takes the terminal back, a
 * background job does not.
 */
interface TerminalForegroundState {
  /** Attachments known to be background jobs. */
  resting: Set<number>
  /** Attachments seen on the previous call. */
  previous: Set<number>
  /** Pid last reported as the foreground, if any. */
  reported: number | undefined
}

/** FILETIME ticks exceed Number.MAX_SAFE_INTEGER, so compare them as BigInt. */
function startedAfter(a: string, b: string): boolean {
  try {
    return BigInt(a) > BigInt(b)
  } catch {
    return a > b
  }
}

export class WindowsProcessInspector {
  private cached: { at: number, rows: ProcessRow[], ttl: number } | undefined
  private readonly terminals = new Map<number, TerminalForegroundState>()

  constructor(private readonly internals: WindowsInspectorInternals = DEFAULT_INTERNALS) {}

  private snapshot(): ProcessRow[] {
    const now = this.internals.now()
    if (this.cached !== undefined && now - this.cached.at < this.cached.ttl) return this.cached.rows
    const startedAt = now
    let output: string
    try {
      output = this.internals.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_COMMAND])
    } catch {
      return []
    }
    const rows: ProcessRow[] = []
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split('|')
      if (parts.length !== 3) continue
      const pid = Number(parts[0])
      const ppid = Number(parts[1])
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
      rows.push({ pid, ppid, started: parts[2] })
    }
    // Timed after the fill, so the entry outlives the cost of producing it and a
    // second caller in the same burst is served from memory instead of paying again.
    const filledAt = this.internals.now()
    this.cached = { at: filledAt, rows, ttl: Math.max(SNAPSHOT_TTL_FLOOR_MS, filledAt - startedAt) }
    return rows
  }

  /** Root plus current transitive descendants, children first. */
  processTree(rootPid: number): ProcessIdentity[] {
    if (!(rootPid > 0)) return []
    const rows = this.snapshot()
    const root = rows.find(row => row.pid === rootPid)
    if (root === undefined) return []
    const children = new Map<number, ProcessRow[]>()
    for (const row of rows) {
      const list = children.get(row.ppid)
      if (list === undefined) children.set(row.ppid, [row])
      else list.push(row)
    }
    const ordered: ProcessIdentity[] = []
    const visit = (row: ProcessRow, seen: Set<number>): void => {
      if (seen.has(row.pid)) return
      seen.add(row.pid)
      for (const child of children.get(row.pid) ?? []) {
        // PIDs recycle; a "child" whose pid equals an ancestor's would loop.
        if (child.pid !== row.pid) visit(child, seen)
      }
      ordered.push({ pid: row.pid, started: row.started })
    }
    visit(root, new Set())
    // Parent links alone find nothing below an MSYS shell, because its fork
    // emulation execs through an intermediate that then exits (see
    // console-list.ts). `descendants()` was therefore empty for the whole life
    // of every Git Bash terminal, which made the SIGTERM/SIGKILL sweep in
    // `stopDescendants` a no-op and let a backgrounded job outlive its terminal
    // (#24). Console attachment survives the fork emulation, and for a ConPTY
    // console every attachment belongs to this terminal, so it is the same
    // mapping `foregroundPgid` already relies on. Root stays last: the runtime
    // reads it back for the terminal's own identity.
    const seen = new Set(ordered.map(member => member.pid))
    const attached = this.internals.consoleProcessList(rootPid)
    if (attached === undefined) return ordered
    const extra: ProcessIdentity[] = []
    for (const pid of attached.pids) {
      if (pid === attached.self || seen.has(pid)) continue
      const row = rows.find(candidate => candidate.pid === pid)
      // No row means it exited between the two reads, so there is nothing to
      // signal and no identity to carry.
      if (row !== undefined) extra.push({ pid: row.pid, started: row.started })
    }
    return extra.length === 0 ? ordered : [...extra, ...ordered]
  }

  /** Windows has no POSIX sessions. */
  processSession(_sessionId: number): ProcessIdentity[] {
    return []
  }

  isAlive(identity: ProcessIdentity): boolean {
    if (!(identity.pid > 0)) return false
    // kill(pid, 0) is necessary-but-not-sufficient: it short-circuits only the
    // dead case (~0.002ms vs ~900ms, #8); a live pid still needs the
    // start-identity check against the (TTL-cached) snapshot for pid recycling.
    try {
      this.internals.kill(identity.pid, 0)
    } catch {
      return false
    }
    return this.snapshot().some(row => row.pid === identity.pid && row.started === identity.started)
  }

  /**
   * The command currently running in the terminal, or the shell itself when it
   * is idle. Undefined only when the console cannot be read at all, which keeps
   * the previous degradation as the fallback rather than inventing a pid.
   *
   * Console attachment, not parent links, is the win32 analogue of a foreground
   * process group; see console-list.ts for the MSYS fork-emulation measurement
   * that rules the parent walk out. Returning the shell pid when nothing else
   * is attached is the part terminal-bash actually depends on: it is what
   * distinguishes "the shell is back at its prompt" from "a child printed the
   * PROMPT_COMMAND marker it inherited" (#7).
   */
  foregroundPgid(shellPid: number): number | undefined {
    if (!(shellPid > 0)) return undefined
    const list = this.internals.consoleProcessList(shellPid)
    if (list === undefined) {
      this.forgetTerminal(shellPid)
      return undefined
    }
    const candidates = list.pids.filter(pid => pid !== shellPid && pid !== list.self)
    const attached = new Set(candidates)
    const state = this.terminalState(shellPid)
    const previous = state.previous

    // A resting pid that has exited stops resting. Presence is enough here: the
    // entry is dropped on the first poll after the exit, so the window in which
    // a recycled pid could inherit resting status is one poll interval.
    for (const pid of state.resting) {
      if (!attached.has(pid)) state.resting.delete(pid)
    }

    // Absorption. When the command we last reported as foreground exits, every
    // attachment that coexisted with it was, by definition, running alongside a
    // foreground command, so it is a background job. Restricting this to pids
    // seen in the previous observation keeps a command that started in the same
    // interval from being absorbed with them.
    if (state.reported !== undefined && !attached.has(state.reported)) {
      for (const pid of candidates) {
        if (previous.has(pid)) state.resting.add(pid)
      }
      state.reported = undefined
    }
    state.previous = attached

    const fresh = candidates.filter(pid => !state.resting.has(pid))
    if (fresh.length === 0) {
      // Only background jobs are attached, so the shell owns the terminal.
      state.reported = undefined
      return shellPid
    }
    // Nothing new has attached, so the command already reported stays the answer.
    // The console list outlives process exit by a poll or two while `newestOf`
    // reads a CIM snapshot that does not, so without this the pick falls back to
    // an older attachment (a background job) while the real foreground lingers.
    // That rewrites `reported` and destroys the disappearance absorption needs,
    // which is how a background job stayed "foreground" for a whole session.
    // The guard is conditional on nothing having appeared, or the first job put
    // in the background would be held as the answer forever.
    const appeared = fresh.some(pid => !previous.has(pid))
    if (!appeared && state.reported !== undefined && fresh.includes(state.reported)) {
      return state.reported
    }
    // A pipeline attaches every stage, so there is no single correct answer when
    // collapsing a group onto one pid. The most recently started attachment is
    // the closest stand-in for "what is running now".
    const pick = fresh.length === 1 ? fresh[0]! : (this.newestOf(fresh) ?? fresh[0]!)
    state.reported = pick
    return pick
  }

  private terminalState(shellPid: number): TerminalForegroundState {
    let state = this.terminals.get(shellPid)
    if (state === undefined) {
      state = { resting: new Set(), previous: new Set(), reported: undefined }
      this.terminals.set(shellPid, state)
    }
    return state
  }

  /** Drop per-terminal state once its console can no longer be read. */
  private forgetTerminal(shellPid: number): void {
    this.terminals.delete(shellPid)
  }

  /** Most recently started of `pids`, by start identity. Undefined if none are known. */
  private newestOf(pids: number[]): number | undefined {
    const rows = this.snapshot()
    let newest: ProcessRow | undefined
    for (const pid of pids) {
      const row = rows.find(candidate => candidate.pid === pid)
      if (row === undefined) continue
      if (newest === undefined || startedAfter(row.started, newest.started)) newest = row
    }
    return newest?.pid
  }

  /**
   * Windows exposes no reliable "this process is blocked on a console read"
   * probe. Reporting false keeps terminal-bash's exact-probe settle path
   * unreachable, which is the safe direction: claiming a wait that is not
   * happening would settle a still-running command.
   */
  isStdinWaiting(_pgid: number): boolean {
    return false
  }

  /**
   * Run a taskkill, escalating to `/F` when the graceful form is refused and the
   * target is still there (#24).
   *
   * Without `/F`, taskkill asks a window to close. A console process has none,
   * so the call fails with exit 128 and the process keeps running. Every MSYS
   * command is a console process, which made `SIGTERM` a no-op that the catch
   * below then read as "already gone".
   *
   * The liveness re-check is what keeps the graceful attempt meaningful: a
   * target that exited on its own during the attempt is never force-killed, and
   * only one that refused is. Nothing graceful is being given up, because the
   * graceful form cannot work here at all; the choice is a forced kill or no
   * kill.
   */
  private taskkill(args: string[], pid: number): void {
    if (!(pid > 0)) return
    try {
      this.internals.exec('taskkill', args)
      return
    } catch {
      // Exit 128 is "could not terminate", not "already exited". Tell them apart
      // by asking whether the pid is still there.
    }
    if (args.includes('/F')) return
    try {
      this.internals.kill(pid, 0)
    } catch {
      return // Gone on its own, which is the success the old catch assumed.
    }
    // A `/T` target needs taskkill again for the tree; a single pid does not.
    if (!args.includes('/T')) {
      this.forceTerminate(pid)
      return
    }
    try {
      this.internals.exec('taskkill', [...args, '/F'])
    } catch {
      // Nothing further to try; a survivor is reported by the caller's own sweep.
    }
  }

  signalProcess(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!(identity.pid > 0)) return
    // No tree to walk for a single pid, so the forceful form is TerminateProcess
    // rather than a taskkill spawn. Teardown signals every member twice, and
    // spawning taskkill costs ~1300ms on a busy box even for a pid that does not
    // exist, so this is most of what a sweep used to pay.
    if (signal === 'SIGKILL') {
      this.forceTerminate(identity.pid)
      return
    }
    this.taskkill(['/PID', String(identity.pid)], identity.pid)
  }

  /** TerminateProcess, treating an already-exited target as the success it is. */
  private forceTerminate(pid: number): void {
    if (!(pid > 0)) return
    try {
      this.internals.terminate(pid)
    } catch {
      // Gone before we got there.
    }
  }

  /**
   * Reachable since foregroundPgid resolves: this is how SIGTERM/SIGKILL against
   * a foreground command land. `/T` covers the command's own descendants, which
   * is the closest Windows has to signalling a process group.
   */
  signalGroup(pgid: number, signal: { toString(): string }): void {
    if (!(pgid > 0)) return
    const force = String(signal) === 'SIGKILL' ? ['/F'] : []
    for (const target of this.groupMembers(pgid)) {
      this.taskkill(['/PID', String(target), '/T', ...force], target)
    }
  }

  /**
   * Every stage of the job `pgid` was resolved from, or just `pgid` itself.
   *
   * A pipeline attaches each stage to the console and `foregroundPgid` has to
   * collapse them onto one pid, so `/T` on that pid reaches its own tree and
   * leaves the siblings running until the pipe breaks (#11). The set is resolved
   * again here rather than carried over from the earlier call, so a job that
   * changed in between yields a stale-but-fresh read instead of a stale captured
   * one. The race is real and accepted: if the terminal moved on, `pgid` is no
   * longer among the live candidates and only it is signalled, which is exactly
   * the old behaviour.
   */
  private groupMembers(pgid: number): number[] {
    for (const [shellPid, state] of this.terminals) {
      if (state.reported !== pgid) continue
      const list = this.internals.consoleProcessList(shellPid)
      if (list === undefined) break
      const live = list.pids.filter(
        pid => pid !== shellPid && pid !== list.self && !state.resting.has(pid),
      )
      // Background jobs are excluded by `resting`, so this cannot widen into
      // work the user did not ask to cancel.
      if (live.includes(pgid)) return live
      break
    }
    return [pgid]
  }
}
