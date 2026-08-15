/**
 * Sandboxed persistent-shell proof: spawns the PTY through the REAL sandbox
 * chain (terminal-bash confines the argv via ctx.sandbox before the spawn),
 * exactly like a workspace-write session does. This is the path no Windows
 * machine has ever exercised: core CI excludes both terminal-bash and
 * sandbox-local on win32.
 *
 * SANDBOX_MODE=danger-full-access|workspace-write (default workspace-write)
 * Run after `npm run build`: node scripts/sandbox-smoke.mjs
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import { TerminalSessionService } from '@deepseek-ai/dsh-terminal'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'
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

function stubAgent(ctx, rawId) {
  const id = SessionId(rawId)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id)
  return {
    id, options: {}, session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

const MODE = process.env.SANDBOX_MODE ?? 'workspace-write'
// Workspace root must be caller-owned and disjoint from os.tmpdir().
const root = mkdtempSync(join(process.cwd(), '.sandbox-ws-'))

const ctx = new Context()
await ctx.plugin(AgentRegistry)
await ctx.plugin(TerminalSessionService)
await ctx.plugin(LocalSandboxProvider)
await ctx.plugin(SandboxPolicyService, { mode: MODE, workspaceRoot: root })
await ctx.plugin(WindowsSubprocessRuntime)
await ctx.plugin(terminalBash, {
  shellPath: findBash(),
  shellArgs: ['--noprofile', '--norc', '-i'],
  pollIntervalMs: 50,
  exactProbeAfterMs: 100,
  idleSilenceMs: 500,
  handoffGraceMs: 500,
  timeoutMs: 30_000,
  disposeGraceMs: 2_000,
  scrollbackLines: 500,
  scrollbackMaxBytes: 65_536,
  maxReadBytes: 32_768,
})

const agent = stubAgent(ctx, `sandbox-smoke-${MODE}`)
ctx.agents.register(agent)

let exitCode = 1
try {
  const spawned = await ctx.terminals.spawn(agent, { type: 'shell', name: 'main', cwd: root })
  console.log(`sandboxed pty spawned on ${process.platform} (mode=${MODE}): terminal ${String(spawned.sessionId)}`)
  const marker = `sbx-${process.pid}`
  ctx.terminals.startSend(agent, spawned.sessionId, { text: `echo ${marker}:$((6*7)):$(pwd)`, submit: true })
  const expected = `${marker}:42:`
  const deadline = Date.now() + 40_000
  let text = ''
  while (Date.now() < deadline) {
    text = ctx.terminals.read(agent, spawned.sessionId).text
    if (text.includes(expected)) break
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  if (text.includes(expected)) {
    console.log(`ok: shell answered inside the ${MODE} sandbox (${expected})`)
    exitCode = 0
  } else {
    console.error(`FAIL: marker ${expected} not seen. last output:\n${text.slice(-1500)}`)
  }
  await ctx.terminals.kill(agent, spawned.sessionId)
} catch (error) {
  console.error(`FAIL: ${String(error && error.stack || error)}`)
} finally {
  await ctx.fiber.dispose().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
process.exit(exitCode)
