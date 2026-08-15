/**
 * Windows ProcessInspector for the DSH local subprocess runtime.
 *
 * The stock runtime resolves a platform inspector lazily on every PTY spawn
 * and throws on win32, which is why the persistent shell (and with it the
 * Minimal preset) is dead on Windows. This inspector implements the same
 * contract with Windows facilities: process trees and identity via CIM
 * (Win32_Process), signalling via taskkill. POSIX-only concepts (foreground
 * process groups, sessions, stdin-wait probing) degrade gracefully: the
 * harness then reports no foreground process, which only disables foreground
 * inspection niceties, not the shell itself.
 */

import { execFileSync } from 'node:child_process'

export interface ProcessIdentity {
  pid: number
  started: string
}

/** OS boundary, injectable for deterministic tests. */
export interface WindowsInspectorInternals {
  exec(file: string, args: string[]): string
}

const DEFAULT_INTERNALS: WindowsInspectorInternals = {
  exec: (file, args) => execFileSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
}

// Culture-invariant snapshot: pid, ppid, creation time as FILETIME int64.
const LIST_COMMAND = '$ErrorActionPreference="Stop"; Get-CimInstance Win32_Process | ForEach-Object { '
  + '"$($_.ProcessId)|$($_.ParentProcessId)|$(if ($_.CreationDate) { [long]$_.CreationDate.ToFileTime() } else { 0 })" }'

interface ProcessRow extends ProcessIdentity {
  ppid: number
}

export class WindowsProcessInspector {
  constructor(private readonly internals: WindowsInspectorInternals = DEFAULT_INTERNALS) {}

  private snapshot(): ProcessRow[] {
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
    return this.snapshot().some(row => row.pid === identity.pid && row.started === identity.started)
  }

  /** No foreground process-group concept on Windows; report none. */
  foregroundPgid(_shellPid: number): number | undefined {
    return undefined
  }

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

  /** Unreachable in practice (foregroundPgid is always undefined); tree-kill defensively. */
  signalGroup(pgid: number, signal: { toString(): string }): void {
    const force = String(signal) === 'SIGKILL' ? ['/F'] : []
    try {
      this.internals.exec('taskkill', ['/PID', String(pgid), '/T', ...force])
    } catch {
      // Same as signalProcess: absence is success.
    }
  }
}
