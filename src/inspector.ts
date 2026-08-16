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
  now: () => Date.now(),
  consoleProcessList: shellPid => queryConsoleProcessList(shellPid),
}

/** One CIM enumeration costs ~900ms on a busy box (#8); terminate polls every
 * 25ms per member. A short TTL turns N-per-tick execs into at most one, and
 * staleness only errs safe (a just-exited pid costs one extra tick). */
const SNAPSHOT_TTL_MS = 200

// Culture-invariant snapshot: pid, ppid, creation time as FILETIME int64.
const LIST_COMMAND = '$ErrorActionPreference="Stop"; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '
  + '"$($_.ProcessId)|$($_.ParentProcessId)|$(if ($_.CreationDate) { [long]$_.CreationDate.ToFileTime() } else { 0 })" }'

interface ProcessRow extends ProcessIdentity {
  ppid: number
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
  private cached: { at: number, rows: ProcessRow[] } | undefined

  constructor(private readonly internals: WindowsInspectorInternals = DEFAULT_INTERNALS) {}

  private snapshot(): ProcessRow[] {
    const now = this.internals.now()
    if (this.cached !== undefined && now - this.cached.at < SNAPSHOT_TTL_MS) return this.cached.rows
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
    this.cached = { at: now, rows }
    return rows
  }

  /** Root plus current transitive descendants, children first. */
  processTree(rootPid: number): ProcessIdentity[] {
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
    return ordered
  }

  /** Windows has no POSIX sessions. */
  processSession(_sessionId: number): ProcessIdentity[] {
    return []
  }

  isAlive(identity: ProcessIdentity): boolean {
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
    const list = this.internals.consoleProcessList(shellPid)
    if (list === undefined) return undefined
    const candidates = list.pids.filter(pid => pid !== shellPid && pid !== list.self)
    if (candidates.length === 0) return shellPid
    if (candidates.length === 1) return candidates[0]
    // A pipeline attaches every stage to the console, so there is no single
    // correct answer when collapsing a group onto one pid. The most recently
    // started attachment is the closest stand-in for "what is running now".
    return this.newestOf(candidates) ?? candidates[0]
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

  signalProcess(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL'): void {
    const args = signal === 'SIGKILL'
      ? ['/PID', String(identity.pid), '/F']
      : ['/PID', String(identity.pid)]
    try {
      this.internals.exec('taskkill', args)
    } catch {
      // Already-exited targets are a success for a kill sweep.
    }
  }

  /**
   * Reachable since foregroundPgid resolves: this is how SIGTERM/SIGKILL against
   * a foreground command land. `/T` covers the command's own descendants, which
   * is the closest Windows has to signalling a process group.
   */
  signalGroup(pgid: number, signal: { toString(): string }): void {
    const force = String(signal) === 'SIGKILL' ? ['/F'] : []
    try {
      this.internals.exec('taskkill', ['/PID', String(pgid), '/T', ...force])
    } catch {
      // Same as signalProcess: absence is success.
    }
  }
}
