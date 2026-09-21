import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/setup-verify-cli.mjs', import.meta.url))
const boundary = 'component chain only; not full Minimal, Desktop, Blue, hook, or model acceptance'
const pass = {
  schema: 'dsh-win32/verify/v1', status: 'pass', ok: true, boundary,
  installedDshVersion: '0.1.5-rc.1', installedDshSource: 'profile',
  checks: [{ name: 'temporary_cleanup', status: 'pass', detail: 'isolated files removed' }],
}
const metadata = JSON.stringify({ version: '0.1.5-rc.2', dependencies: {
  '@deepseek-ai/dsh-tool-pwsh-persistent': '^0.1.5-rc.2',
  '@deepseek-ai/dsh-pwsh-local': '^0.1.5-rc.2',
  '@deepseek-ai/dsh-pwsh-sandbox': '^0.1.5-rc.2',
} })

function run(args: string[], report: object = pass, platform = 'win32') {
  const home = mkdtempSync(join(tmpdir(), 'dsh-setup-verify-test-'))
  const calls = join(home, 'calls.jsonl')
  writeFileSync(calls, '')
  try {
    const result = spawnSync(process.execPath, [fixture], {
      encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
        TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, DSH_HOME: home,
        DSH_WINDOWS_DSH_META: metadata, DSH_TEST_CALLS: calls,
        DSH_TEST_ARGS: JSON.stringify(args), DSH_TEST_REPORT: JSON.stringify(report),
        DSH_TEST_PLATFORM: platform },
    })
    expect(result.error).toBeUndefined()
    expect(existsSync(join(home, '.agent-presets'))).toBe(false)
    expect(existsSync(join(home, 'profiles'))).toBe(false)
    return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('opt-in setup verification CLI', () => {
  it('leaves default setup and its shortcut behavior unchanged', () => {
    const result = run(['setup'])
    expect(result.status).toBe(0)
    expect(result.calls.filter(call => call.type === 'verify')).toEqual([])
    expect(result.calls.filter(call => call.file === 'powershell.exe')).toHaveLength(1)
    expect(result.stdout).not.toContain('live acceptance passed')
  })

  it.each([['web', false], ['web', true], ['desktop', false], ['review-profile', true]] as const)(
    'verifies once for profile %s (no-shortcut=%s) and reports installed identity', (profile, noShortcut) => {
      const args = ['setup', '--verify', '--verify', '--profile', profile]
      if (noShortcut) args.push('--no-shortcut')
      const result = run(args)
      expect(result.status).toBe(0)
      expect(result.calls.filter(call => call.type === 'verify')).toEqual([{ type: 'verify', options: { profile } }])
      expect(result.calls.filter(call => call.file === 'powershell.exe')).toHaveLength(profile === 'web' && !noShortcut ? 1 : 0)
      expect(result.stdout).toContain('setup finished; running the optional installed-stack check')
      expect(result.stdout).toContain('@deepseek-ai/dsh 0.1.5-rc.1 (profile source)')
      expect(result.stdout).toContain(boundary)
      expect(result.stdout).toContain('live acceptance passed')
    },
  )

  it.each(['installed_dsh', 'workspace_write_read', 'worker_timeout', 'temporary_snapshot_preserved', 'temporary_cleanup'])(
    'propagates a failed %s check as nonzero', (name) => {
      const result = run(['setup', '--verify', '--no-shortcut'], {
        ...pass, ok: false, status: 'fail', checks: [{ name, status: 'fail', detail: 'fixture failure' }],
      })
      expect(result.status).toBe(1)
      expect(result.calls.filter(call => call.type === 'verify')).toHaveLength(1)
      expect(result.stdout).toContain(`FAIL  ${name}: fixture failure`)
      expect(result.stdout).toContain('live acceptance failed')
      expect(result.stdout).not.toContain('live acceptance passed')
    },
  )

  it('does not turn an unsupported Node result into successful verification', () => {
    const result = run(['setup', '--verify', '--no-shortcut'], {
      ...pass, ok: false, status: 'unsupported', checks: [], reason: 'requires a supported Node release',
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('unsupported: requires a supported Node release')
    expect(result.stdout).not.toContain('live acceptance passed')
  })

  it('rejects a non-Windows platform before any verification or shortcut', () => {
    const result = run(['setup', '--verify'], pass, 'darwin')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Windows-only')
    expect(result.calls).toEqual([])
  })

  it('rejects legacy verification before commands, downloads, or preset writes', () => {
    const result = run(['setup', '--legacy', '--verify'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--verify is only supported by current DSH setup, not --legacy')
    expect(result.calls).toEqual([])
  })

  it('documents the opt-in flag in help', () => {
    const result = run(['help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('setup [--verify]')
    expect(result.stdout).toContain('nonzero exit')
  })
})
