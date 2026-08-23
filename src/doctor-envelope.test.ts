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
const DSH_META = JSON.stringify({
  version: '0.1.1-rc.2',
  dependencies: {
    '@deepseek-ai/dsh-tool-pwsh-persistent': '^0.1.1-rc.2',
    '@deepseek-ai/dsh-pwsh-local': '^0.1.1-rc.2',
    '@deepseek-ai/dsh-pwsh-sandbox': '^0.1.1-rc.2',
  },
})
// Every case here spawns a real node process, and doctor now shells out to
// `where.exe` and walks the profile directory. A Windows runner took 7.2s for
// the first spawn, so the 5s default made this a coin flip rather than a test.
const SPAWN_TIMEOUT = 30_000

/** Run the CLI as a subprocess; `entry` selects the real CLI or the win32 sim. */
function runDoctor(env: Record<string, string> = {}, entry = CLI): { envelope: any, exitCode: number } {
  const options = { encoding: 'utf8' as const, env: { ...process.env, DSH_WINDOWS_DSH_META: DSH_META, ...env } }
  const extra = env.DOCTOR_EXTRA_ARGS === undefined ? [] : env.DOCTOR_EXTRA_ARGS.split(' ')
  const args = entry === CLI ? [entry, 'doctor', '--json', ...extra] : [entry]
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
    const { envelope } = runDoctor({ CLI_ARGS: 'doctor --json --legacy', DSH_WINDOWS_BASH: bash, DSH_HOME: join(fixtures, 'home') }, SIM)
    return envelope.checks.find((c: any) => c.name === 'git_bash').status
  }

  it('passes the real shell in usr/bin', () => {
    expect(statusFor(real)).toBe('pass')
  }, SPAWN_TIMEOUT)

  it('warns only on the bin/bash.exe wrapper', () => {
    expect(statusFor(wrapper)).toBe('warn')
  }, SPAWN_TIMEOUT)
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
  }, SPAWN_TIMEOUT)

  it('gives every skip a reason, which the vocabulary requires', () => {
    const { envelope } = runDoctor()
    for (const check of envelope.checks.filter((c: any) => c.status === 'skip')) {
      expect(check.detail.length).toBeGreaterThan(0)
    }
  }, SPAWN_TIMEOUT)

  it('counts skip as neither pass nor fail in the exit code', () => {
    const { envelope, exitCode } = runDoctor()
    const counted = envelope.summary.pass + envelope.summary.warn + envelope.summary.fail + envelope.summary.skip
    expect(counted).toBe(envelope.checks.length)
    const expected = envelope.summary.fail > 0 ? 2 : envelope.summary.warn > 0 ? 1 : 0
    expect(envelope.exitCode).toBe(expected)
    expect(exitCode).toBe(expected)
  }, SPAWN_TIMEOUT)

  it('reports the win32-only checks as skip off Windows', () => {
    if (process.platform === 'win32') return
    const { envelope } = runDoctor()
    const byName = Object.fromEntries(envelope.checks.map((c: any) => [c.name, c.status]))
    expect(byName.node).toBeDefined()
    for (const name of ['git_bash', 'powershell', 'koffi', 'sandbox_shell']) {
      expect(byName[name]).toBe('skip')
    }
  }, SPAWN_TIMEOUT)

  // #17: the runtime lives in the bundle inside the profile, so a machine can
  // run a new CLI against an old runtime with every check green. The version
  // has to be visible in the report. Vendor-prefixed because it is not a
  // dsh-doctor/v1 vocabulary name.
  // `skip` is in the set because a box with no wired profile has nothing to
  // compare the CLI against, which is the co-drafted `installed_bundle` cell
  // (#1719). CI is exactly that box, and a developer machine usually is not,
  // so asserting only pass/warn passes locally and fails in CI.
  it('reports the wired bundle version under a vendor-prefixed name', () => {
    const { envelope } = runDoctor()
    const bundle = envelope.checks.find((c: any) => c.name === 'dsh-win32/bundle')
    expect(bundle).toBeDefined()
    expect(['pass', 'warn', 'skip']).toContain(bundle.status)
    // Whatever the cell, the contract needs a reason on it.
    expect(bundle.detail).toBeTruthy()
  }, SPAWN_TIMEOUT)

  it('passes the bundle check when the current DSH profile has no legacy bundle', () => {
    const { envelope } = runDoctor({ DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-doctor-empty-')) })
    const bundle = envelope.checks.find((c: any) => c.name === 'dsh-win32/bundle')
    expect(bundle.status).toBe('pass')
    expect(bundle.detail).toMatch(/correct for current DSH/i)
  }, SPAWN_TIMEOUT)

  it('confirms the official persistent PowerShell and Workspace Write packages', () => {
    const { envelope } = runDoctor({ CLI_ARGS: 'doctor --json', DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-doctor-current-')) }, SIM)
    const byName = Object.fromEntries(envelope.checks.map((c: any) => [c.name, c]))
    expect(byName.dsh_current.status).toBe('pass')
    expect(byName.persistent_powershell.status).toBe('pass')
    expect(byName.workspace_write.status).toBe('pass')
    expect(byName.git_bash.status).toBe('skip')
  }, SPAWN_TIMEOUT)

  // #13: a clean box has node and Git but no pnpm, and the bundle wiring dies
  // on it with a bare "'pnpm' is not recognized". The check is platform-
  // agnostic, so it must report a real status everywhere rather than joining
  // the win32 skip list whose count the CI envelope gate asserts on.
  it('skips pnpm in current mode because no bundle is installed', () => {
    const { envelope } = runDoctor()
    const pnpm = envelope.checks.find((c: any) => c.name === 'pnpm')
    expect(pnpm).toBeDefined()
    expect(pnpm.status).toBe('skip')
    expect(pnpm.detail).toMatch(/does not install a bundle/)
  }, SPAWN_TIMEOUT)
})

describe('koffi runtime loading', () => {
  function homeWithKoffi(source: string) {
    const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-koffi-'))
    const koffi = join(home, 'profiles', 'web', 'node_modules', 'koffi')
    mkdirSync(koffi, { recursive: true })
    writeFileSync(join(koffi, 'package.json'), JSON.stringify({ version: '3.1.2', main: 'index.js' }))
    writeFileSync(join(koffi, 'index.js'), source)
    return home
  }

  it('passes a supported koffi package that actually loads', () => {
    const { envelope } = runDoctor({ DSH_HOME: homeWithKoffi('module.exports = {}') }, SIM)
    const koffi = envelope.checks.find((c: any) => c.name === 'koffi')
    expect(koffi.status).toBe('pass')
    expect(koffi.detail).toContain('3.1.2 in "web"')
  }, SPAWN_TIMEOUT)

  it('warns when a supported version is present but cannot load', () => {
    const { envelope } = runDoctor({ DSH_HOME: homeWithKoffi('throw new Error("native load failed")') }, SIM)
    const koffi = envelope.checks.find((c: any) => c.name === 'koffi')
    expect(koffi.status).toBe('warn')
    expect(koffi.detail).toMatch(/runtime load failed/)
    expect(koffi.fix).toBe('npx dsh-win32 fix')
  }, SPAWN_TIMEOUT)
})

// The dsh-doctor v1.1 addendum pins the remediation key by BOUNDARY, not by a
// character class. That distinction came out of this implementation: an early
// draft matched /^\[([a-z_]+)\] /, which silently drops every vendor-prefixed
// name, and `dsh-win32/bundle` is both vendor-prefixed and the most actionable
// warn we emit. A charset regression here would not throw anywhere, it would
// just quietly stop a consumer from seeing that line.
describe('the remediation field (dsh-doctor v1.1)', () => {
  const KEY = /^\[([^\]]+)\] /

  it('is absent unless asked for, so a frozen r5 consumer never sees it', () => {
    const { envelope } = runDoctor()
    expect(envelope.remediation).toBeUndefined()
  }, SPAWN_TIMEOUT)

  it('carries one keyed line per warn or fail, in check order', () => {
    const { envelope } = runDoctor({ DOCTOR_EXTRA_ARGS: '--remediation' })
    const actionable = envelope.checks.filter((c: any) => c.status === 'warn' || c.status === 'fail')
    expect(envelope.remediation).toHaveLength(actionable.length)
    const keys = envelope.remediation.map((line: string) => KEY.exec(line)?.[1])
    expect(keys).toEqual(actionable.map((c: any) => c.name))
  }, SPAWN_TIMEOUT)

  it('keeps a vendor-prefixed key parseable, which a charset rule would not', () => {
    const { envelope } = runDoctor({ DOCTOR_EXTRA_ARGS: '--remediation' })
    const vendor = envelope.remediation.filter((line: string) => KEY.exec(line)?.[1]?.includes('/'))
    for (const line of vendor) {
      const key = KEY.exec(line)?.[1]
      expect(key).toBeDefined()
      expect(envelope.checks.some((c: any) => c.name === key)).toBe(true)
      // The body is free text and must survive the key having a separator.
      expect(line.slice(KEY.exec(line)![0].length).length).toBeGreaterThan(0)
    }
  }, SPAWN_TIMEOUT)

  it('never emits an empty fix, falling back to detail when a check has none', () => {
    const { envelope } = runDoctor({ DOCTOR_EXTRA_ARGS: '--remediation' })
    for (const line of envelope.remediation) expect(line.slice(KEY.exec(line)![0].length).trim()).not.toBe('')
  }, SPAWN_TIMEOUT)
})
