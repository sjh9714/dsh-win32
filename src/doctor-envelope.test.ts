/**
 * The `dsh-doctor/v1` envelope contract (deepseek-harness#1719).
 *
 * Assertions are shape-based on purpose. Which checks pass depends on the
 * machine the suite runs on, and the whole point of the contract is that a
 * consumer asserts on `name` plus `status` without parsing `detail`.
 */

import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.mjs')
const STATUSES = ['pass', 'warn', 'fail', 'skip']

function runDoctor(): { envelope: any, exitCode: number } {
  try {
    return { envelope: JSON.parse(execFileSync(process.execPath, [CLI, 'doctor', '--json'], { encoding: 'utf8' })), exitCode: 0 }
  } catch (error) {
    // A warn or fail finding is a non-zero exit, which execFileSync throws on.
    const failure = error as { status: number, stdout: string }
    return { envelope: JSON.parse(failure.stdout), exitCode: failure.status }
  }
}

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
})
