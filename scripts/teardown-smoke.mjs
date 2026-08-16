/**
 * Teardown cost guard.
 *
 * `stopShell` calls `kill('SIGTERM')` then `kill('SIGKILL')`, and node-pty
 * rejects a signal argument on Windows. Both throws are swallowed, so before
 * the kill patch neither phase did anything and both grace windows expired in
 * full before the tree-kill fallback finished the job. Measured at ~20s for an
 * idle terminal with no descendants, against ~1.6s once the signal argument is
 * dropped and the snapshot TTL outlives its own fill cost.
 *
 * The budget is two grace windows, because that is the exact signature of the
 * bug: an unsignalled shell waits out both before the fallback runs, so any
 * regression lands above it and nothing correct lands near it. It is a guard,
 * not a benchmark, and it is deliberately not tightened to the current numbers.
 *
 * Those numbers moved once #24 gave `descendants()` real members. Teardown now
 * kills what it finds instead of sweeping an empty list, and the graceful
 * taskkill it tries first costs ~1300ms of spawn overhead per member on this
 * box. Measured here: ~3.2s idle, ~4.7s with one background job, against ~1.6s
 * when the sweep had nothing to do and ~20s before #23.
 *
 * Run after `npm run build`: node scripts/teardown-smoke.mjs
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Context } from '@deepseek-ai/cordis'
import WindowsSubprocessRuntime from '../lib/index.js'

const GRACE_MS = 3000
// Both windows expiring is the failure being guarded against, so the budget sits
// at exactly that. Real teardown work stays well under it.
const BUDGET_MS = GRACE_MS * 2

function findBash() {
  if (process.env.SMOKE_BASH !== undefined) return process.env.SMOKE_BASH
  if (process.platform !== 'win32') return '/bin/bash'
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (root === undefined) continue
    const candidate = join(root, 'Git', 'usr', 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('Git Bash not found; set SMOKE_BASH')
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function measure(label, setup) {
  const ctx = new Context()
  await ctx.plugin(WindowsSubprocessRuntime)
  const handle = await ctx.subprocess.spawnTerminal({
    argv: [findBash(), '--noprofile', '--norc', '-i'],
    cwd: process.cwd(),
    rows: 24,
    cols: 80,
    graceMs: GRACE_MS,
  })
  handle.output.on('data', () => {})
  await delay(1500)
  if (setup !== undefined) {
    await handle.write(setup)
    await delay(1500)
  }
  const startedAt = Date.now()
  let failure
  try {
    await handle.terminate()
  } catch (error) {
    failure = error.message
  }
  const elapsed = Date.now() - startedAt
  await ctx.fiber.dispose()
  console.log(`  ${label}: ${elapsed}ms${failure === undefined ? '' : ` (terminate threw: ${failure})`}`)
  return { elapsed, failure }
}

const idle = await measure('idle terminal', undefined)
const withJob = await measure('with a background job', 'sleep 300 &\n')

const problems = []
for (const [name, result] of [['idle', idle], ['background job', withJob]]) {
  if (result.failure !== undefined) problems.push(`${name} terminate threw: ${result.failure}`)
  if (result.elapsed > BUDGET_MS) {
    problems.push(`${name} teardown took ${result.elapsed}ms, over the ${BUDGET_MS}ms budget,`
      + ' which is what an unsignalled shell waiting out both grace windows looks like')
  }
}

if (problems.length > 0) {
  console.error(`FAIL:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`ok: teardown stays under both ${GRACE_MS}ms grace windows, so the shell is really being signalled`)
process.exit(0)
