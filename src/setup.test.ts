import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const SIM = join(here, '..', 'scripts', 'win32-sim.mjs')
const CLI = join(here, '..', 'bin', 'cli.mjs')
const SPAWN_TIMEOUT = 30_000

const DSH_META = JSON.stringify({
  version: '0.1.1-rc.2',
  dependencies: {
    '@deepseek-ai/dsh-tool-pwsh-persistent': '^0.1.1-rc.2',
    '@deepseek-ai/dsh-pwsh-local': '^0.1.1-rc.2',
    '@deepseek-ai/dsh-pwsh-sandbox': '^0.1.1-rc.2',
  },
})

function runSetup({ sandboxed, bash, legacy = true, meta = DSH_META }: { sandboxed: boolean, bash?: string, legacy?: boolean, meta?: string }) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-win32-setup-home-'))
  const fixtures = mkdtempSync(join(tmpdir(), 'dsh-win32-setup-fixtures-'))
  const busybox = join(fixtures, 'busybox64.exe')
  writeFileSync(busybox, '')
  const args = ['setup', '--no-bundle', '--no-shortcut']
  if (legacy) args.push('--legacy')
  if (sandboxed) args.push('--sandboxed', '--busybox', busybox)
  const env = {
    ...process.env,
    CLI_ARGS: args.join(' '),
    DSH_HOME: home,
    DSH_WINDOWS_TEST_ROOT: fixtures,
    DSH_WINDOWS_BASH: bash ?? join(fixtures, 'missing-bash.exe'),
    DSH_WINDOWS_DSH_META: meta,
  }
  for (const name of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TEAMCITY_VERSION', 'TF_BUILD']) delete env[name]
  const run = spawnSync(process.execPath, [SIM], {
    encoding: 'utf8',
    env,
    timeout: SPAWN_TIMEOUT,
  })
  return { home, run }
}

