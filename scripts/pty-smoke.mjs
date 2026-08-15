/**
 * End-to-end proof for the flagship claim: with the dsh-windows runtime
 * loaded, a persistent bash PTY spawns and keeps state across writes on
 * this machine — including win32, where the stock runtime throws before
 * node-pty is even reached.
 *
 * Run after `npm run build`: node scripts/pty-smoke.mjs
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Context } from '@deepseek-ai/cordis'
import WindowsSubprocessRuntime from '../lib/index.js'

function findBash() {
  if (process.env.SMOKE_BASH !== undefined) return process.env.SMOKE_BASH
  if (process.platform !== 'win32') return '/bin/bash'
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (root === undefined) continue
    const candidate = join(root, 'Git', 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('Git Bash not found; set SMOKE_BASH')
}

const MARKER = `smoke-${process.pid}`
const ctx = new Context()
await ctx.plugin(WindowsSubprocessRuntime)

const handle = await ctx.subprocess.spawnTerminal({
  argv: [findBash(), '--noprofile', '--norc', '-i'],
  cwd: process.cwd(),
  rows: 24,
  cols: 80,
  graceMs: 3000,
})
console.log(`pty spawned on ${process.platform}: pid ${handle.pid}`)

let collected = ''
handle.output.on('data', chunk => { collected += String(chunk) })

// Two separate writes: the echo only prints the marker if $STATE survived
// from the first one, which is exactly the persistence the stock runtime
// cannot offer on win32.
await handle.write(`STATE=${MARKER}\n`)
await handle.write('cd /tmp && echo "proof:$STATE:$(pwd)"\n')

const deadline = Date.now() + 30000
const expected = `proof:${MARKER}:/tmp`
while (Date.now() < deadline && !collected.includes(expected)) {
  await new Promise(resolve => setTimeout(resolve, 200))
}

await handle.terminate()
await ctx.fiber.dispose()

if (!collected.includes(expected)) {
  console.error(`FAIL: marker ${JSON.stringify(expected)} not seen in PTY output`)
  console.error(collected.slice(-2000))
  process.exit(1)
}
console.log(`ok: persistent state survived across writes (${expected})`)
// ConPTY handles keep the event loop alive after dispose on win32; exit explicitly.
process.exit(0)
