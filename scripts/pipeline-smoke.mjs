/**
 * Pipeline signalling proof (#24, #11).
 *
 * `SIGTERM` used to reach nothing at all here. `signalGroup` ran taskkill
 * without `/F`, which a console process refuses (exit 128), and the failure was
 * read as "already gone", so all three stages of `sleep | cat | cat` survived a
 * cancel. With escalation on refusal, the resolved stage and its tree go.
 *
 * Run after `npm run build`: node scripts/pipeline-smoke.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Context } from '@deepseek-ai/cordis'
import { queryConsoleProcessList } from '../lib/console-list.js'
import WindowsSubprocessRuntime from '../lib/index.js'

if (process.platform !== 'win32') {
  console.log('ok: skipped, the taskkill escalation this proves is win32 only')
  process.exit(0)
}

function findBash() {
  if (process.env.SMOKE_BASH !== undefined) return process.env.SMOKE_BASH
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (root === undefined) continue
    const candidate = join(root, 'Git', 'usr', 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('Git Bash not found; set SMOKE_BASH')
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function namedPids() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Property ProcessId,Name'
      + ' | Where-Object { $_.Name -in @("sleep.exe","cat.exe") } | ForEach-Object { $_.ProcessId }'],
    { encoding: 'utf8', windowsHide: true })
    return new Set(out.split(/\r?\n/).map(line => Number(line.trim())).filter(Number.isSafeInteger))
  } catch {
    return new Set()
  }
}

/**
 * The pipeline's stages, and only those.
 *
 * A machine-wide name filter is not an identity. Any `sleep` or `cat` anywhere on
 * the box lands in it, so a background job that starts inside the 2.5s window is
 * counted as a stage and one that outlives the SIGTERM is reported as a survivor.
 * Measured on a workstation with unrelated poll loops running: stage counts of 3,
 * 4, 5 and 7 for the same three-stage pipeline, with false survivors each time,
 * against a clean 3 and 0 on an idle box. That is the #27 shape — a fixture whose
 * relationship to the thing under test is accidental — and it reports the failure
 * this smoke exists to catch when nothing is wrong.
 *
 * The console is the terminal's identity, so intersecting with its process list
 * scopes the filter to this terminal. Returns undefined when the console cannot
 * be read, which the caller treats as "cannot attribute" rather than "none".
 */
function stagePids(shellPid) {
  const attached = queryConsoleProcessList(shellPid)
  if (attached === undefined) return undefined
  const onConsole = new Set(attached.pids)
  return new Set([...namedPids()].filter(pid => onConsole.has(pid)))
}

function requireStages(shellPid, when) {
  const pids = stagePids(shellPid)
  if (pids === undefined) {
    console.error(`FAIL:\n  the console probe could not read the terminal's process list ${when},`
      + ' so stages cannot be attributed to this pipeline')
    process.exit(1)
  }
  return pids
}

const ctx = new Context()
await ctx.plugin(WindowsSubprocessRuntime)
const handle = await ctx.subprocess.spawnTerminal({
  argv: [findBash(), '--noprofile', '--norc', '-i'],
  cwd: process.cwd(),
  rows: 24,
  cols: 80,
  graceMs: 3000,
})
handle.output.on('data', () => {})
await delay(1500)
// Nothing of ours is on this console yet; anything here is the shell's own doing.
const before = requireStages(handle.pid, 'before the pipeline started')

await handle.write('sleep 90 | cat | cat\n')
await delay(2500)
const started = [...requireStages(handle.pid, 'after the pipeline started')].filter(pid => !before.has(pid))
console.log(`  pipeline stages running: ${started.length} (${started.join(', ')})`)

await handle.signalForeground('SIGTERM')
await delay(2500)
const alive = requireStages(handle.pid, 'after SIGTERM')
const survivors = started.filter(pid => alive.has(pid))
console.log(`  still running after SIGTERM: ${survivors.length}${survivors.length > 0 ? ` (${survivors.join(', ')})` : ''}`)

try {
  await handle.terminate()
} catch (error) {
  console.log(`  terminate: ${error.message}`)
}
await ctx.fiber.dispose()
// The console is gone with the shell, so sweep the pids we recorded rather than
// re-reading it. Already-dead pids make taskkill fail, which is the normal case.
for (const pid of started) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* gone */ }
}

if (started.length < 3) {
  console.error(`FAIL: expected three stages, saw ${started.length}; the repro did not set up`)
  process.exit(1)
}
if (survivors.length > 0) {
  console.error(`FAIL: ${survivors.length} of ${started.length} stages survived SIGTERM`)
  process.exit(1)
}
console.log('ok: SIGTERM cleared every stage of the pipeline')
process.exit(0)
