import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))
const roots: string[] = []
const original = '{\r\n  "private": true,\r\n  "dependencies": {"dsh-win32":"0.17.12","keep":"1"},\r\n  "dsh": {"profile": {"bundles": ["base", "dsh-win32", "other", "dsh-win32"], "keep": 9007199254740993123}},\r\n  "secret": "do-not-print-this"\r\n}\r\n'

function fixture(text = original) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-win32-disable-'))
  roots.push(home)
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  const manifest = join(profile, 'package.json')
  writeFileSync(manifest, text)
  // A broken host and plugin must never be imported by the recovery command.
  for (const name of ['@deepseek-ai/dsh', 'dsh-win32']) {
    const module = join(profile, 'node_modules', name)
    mkdirSync(module, { recursive: true })
    writeFileSync(join(module, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
    writeFileSync(join(module, 'index.js'), 'throw new Error("BROKEN_HOST_WAS_LOADED")')
  }
  return { home, profile, manifest }
}

function run(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, 'disable', ...args], {
    env: { ...process.env, DSH_HOME: home, PATH: '', CI: 'true' },
    encoding: 'utf8', timeout: 15_000,
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('offline legacy bundle disable (#92)', () => {
  it('previews without loading a broken DSH host, spawning commands, or writing files', () => {
    const { home, profile, manifest } = fixture()
    const before = readdirSync(profile)
    const result = run(home)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Preview')
    expect(result.stdout).toContain('--apply')
    expect(readFileSync(manifest, 'utf8')).toBe(original)
    expect(readdirSync(profile)).toEqual(before)
    expect(result.stdout + result.stderr).not.toContain('do-not-print-this')
    expect(existsSync(join(home, '.dsh-win32-star-prompted'))).toBe(false)
  })

  it('backs up exact bytes, removes only bundle activation, and is idempotent', () => {
    const { home, profile, manifest } = fixture()
    const policy = 'minimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\n'
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), policy)
    writeFileSync(join(profile, 'pnpm-lock.yaml'), 'retain-lock\n')
    const other = join(home, 'profiles', 'desktop', 'package.json')
    mkdirSync(dirname(other), { recursive: true })
    writeFileSync(other, original)
    const result = run(home, '--apply')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Disabled the dsh-win32 bundle')
    const updated = original.replace('["base", "dsh-win32", "other", "dsh-win32"]', '["base","other"]')
    expect(readFileSync(manifest, 'utf8')).toBe(updated)
    const backups = readdirSync(profile).filter(name => name.startsWith('.dsh-win32-backup-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(profile, backups[0], 'package.json'), 'utf8')).toBe(original)
    expect(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8')).toBe(policy)
    expect(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8')).toBe('retain-lock\n')
    expect(readFileSync(other, 'utf8')).toBe(original)
    expect(existsSync(join(profile, 'node_modules', 'dsh-win32', 'package.json'))).toBe(true)
    expect(existsSync(`${manifest}.lock`)).toBe(false)
    const again = run(home, '--apply')
    expect(again.status).toBe(0)
    expect(again.stdout).toContain('already absent')
    expect(readdirSync(profile).filter(name => name.startsWith('.dsh-win32-backup-'))).toEqual(backups)
  })

  it('accepts an explicitly selected application-owned profile directory', () => {
    const { home, profile, manifest } = fixture()
    const result = run(join(home, 'unused-home'), '--profile-dir', profile, '--apply')
    expect(result.status).toBe(0)
    expect(JSON.parse(readFileSync(manifest, 'utf8')).dsh.profile.bundles).toEqual(['base', 'other'])
    expect(existsSync(join(home, 'unused-home'))).toBe(false)
  })

  it('keeps custom patches and global presets and explains the remaining manual work', () => {
    const { home, profile } = fixture()
    const patch = '- id: subprocess-windows\n  name: dsh-win32\n  config: !!js (() => { throw new Error("MUST_NOT_EVALUATE") })()\n'
    writeFileSync(join(profile, 'cordis.patch.yml'), patch)
    const preset = join(home, '.agent-presets', 'minimal-windows')
    mkdirSync(preset, { recursive: true })
    writeFileSync(join(preset, 'agent.cordis.yml'), 'my custom preset\n')
    const result = run(home, '--apply')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('cordis.patch.yml')
    expect(result.stdout).toContain('Minimal')
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')).toBe('my custom preset\n')
    expect(result.stdout + result.stderr).not.toContain('MUST_NOT_EVALUATE')
  })

  it.each([
    '{"dsh":{"profile":{"bundles":["dsh-win32"]}},"secret":',
    '{"dsh":{"profile":{"bundles":"dsh-win32"}}}',
    '{"dsh":{"profile":{"bundles":["dsh-win32",{}]}}}',
    '{"dsh":{"profile":{"bundles":["dsh-win32"]}},"dsh":{}}',
    '[]',
  ])('refuses malformed or ambiguous manifests without changing them (%#)', (source) => {
    const { home, profile, manifest } = fixture(source)
    const result = run(home, '--apply')
    expect(result.status).toBe(1)
    expect(readFileSync(manifest, 'utf8')).toBe(source)
    expect(readdirSync(profile).filter(name => name.startsWith('.dsh-win32-backup-'))).toEqual([])
    expect(existsSync(`${manifest}.lock`)).toBe(false)
  })

  it('does not steal the host package writer lock', () => {
    const { home, profile, manifest } = fixture()
    writeFileSync(`${manifest}.lock`, 'another writer\n')
    const result = run(home, '--apply')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lock')
    expect(readFileSync(manifest, 'utf8')).toBe(original)
    expect(readFileSync(`${manifest}.lock`, 'utf8')).toBe('another writer\n')
    expect(readdirSync(profile).filter(name => name.startsWith('.dsh-win32-backup-'))).toEqual([])
  })

  it('refuses a linked profile directory', () => {
    const { home, profile, manifest } = fixture()
    symlinkSync(profile, join(home, 'profiles', 'linked'), 'junction')
    const result = run(home, '--profile', 'linked', '--apply')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('linked')
    expect(readFileSync(manifest, 'utf8')).toBe(original)
  })

  it.each([
    ['--profile', '../web', '--apply'], ['--profile', 'node_modules', '--apply'],
    ['--profile'], ['--appply'], ['--profile', 'web', '--profile-dir', '.', '--apply'],
  ])('rejects unsafe or ambiguous arguments (%j)', (...args) => {
    const { home, manifest } = fixture()
    expect(run(home, ...args).status).toBe(1)
    expect(readFileSync(manifest, 'utf8')).toBe(original)
  })

  it('does not create an absent profile', () => {
    const { home } = fixture()
    const result = run(home, '--profile', 'missing', '--apply')
    expect(result.status).toBe(1)
    expect(existsSync(join(home, 'profiles', 'missing'))).toBe(false)
  })

  it('honors a selected named profile without changing web', () => {
    const { home, manifest } = fixture()
    const other = join(home, 'profiles', 'trial', 'package.json')
    mkdirSync(dirname(other))
    writeFileSync(other, original)
    expect(run(home, '--profile', 'trial', '--apply').status).toBe(0)
    expect(readFileSync(manifest, 'utf8')).toBe(original)
    expect(JSON.parse(readFileSync(other, 'utf8')).dsh.profile.bundles).toEqual(['base', 'other'])
  })

  it.each(['{}', '{"dependencies":{"dsh-win32":"*"}}', '{"dsh":{"profile":{"bundles":["base"]}}}'])('leaves a profile with no active legacy bundle unchanged (%#)', source => {
    const { home, profile, manifest } = fixture(source)
    expect(run(home, '--apply').status).toBe(0)
    expect(readFileSync(manifest, 'utf8')).toBe(source)
    expect(readdirSync(profile).filter(name => name.startsWith('.dsh-win32-backup-'))).toEqual([])
  })

  it('refuses a hard-linked manifest without changing either name', () => {
    const { home, manifest } = fixture()
    const alias = join(home, 'shared-manifest.json')
    linkSync(manifest, alias)
    const result = run(home, '--apply')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('linked')
    expect(readFileSync(alias, 'utf8')).toBe(original)
    expect(readFileSync(manifest, 'utf8')).toBe(original)
  })

  it('refuses invalid UTF-8 and oversized manifests without leaking their contents', () => {
    const { home, manifest } = fixture()
    for (const source of [Buffer.concat([Buffer.from(original), Buffer.from([0xff])]), Buffer.from(`{"secret":"${'x'.repeat(1024 * 1024)}"}`)]) {
      writeFileSync(manifest, source)
      const result = run(home, '--apply')
      expect(result.status).toBe(1)
      expect(readFileSync(manifest).equals(source)).toBe(true)
      expect(result.stdout + result.stderr).not.toContain('do-not-print-this')
    }
  })

  it.each(['backup', 'replace', 'concurrent-edit'])('retains recoverable data when %s fails', stage => {
    const { home, profile, manifest } = fixture()
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const stage = ${JSON.stringify(stage)};
      if (stage === 'backup') fs.mkdtempSync = () => { throw Object.assign(new Error('blocked'), { code: 'EACCES' }) };
      else if (stage === 'replace') fs.renameSync = () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }) };
      else {
        const originalWrite = fs.writeFileSync;
        fs.writeFileSync = (...args) => {
          originalWrite(...args);
          if (String(args[1]).includes('["base","other"]')) originalWrite(${JSON.stringify(manifest)}, '{"newer":"preserve me"}');
        };
      }
      syncBuiltinESMExports();
      process.argv = [process.execPath, ${JSON.stringify(CLI)}, 'disable', '--apply'];
      await import(${JSON.stringify(new URL('../bin/cli.mjs', import.meta.url).href)});
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, DSH_HOME: home, PATH: '', CI: 'true' }, encoding: 'utf8', timeout: 15_000,
    })
    expect(result.status).toBe(1)
    expect(readFileSync(manifest, 'utf8')).toBe(stage === 'concurrent-edit' ? '{"newer":"preserve me"}' : original)
    expect(existsSync(`${manifest}.lock`)).toBe(false)
    const backups = readdirSync(profile).filter(name => name.startsWith('.dsh-win32-backup-'))
    if (stage === 'backup') expect(backups).toHaveLength(0)
    else {
      expect(backups).toHaveLength(1)
      expect(readFileSync(join(profile, backups[0], 'package.json'), 'utf8')).toBe(original)
      expect(result.stderr).toContain('original backup:')
    }
  })
})
