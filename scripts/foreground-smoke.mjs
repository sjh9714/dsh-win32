/**
 * End-to-end proof for foregroundPgid (#7): the harness can tell "the shell is
 * back at its prompt" from "a command is running", on the real OS.
 *
 * This is the discriminator terminal-bash's readiness check lost while
 * foregroundPgid returned undefined, where `foreground?.processGroupId ===
 * this.shellPgid` compared undefined to undefined and passed silently.
 *
 * Also prints the parent-walk comparison, which is why the console list is the
 * mapping and a ppid walk is not: MSYS fork emulation leaves a running
 * foreground command with no live parent chain to the shell.
 *
 * Run after `npm run build`: node scripts/foreground-smoke.mjs
 */

import { execFileSync } from 'node:child_process'
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
    const candidate = join(root, 'Git', 'usr', 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('Git Bash not found; set SMOKE_BASH')
}

function directChildren(pid) {
  if (process.platform !== 'win32') return '(win32 only)'
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }`],
    { encoding: 'utf8', windowsHide: true })
    return out.trim() === '' ? '(none)' : out.trim().split(/\r?\n/).join(', ')
  } catch {
    return '(query failed)'
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const ctx = new Context()
await ctx.plugin(WindowsSubprocessRuntime)

const handle = await ctx.subprocess.spawnTerminal({
  argv: [findBash(), '--noprofile', '--norc', '-i'],
  cwd: process.cwd(),
  rows: 24,
  cols: 80,
  graceMs: 3000,
})
console.log(`pty spawned on ${process.platform}: shell pid ${handle.pid}`)
await delay(1500)

const idle = await handle.inspectForeground()
const idleIsShell = idle !== undefined && idle.processGroupId === handle.pid

await handle.write('sleep 30\n')
await delay(1500)
const busy = await handle.inspectForeground()
const busyIsCommand = busy !== undefined && busy.processGroupId !== handle.pid

console.log(`  idle foreground        : ${idle?.processGroupId} (shell is ${handle.pid})`)
console.log(`  foreground while busy  : ${busy?.processGroupId}`)
console.log(`  shell's direct children: ${directChildren(handle.pid)}  <- the parent walk`)

await handle.signalForeground('SIGINT')
await delay(1500)
const after = await handle.inspectForeground()
const backToShell = after !== undefined && after.processGroupId === handle.pid

await handle.terminate()
await ctx.fiber.dispose()

if (!idleIsShell || !busyIsCommand || !backToShell) {
  console.error(`FAIL: idleIsShell=${idleIsShell} busyIsCommand=${busyIsCommand} backToShell=${backToShell}`)
  process.exit(1)
}
console.log('ok: idle resolves to the shell itself')
console.log('ok: a running command resolves to the command, not the shell')
console.log('ok: the shell is foreground again after the interrupt')
// ConPTY handles keep the event loop alive after dispose on win32; exit explicitly.
process.exit(0)
