/**
 * ConPTY console process list, the win32 stand-in for a foreground process group.
 *
 * Parent links cannot answer "what is running in this terminal" on Windows.
 * MSYS and Cygwin emulate fork() by spawning an intermediate process that execs
 * and exits, which severs the chain. A Git Bash PTY running `sleep 20` reports
 * no direct children at all, while the console list still shows the sleep:
 *
 *   console list for shell 43168  ->  {"pids":[57944,66288,43168],"self":57944}
 *   Win32_Process ParentProcessId=43168  ->  (nothing)
 *
 * Console attachment is a property of the console rather than of the process
 * tree, so it survives the fork emulation.
 *
 * GetConsoleProcessList has to run in a separate process, because a process can
 * be attached to only one console at a time and the host is attached to its own.
 * node-pty already ships the binding, so a one-shot helper script is enough.
 * Measured at ~81ms including the child spawn, against ~904ms for a full CIM
 * enumeration.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** A console's process list, plus the pid of the helper that read it. */
export interface ConsoleProcessList {
  pids: number[]
  /** The helper attaches to the console to query it, so it appears in `pids`. */
  self: number
}

/** Undefined until first resolved; `{ path: undefined }` records a known miss. */
let helperState: { path: string | undefined } | undefined

function nodePtyUtils(): string | undefined {
  const here = createRequire(import.meta.url)
  const bases = [here]
  try {
    // node-pty is subprocess-local's own dependency, so resolving through it
    // also covers profiles where this package does not depend on node-pty.
    bases.push(createRequire(here.resolve('@deepseek-ai/dsh-subprocess-local/package.json')))
  } catch {
    // Not installed beside us. The direct base may still resolve.
  }
  for (const base of bases) {
    try {
      const utils = join(dirname(base.resolve('node-pty/package.json')), 'lib', 'utils.js')
      if (existsSync(utils)) return utils
    } catch {
      continue
    }
  }
  return undefined
}

function helperScript(): string | undefined {
  if (helperState !== undefined) return helperState.path
  const utils = nodePtyUtils()
  if (utils === undefined) {
    helperState = { path: undefined }
    return undefined
  }
  try {
    const path = join(tmpdir(), 'dsh-win32-console-list.cjs')
    writeFileSync(path, [
      `const { loadNativeModule } = require(${JSON.stringify(utils)})`,
      `const list = loadNativeModule('conpty_console_list').module.getConsoleProcessList`,
      `const pids = list(parseInt(process.argv[2], 10))`,
      // The helper reports its own pid so the caller can drop it. It is in the
      // list only because it had to attach to answer the question.
      `process.stdout.write(JSON.stringify({ pids, self: process.pid }))`,
    ].join('\n'))
    helperState = { path }
    return path
  } catch {
    helperState = { path: undefined }
    return undefined
  }
}

/** Parse the helper's stdout. Exported for tests; tolerates any malformed shape. */
export function parseConsoleProcessList(raw: string): ConsoleProcessList | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { pids, self } = parsed as { pids?: unknown, self?: unknown }
  if (!Array.isArray(pids) || typeof self !== 'number') return undefined
  return { pids: pids.filter((pid): pid is number => Number.isSafeInteger(pid)), self }
}

/**
 * Read the process list of the console `shellPid` owns. Undefined when node-pty
 * is unreachable, the helper cannot be written, or the console is already gone.
 * A shell that has exited makes AttachConsole fail, which is an ordinary race
 * rather than an error, so the caller degrades instead of throwing.
 */
export function queryConsoleProcessList(shellPid: number, timeoutMs = 5_000): ConsoleProcessList | undefined {
  const helper = helperScript()
  if (helper === undefined) return undefined
  try {
    return parseConsoleProcessList(execFileSync(process.execPath, [helper, String(shellPid)], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
  } catch {
    return undefined
  }
}
