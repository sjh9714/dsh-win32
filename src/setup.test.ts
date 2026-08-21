import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const SIM = join(here, '..', 'scripts', 'win32-sim.mjs')
const CLI = join(here, '..', 'bin', 'cli.mjs')
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

  it('wires the bundle into the selected desktop profile', () => {
    const fixtures = mkdtempSync(join(tmpdir(), 'dsh-win32-setup-profile-'))
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-setup-profile-home-'))
    const bash = join(fixtures, 'Git', 'usr', 'bin', 'bash.exe')
    const busybox = join(fixtures, 'busybox64.exe')
    const npxArgs = join(fixtures, 'npx-args.txt')
    const bin = join(fixtures, 'bin')
    mkdirSync(dirname(bash), { recursive: true })
    writeFileSync(bash, '')
    writeFileSync(busybox, '')
    mkdirSync(bin)
    const npx = join(bin, 'npx')
    writeFileSync(npx, '#!/bin/sh\nprintf "%s\\n" "$@" > "$DSH_NPX_ARGS"\n')
    chmodSync(npx, 0o755)

    const run = spawnSync(process.execPath, [CLI, 'setup', '--no-shortcut', '--profile', 'desktop', '--sandboxed', '--busybox', busybox, '--bash', bash], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_NPX_ARGS: npxArgs,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
      timeout: SPAWN_TIMEOUT,
    })

    expect(run.status).toBe(0)
    expect(readFileSync(npxArgs, 'utf8')).toContain('--profile\ndesktop\n')
  }, SPAWN_TIMEOUT)

  it('rejects an unsafe profile name before writing presets', () => {
    const fixtures = mkdtempSync(join(tmpdir(), 'dsh-win32-setup-profile-unsafe-'))
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-setup-profile-unsafe-home-'))
    const bash = join(fixtures, 'bash.exe')
    const busybox = join(fixtures, 'busybox64.exe')
    writeFileSync(bash, '')
    writeFileSync(busybox, '')

    const run = spawnSync(process.execPath, [CLI, 'setup', '--no-bundle', '--no-shortcut', '--profile', 'desktop&calc', '--sandboxed', '--busybox', busybox, '--bash', bash], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: home },
      timeout: SPAWN_TIMEOUT,
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('--profile needs one safe profile name')
    expect(existsSync(join(home, '.agent-presets'))).toBe(false)
  }, SPAWN_TIMEOUT)
})
