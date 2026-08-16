/**
 * The `dsh-doctor/v1` envelope contract (deepseek-harness#1719).
 *
 * Assertions are shape-based on purpose. Which checks pass depends on the
 * machine the suite runs on, and the whole point of the contract is that a
 * consumer asserts on `name` plus `status` without parsing `detail`.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'bin', 'cli.mjs')
const SIM = join(here, '..', 'scripts', 'win32-sim.mjs')
const STATUSES = ['pass', 'warn', 'fail', 'skip']

/** Run the CLI as a subprocess; `entry` selects the real CLI or the win32 sim. */
function runDoctor(env: Record<string, string> = {}, entry = CLI): { envelope: any, exitCode: number } {
  const options = { encoding: 'utf8' as const, env: { ...process.env, ...env } }
  const args = entry === CLI ? [entry, 'doctor', '--json'] : [entry]
  try {
    return { envelope: JSON.parse(execFileSync(process.execPath, args, options)), exitCode: 0 }
  } catch (error) {
    // A warn or fail finding is a non-zero exit, which execFileSync throws on.
    const failure = error as { status: number, stdout: string }
    return { envelope: JSON.parse(failure.stdout), exitCode: failure.status }
  }
}

// Windows CI caught this shipping inverted: the real shell lives at
// Git\usr\bin\bash.exe, which also ends in \bin\bash.exe, so a tail-only match
// told every correctly installed user their shell was the 47KB wrapper. The
// check runs through the real CLI under a forced win32 platform, since the
// point is the behaviour Windows users get, not an isolated regex.
describe('git_bash wrapper detection', () => {
  const fixtures = mkdtempSync(join(tmpdir(), 'dsh-win32-bashfix-'))
  const real = join(fixtures, 'Git', 'usr', 'bin', 'bash.exe')
  const wrapper = join(fixtures, 'Git', 'bin', 'bash.exe')
  for (const path of [real, wrapper]) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
  }

  const statusFor = (bash: string) => {
    const { envelope } = runDoctor({ CLI_ARGS: 'doctor --json', DSH_WINDOWS_BASH: bash, DSH_HOME: join(fixtures, 'home') }, SIM)
    return envelope.checks.find((c: any) => c.name === 'git_bash').status
  }

  it('passes the real shell in usr/bin', () => {
    expect(statusFor(real)).toBe('pass')
  })

  it('warns only on the bin/bash.exe wrapper', () => {
    expect(statusFor(wrapper)).toBe('warn')
  })
})

describe('dsh-doctor/v1 envelope', () => {
  it('emits the contract envelope', () => {
    const { envelope } = runDoctor()
    expect(envelope.schema).toBe('dsh-doctor/v1')
    expect(Date.parse(envelope.generatedAt)).not.toBeNaN()
    expect(envelope.ok).toBe(envelope.summary.fail === 0)
    expect(Array.isArray(envelope.checks)).toBe(true)
    for (const check of envelope.checks) {
      expect(STATUSES).toContain(check.status)
      expect(typeof check.name).toBe('string')
    }
  })

  it('gives every skip a reason, which the vocabulary requires', () => {
    const { envelope } = runDoctor()
    for (const check of envelope.checks.filter((c: any) => c.status === 'skip')) {
      expect(check.detail.length).toBeGreaterThan(0)
    }
  })

  it('counts skip as neither pass nor fail in the exit code', () => {
    const { envelope, exitCode } = runDoctor()
    const counted = envelope.summary.pass + envelope.summary.warn + envelope.summary.fail + envelope.summary.skip
    expect(counted).toBe(envelope.checks.length)
    const expected = envelope.summary.fail > 0 ? 2 : envelope.summary.warn > 0 ? 1 : 0
    expect(envelope.exitCode).toBe(expected)
    expect(exitCode).toBe(expected)
  })

  it('reports the win32-only checks as skip off Windows', () => {
    if (process.platform === 'win32') return
    const { envelope } = runDoctor()
    const byName = Object.fromEntries(envelope.checks.map((c: any) => [c.name, c.status]))
    expect(byName.node).toBeDefined()
    for (const name of ['git_bash', 'powershell', 'koffi', 'sandbox_shell']) {
      expect(byName[name]).toBe('skip')
    }
  })

  // #13: a clean box has node and Git but no pnpm, and the bundle wiring dies
  // on it with a bare "'pnpm' is not recognized". The check is platform-
  // agnostic, so it must report a real status everywhere rather than joining
  // the win32 skip list whose count the CI envelope gate asserts on.
  it('reports pnpm on every platform, never as a skip', () => {
    const { envelope } = runDoctor()
    const pnpm = envelope.checks.find((c: any) => c.name === 'pnpm')
    expect(pnpm).toBeDefined()
    expect(['pass', 'warn']).toContain(pnpm.status)
  })
})
