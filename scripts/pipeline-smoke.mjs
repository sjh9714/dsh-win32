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

function stagePids() {
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

const ctx = new Context()
await ctx.plugin(WindowsSubprocessRuntime)
const before = stagePids()
const handle = await ctx.subprocess.spawnTerminal({
  argv: [findBash(), '--noprofile', '--norc', '-i'],
  cwd: process.cwd(),
  rows: 24,
  cols: 80,
  graceMs: 3000,
})
handle.output.on('data', () => {})
await delay(1500)

await handle.write('sleep 90 | cat | cat\n')
await delay(2500)
const started = [...stagePids()].filter(pid => !before.has(pid))
console.log(`  pipeline stages running: ${started.length} (${started.join(', ')})`)

await handle.signalForeground('SIGTERM')
await delay(2500)
const survivors = started.filter(pid => stagePids().has(pid))
console.log(`  still running after SIGTERM: ${survivors.length}${survivors.length > 0 ? ` (${survivors.join(', ')})` : ''}`)

try {
  await handle.terminate()
} catch (error) {
  console.log(`  terminate: ${error.message}`)
}
await ctx.fiber.dispose()
for (const pid of stagePids()) {
  if (!started.includes(pid)) continue
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
