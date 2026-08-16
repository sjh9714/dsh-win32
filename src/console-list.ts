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

/** OS boundary for the probe, injectable so the degradation paths are testable. */
export interface ConsoleProbeInternals {
  /** Path to the one-shot helper, or undefined when it cannot be prepared. */
  helper(): string | undefined
  /** Run the helper against `shellPid`, returning its stdout. Throws on failure. */
  run(helper: string, shellPid: number, timeoutMs: number): string
}

/**
 * Undefined until first resolved; a `path: undefined` entry records a known
 * miss along with why, since that miss is permanent and worth saying once.
 */
let helperState: { path: string | undefined, reason?: string } | undefined

/**
 * Where the two "the probe has gone permanently quiet" warnings go.
 *
 * Both are one-shot. A resolution miss is cached forever by design, and a probe
 * failure recurs on every call, so a terminal polling every 50ms would turn one
 * broken install into a flood, and a flood gets filtered, which puts us back at
 * silence. One line per process is what makes it readable.
 */
let warn: ((message: string) => void) | undefined
let reportedUnavailable = false
let reportedFailing = false
let consecutiveFailures = 0

/**
 * When the probe cannot answer, `processTree` falls back to the stock parent
 * walk and `signalGroup` to `[pgid]` — which on MSYS means no descendants and
 * no fan-out, so #7, #11 and #24 all come back at once and look like a
 * regression here rather than a moved file in node-pty. Nothing else says so,
 * because degrading quietly is the correct behaviour for the ordinary race of
 * probing a shell that is on its way out.
 *
 * Wiring a sink resets the latches, so a second plugin instance reports again.
 */
export function setConsoleProbeWarn(sink: ((message: string) => void) | undefined): void {
  warn = sink
  reportedUnavailable = false
  reportedFailing = false
  consecutiveFailures = 0
}

/**
 * A run of failures with no success between them. One failure is ordinary (the
 * shell exited mid-probe); a run of them is an install that will never answer.
 */
const FAILURE_RUN_BEFORE_WARNING = 3

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
    helperState = { path: undefined, reason: "node-pty's conpty_console_list helper could not be located" }
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
  } catch (error) {
    helperState = { path: undefined, reason: `the console-list helper could not be written (${errorText(error)})` }
    return undefined
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
export function queryConsoleProcessList(
  shellPid: number,
  timeoutMs = 5_000,
  internals: ConsoleProbeInternals = DEFAULT_PROBE_INTERNALS,
): ConsoleProcessList | undefined {
  const helper = internals.helper()
  if (helper === undefined) {
    if (!reportedUnavailable) {
      reportedUnavailable = true
      warn?.(`dsh-win32: ${helperState?.reason ?? 'the console probe is unavailable'};`
        + ' terminal descendants and signal fan-out fall back to parent links, which MSYS severs')
    }
    return undefined
  }
  let parsed: ConsoleProcessList | undefined
  let detail = 'the helper returned output this build cannot read'
  try {
    parsed = parseConsoleProcessList(internals.run(helper, shellPid, timeoutMs))
  } catch (error) {
    detail = errorText(error)
  }
  if (parsed !== undefined) {
    consecutiveFailures = 0
    return parsed
  }
  // One failure is the ordinary race of probing a shell that is already gone,
  // which this function is documented to swallow. A run of them with no success
  // between is an install that will never answer, and that is worth one line.
  consecutiveFailures += 1
  if (consecutiveFailures >= FAILURE_RUN_BEFORE_WARNING && !reportedFailing) {
    reportedFailing = true
    warn?.(`dsh-win32: the console probe has failed ${consecutiveFailures} times in a row (${detail});`
      + ' terminal descendants and signal fan-out fall back to parent links, which MSYS severs')
  }
  return undefined
}

const DEFAULT_PROBE_INTERNALS: ConsoleProbeInternals = {
  helper: helperScript,
  run: (helper, shellPid, timeoutMs) => execFileSync(process.execPath, [helper, String(shellPid)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
}