describe('setup on Windows', () => {
  it.each([
    ['minimal-windows', false], ['minimal-windows', true],
    ['minimal-windows-sandboxed', false], ['minimal-windows-sandboxed', true],
  ] as const)('preserves %s before reinstall (backup blocked=%s)', (presetId, blocked) => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-reinstall-'))
    const preset = join(home, '.agent-presets', presetId)
    const backupRoot = join(home, 'dsh-win32', 'preset-backups')
    const original = '# my custom roster\n- id: keep-my-tools\n'
    mkdirSync(join(preset, 'custom'), { recursive: true })
    writeFileSync(join(preset, 'agent.cordis.yml'), original)
    writeFileSync(join(preset, 'preset.yml'), 'name: My edited preset\n')
    writeFileSync(join(preset, 'custom', 'notes.txt'), 'keep all my files')
    if (blocked) {
      mkdirSync(dirname(backupRoot), { recursive: true })
      writeFileSync(backupRoot, 'backup location is unavailable')
    }
    try {
      const args = [CLI, 'setup', '--legacy', '--no-bundle', '--no-shortcut', '--bash', 'C:/test/bash.exe']
      if (presetId === 'minimal-windows-sandboxed') args.push('--sandboxed', '--busybox', 'C:/test/bash.exe')
      const run = spawnSync(process.execPath, args, {
        env: { ...process.env, DSH_HOME: home, DSH_WINDOWS_DSH_META: DSH_META, CI: 'true' },
        encoding: 'utf8', timeout: SPAWN_TIMEOUT,
      })
      if (blocked) {
        expect(run.status).not.toBe(0)
        expect(readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')).toBe(original)
        expect(readFileSync(join(preset, 'custom', 'notes.txt'), 'utf8')).toBe('keep all my files')
      } else {
        expect(run.status).toBe(0)
        expect(run.stdout).toContain('backed up existing preset')
        const backups = readdirSync(backupRoot)
        expect(backups).toHaveLength(1)
        const saved = join(backupRoot, backups[0], presetId)
        expect(readFileSync(join(saved, 'agent.cordis.yml'), 'utf8')).toBe(original)
        expect(readFileSync(join(saved, 'preset.yml'), 'utf8')).toBe('name: My edited preset\n')
        expect(readFileSync(join(saved, 'custom', 'notes.txt'), 'utf8')).toBe('keep all my files')
        expect(readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')).toContain('C:/test/bash.exe')
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, SPAWN_TIMEOUT)

  it('refuses a linked preset without moving its target or discarding edits', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-linked-preset-'))
    const original = join(home, 'custom-original')
    const preset = join(home, '.agent-presets', 'minimal-windows')
    mkdirSync(original)
    mkdirSync(dirname(preset))
    writeFileSync(join(original, 'agent.cordis.yml'), 'keep my linked roster')
    symlinkSync(original, preset, 'junction')
    try {
      const run = spawnSync(process.execPath, [CLI, 'setup', '--legacy', '--no-bundle', '--no-shortcut', '--bash', 'C:/test/bash.exe'], {
        env: { ...process.env, DSH_HOME: home, DSH_WINDOWS_DSH_META: DSH_META, CI: 'true' },
        encoding: 'utf8', timeout: SPAWN_TIMEOUT,
      })
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('refusing to replace')
      expect(lstatSync(preset).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(original, 'agent.cordis.yml'), 'utf8')).toBe('keep my linked roster')
      expect(existsSync(join(home, 'dsh-win32', 'preset-backups'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, SPAWN_TIMEOUT)

  it('uses the official DSH stack by default and installs no legacy preset', () => {
    const { home, run } = runSetup({ sandboxed: true, legacy: false })

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('current DSH already includes persistent PowerShell')
    expect(run.stdout).toContain('--sandboxed is no longer needed')
    expect(run.stdout).toContain('WIN32_SIM_BROWSER: no browser process was started')
    expect(run.stdout).not.toContain('[Y/n]')
    expect(run.stdout).not.toContain('USER_CONFIRMATION_REQUIRED')
    expect(existsSync(join(home, '.dsh-win32-star-prompted'))).toBe(true)
    expect(existsSync(join(home, '.agent-presets'))).toBe(false)
  }, SPAWN_TIMEOUT)

  it('stops current setup when the official Windows stack cannot be verified', () => {
    const { home, run } = runSetup({
      sandboxed: false,
      legacy: false,
      meta: JSON.stringify({ version: '0.1.0-rc.6', dependencies: {} }),
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('does not expose the complete official Windows stack')
    expect(existsSync(join(home, '.agent-presets'))).toBe(false)
  }, SPAWN_TIMEOUT)

  it('installs only the sandboxed preset without Git Bash', () => {
    const { home, run } = runSetup({ sandboxed: true })

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Git Bash was not found; skipped the "minimal-windows" preset')
    expect(run.stdout).toContain('WIN32_SIM_BROWSER: no browser process was started')
    expect(run.stdout).not.toContain('[Y/n]')
    expect(run.stdout).not.toContain('USER_CONFIRMATION_REQUIRED')
    expect(existsSync(join(home, '.dsh-win32-star-prompted'))).toBe(true)
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
    expect(run.stdout).toContain('WIN32_SIM_BROWSER: no browser process was started')
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
    const policyPath = join(home, 'profiles', 'desktop', 'pnpm-workspace.yaml')
    const policy = 'minimumReleaseAge: 2880\nminimumReleaseAgeStrict: true\nstrictDepBuilds: true\n'
    mkdirSync(dirname(policyPath), { recursive: true })
    writeFileSync(policyPath, policy)
    mkdirSync(dirname(bash), { recursive: true })
    writeFileSync(bash, '')
    writeFileSync(busybox, '')
    mkdirSync(bin)
    const npx = join(bin, 'npx')
    writeFileSync(npx, '#!/bin/sh\nprintf "%s\\n" "$@" > "$DSH_NPX_ARGS"\n')
    chmodSync(npx, 0o755)
    writeFileSync(join(bin, 'npx.cmd'), '@echo off\r\n:args\r\nif "%~1"=="" goto done\r\n>>"%DSH_NPX_ARGS%" echo %~1\r\nshift\r\ngoto args\r\n:done\r\n')

    const run = spawnSync(process.execPath, [CLI, 'setup', '--legacy', '--no-shortcut', '--profile', 'desktop', '--sandboxed', '--busybox', busybox, '--bash', bash], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_NPX_ARGS: npxArgs,
        CI: 'true', // Bundle wiring is not an account/browser integration test.
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        DSH_WINDOWS_DSH_META: DSH_META,
      },
      timeout: SPAWN_TIMEOUT,
    })

    expect(run.status).toBe(0)
    const argv = readFileSync(npxArgs, 'utf8').trim().split(/\r?\n/)
    expect(argv.slice(argv.indexOf('--profile'), argv.indexOf('--profile') + 2)).toEqual(['--profile', 'desktop'])
    expect(argv.some(arg => /minimum.?release.?age|ignore.?scripts|ignore.?dep.?scripts/i.test(arg))).toBe(false)
    expect(readFileSync(policyPath, 'utf8')).toBe(policy)
    expect(run.stdout).toContain('keeping the existing pnpm release-age and build policies')
  }, SPAWN_TIMEOUT)

  it('rejects an unsafe profile name before writing presets', () => {
    const fixtures = mkdtempSync(join(tmpdir(), 'dsh-win32-setup-profile-unsafe-'))
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-setup-profile-unsafe-home-'))
    const bash = join(fixtures, 'bash.exe')
    const busybox = join(fixtures, 'busybox64.exe')
    writeFileSync(bash, '')
    writeFileSync(busybox, '')

    const run = spawnSync(process.execPath, [CLI, 'setup', '--legacy', '--no-bundle', '--no-shortcut', '--profile', 'desktop&calc', '--sandboxed', '--busybox', busybox, '--bash', bash], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: home, DSH_WINDOWS_DSH_META: DSH_META },
      timeout: SPAWN_TIMEOUT,
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('--profile needs one safe profile name')
    expect(existsSync(join(home, '.agent-presets'))).toBe(false)
  }, SPAWN_TIMEOUT)
})
