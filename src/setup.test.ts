import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const SIM = join(here, '..', 'scripts', 'win32-sim.mjs')
const SPAWN_TIMEOUT = 30_000

function runSetup({ sandboxed, bash }: { sandboxed: boolean, bash?: string }) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-win32-setup-home-'))
  const fixtures = mkdtempSync(join(tmpdir(), 'dsh-win32-setup-fixtures-'))
  const busybox = join(fixtures, 'busybox64.exe')
  writeFileSync(busybox, '')
  const args = ['setup', '--no-bundle', '--no-shortcut']
  if (sandboxed) args.push('--sandboxed', '--busybox', busybox)
  const run = spawnSync(process.execPath, [SIM], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLI_ARGS: args.join(' '),
      DSH_HOME: home,
      DSH_WINDOWS_TEST_ROOT: fixtures,
      DSH_WINDOWS_BASH: bash ?? join(fixtures, 'missing-bash.exe'),
    },
    timeout: SPAWN_TIMEOUT,
  })
  return { home, run }
}

describe('setup on Windows', () => {
  it('installs only the sandboxed preset without Git Bash', () => {
    const { home, run } = runSetup({ sandboxed: true })

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Git Bash was not found; skipped the "minimal-windows" preset')
    expect(existsSync(join(home, '.agent-presets', 'minimal-windows'))).toBe(false)
    expect(existsSync(join(home, '.agent-presets', 'minimal-windows-sandboxed'))).toBe(true)
  }, SPAWN_TIMEOUT)

  it('still fails without Git Bash when not sandboxed', () => {
    const { run } = runSetup({ sandboxed: false })

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('Git Bash is required for the minimal-windows preset')
  }, SPAWN_TIMEOUT)

  it('installs both presets when Git Bash is present', () => {
    const fixtures = mkdtempSync(join(tmpdir(), 'dsh-win32-setup-bash-'))
    const bash = join(fixtures, 'Git', 'usr', 'bin', 'bash.exe')
    mkdirSync(dirname(bash), { recursive: true })
    writeFileSync(bash, '')
    const { home, run } = runSetup({ sandboxed: true, bash })

    expect(run.status).toBe(0)
    expect(existsSync(join(home, '.agent-presets', 'minimal-windows'))).toBe(true)
    expect(existsSync(join(home, '.agent-presets', 'minimal-windows-sandboxed'))).toBe(true)
  }, SPAWN_TIMEOUT)
})
