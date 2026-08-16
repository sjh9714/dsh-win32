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
 * An absolute budget of two grace windows was the wrong instrument (#26). What
 * teardown actually costs is CIM enumerations and taskkill spawns, and that does
 * not scale with `graceMs` at all — sweeping it 500/1500/3000/6000 moved elapsed
 * by nothing (idle ~2.8-3.4s, background job ~6.0-6.5s at every value). So the
 * budget tracked a quantity teardown does not consume, and only sat near the real
 * cost at the one value hardcoded here. On real hardware it went four-for-nine.
 *
 * The signal is differential instead. An unsignalled shell waits out both windows,
 * so its elapsed grows by ~2x any increase in `graceMs`; a signalled one does not
 * move. Measured, background job, three reps: current build 6218ms at 500 and
 * 5958ms at 3000, delta -260ms. Same build with `terminal.kill` restored to
 * node-pty's stock behaviour, which is the bug #23 fixed: 9491ms and 14526ms,
 * delta +5035ms against a predicted 2 * 2500 = 5000ms. Nothing lands between
 * those, and a slow box moves both terms together, which is the whole point.
 *
 * The absolute ceiling stays as a separate check, set generously. It is there to
 * catch a hang, not to grade performance, so it must not be tightened to the
 * current numbers.
 *
 * Run after `npm run build`: node scripts/teardown-smoke.mjs
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Context } from '@deepseek-ai/cordis'
import WindowsSubprocessRuntime from '../lib/index.js'

// The two grace values the differential is taken across. Their gap is also the
// threshold: an unsignalled shell gains ~2x the gap, a signalled one gains ~0.
const SHORT_GRACE_MS = 500
const LONG_GRACE_MS = 3000
const GRACE_GAP_MS = LONG_GRACE_MS - SHORT_GRACE_MS
// A hang catcher, not a performance grade. Well above the ~6.5s this costs on a
// loaded workstation and above the ~14.5s the unsignalled build reaches, so it
// fires for something stuck rather than something slow.
const CEILING_MS = 30_000

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

async function measure(label, setup, graceMs) {
  const ctx = new Context()
  await ctx.plugin(WindowsSubprocessRuntime)
  const handle = await ctx.subprocess.spawnTerminal({
    argv: [findBash(), '--noprofile', '--norc', '-i'],
    cwd: process.cwd(),
    rows: 24,
    cols: 80,
    graceMs,
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

const idle = await measure('idle terminal', undefined, LONG_GRACE_MS)
// The differential runs on the background-job case: it has a descendant, so it
// exercises the sweep as well as the shell kill, and it is the case measured in
// #26. Same setup either side, only graceMs differs.
const shortGrace = await measure(`background job, ${SHORT_GRACE_MS}ms grace`, 'sleep 300 &\n', SHORT_GRACE_MS)
const longGrace = await measure(`background job, ${LONG_GRACE_MS}ms grace`, 'sleep 300 &\n', LONG_GRACE_MS)

const problems = []
for (const [name, result] of [['idle', idle], ['short grace', shortGrace], ['long grace', longGrace]]) {
  if (result.failure !== undefined) problems.push(`${name} terminate threw: ${result.failure}`)
  if (result.elapsed > CEILING_MS) {
    problems.push(`${name} teardown took ${result.elapsed}ms, over the ${CEILING_MS}ms ceiling,`
      + ' which is a hang rather than a slow box')
  }
}

const delta = longGrace.elapsed - shortGrace.elapsed
console.log(`  grace differential: ${delta}ms (threshold ${GRACE_GAP_MS}ms)`)
if (delta > GRACE_GAP_MS) {
  problems.push(`teardown grew ${delta}ms for a ${GRACE_GAP_MS}ms increase in graceMs, so it is waiting the`
    + ' windows out rather than being signalled; an unsignalled shell gains about twice the increase')
}

if (problems.length > 0) {
  console.error(`FAIL:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log('ok: teardown does not scale with graceMs, so the shell is really being signalled')
process.exit(0)
