/**
 * Native Windows regression for #78. PowerShell duplicates its pipe handles
 * into a surviving process; a Node stdio:'inherit' child is not equivalent.
 * Prove the old unbounded wait hangs before exercising the real override.
 * Run after build: node scripts/pipe-drain-smoke.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import WindowsSubprocessRuntime from '../lib/index.js'
import { collectStream } from '../lib/shell-decode.js'

if (process.platform !== 'win32') {
  console.log('skip: inherited native Windows pipe handles require Windows')
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-win32-pipe-drain-'))
const previousDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(scratch, 'home')
const graceMs = 1000
const encoded = text => Buffer.from(text, 'utf16le').toString('base64')
const holderCode = encoded("[Console]::Out.WriteLine('holder-ready'); Start-Sleep -Seconds 60")
const parentCode = encoded(`
$ErrorActionPreference = 'Stop'
$holder = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @(
  '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', '${holderCode}'
) -NoNewWindow -PassThru
[Console]::Out.WriteLine('holder=' + $holder.Id)
[Console]::Error.WriteLine('stderr-tail')
`)

async function within(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function run(control) {
  const ctx = new Context()
  let handle
  let reader
  let holderPid
  const rawStreams = []
  const started = Date.now()
  try {
    await ctx.plugin(control ? LocalSubprocessRuntime : WindowsSubprocessRuntime)
    ctx.subprocess.internals = { ...ctx.subprocess.internals, spillDir: join(scratch, 'spill') }
    handle = ctx.subprocess.spawn({
      argv: ['pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', parentCode],
      cwd: scratch,
      graceMs,
      stdio: {
        stdin: 'ignore',
        stdout: control ? 'pipe' : { maxBytes: 65536 },
        stderr: control ? 'pipe' : { maxBytes: 65536 },
      },
    })
    let done = handle.done
    let drains
    if (control) {
      rawStreams.push(handle.stdout, handle.stderr)
      const stdout = collectStream(handle.stdout, 65536)
      const stderr = collectStream(handle.stderr, 65536)
      reader = stdout.reader
      drains = Promise.all([stdout.done, stderr.done])
      // The pre-fix wrapper's exact unbounded wait, against real raw pipes.
      done = handle.done.then(async outcome => { await drains; return outcome })
    } else {
      reader = handle.collected.stdout
    }
    // Observe failures immediately even while waiting for fixture startup.
    let settled = false
    let failed
    void done.then(() => { settled = true }, error => { failed = error })
    const until = Date.now() + 15000
    while (Date.now() < until) {
      if (failed) throw failed
      const output = reader.readFrom(0).text
      const match = output.match(/holder=(\d+)/)
      if (match) holderPid = Number(match[1])
      if (holderPid && output.includes('holder-ready')) break
      await delay(25)
    }
    assert.ok(Number.isSafeInteger(holderPid) && holderPid > 0, 'fixture did not report its holder PID')
    assert.ok(reader.readFrom(0).text.includes('holder-ready'), 'holder did not start')
    assert.ok(alive(holderPid), 'fixture holder exited too soon')

    if (control) {
      assert.equal((await within(handle.done, 10000, 'parent outcome')).exitCode, 0)
      await delay(graceMs * 2)
      assert.equal(alive(handle.pid), false, 'parent must have exited')
      assert.equal(settled, false, 'negative control did not reproduce the held pipe')
      assert.ok(rawStreams.every(stream => !stream.destroyed && !stream.readableEnded))
      assert.ok(alive(holderPid), 'holder must remain alive during the unbounded wait')
      console.log('ok: old drain wait remains pending after parent exit while the native holder is alive')
    } else {
      assert.deepEqual(await within(done, 10000, 'bounded outcome'), { exitCode: 0, signal: null })
      assert.equal(alive(handle.pid), false, 'parent must have exited')
      assert.ok(alive(holderPid), 'completion must not depend on killing the holder')
      assert.ok(handle.collected.stdout.readFrom(0).text.includes('holder-ready'))
      assert.ok(handle.collected.stderr.readFrom(0).text.includes('stderr-tail'))
      assert.equal(handle.stdout, undefined)
      assert.equal(handle.stderr, undefined)
      console.log(`ok: fixed runtime completed in ${Date.now() - started} ms with both tails retained and holder still alive`)
    }
  } finally {
    // Only this fixture's own recorded process and temporary tree are ours.
    const match = reader?.readFrom(0).text.match(/holder=(\d+)/)
    holderPid ??= match ? Number(match[1]) : undefined
    handle?.terminate()
    if (holderPid && alive(holderPid)) {
      execFileSync('taskkill', ['/PID', String(holderPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      const until = Date.now() + 5000
      while (alive(holderPid) && Date.now() < until) await delay(25)
      assert.equal(alive(holderPid), false, 'fixture holder survived cleanup')
    }
    for (const stream of rawStreams) stream.destroy()
    await within(ctx.fiber.dispose(), 10000, 'context cleanup')
  }
}

try {
  await run(true)
  await run(false)
  console.log('ok: all fixture processes cleaned up; no real DSH profile was used')
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(scratch, { recursive: true, force: true })
}
