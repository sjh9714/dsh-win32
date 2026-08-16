/**
 * Preset installation runs during plugin construction, so the two properties
 * that matter are that it never overwrites and never throws.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installPreset, installPresets, busyboxPath, dshHome } from './preset-install.ts'

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-win32-home-'))
}

describe('installPreset', () => {
  it('writes the roster with the shell path substituted', () => {
    const home = freshHome()
    const outcome = installPreset('minimal-windows', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', home)
    expect(outcome.status).toBe('installed')
    const roster = readFileSync(join(home, '.agent-presets', 'minimal-windows', 'agent.cordis.yml'), 'utf8')
    expect(roster).toContain('C:/Program Files/Git/usr/bin/bash.exe')
    expect(roster).not.toContain('__DSH_WINDOWS_BASH__')
    expect(existsSync(join(home, '.agent-presets', 'minimal-windows', 'preset.yml'))).toBe(true)
  })

  it('leaves an existing preset alone, since the user may have edited it', () => {
    const home = freshHome()
    const target = join(home, '.agent-presets', 'minimal-windows')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'agent.cordis.yml'), 'mine, do not touch')
    const outcome = installPreset('minimal-windows', 'C:/bash.exe', home)
    expect(outcome.status).toBe('exists')
    expect(readFileSync(join(target, 'agent.cordis.yml'), 'utf8')).toBe('mine, do not touch')
  })

  it('reports failure rather than throwing when the target cannot be written', () => {
    const home = freshHome()
    // A file where the preset directory needs to be.
    mkdirSync(join(home, '.agent-presets'), { recursive: true })
    writeFileSync(join(home, '.agent-presets', 'minimal-windows'), 'blocked')
    let outcome
    expect(() => { outcome = installPreset('minimal-windows', 'C:/bash.exe', home) }).not.toThrow()
    expect(outcome!.status).toBe('failed')
  })
})

describe('installPresets', () => {
  it('skips rather than fails when the prerequisites are absent', () => {
    const home = freshHome()
    const outcomes = installPresets(home)
    expect(outcomes.map(o => o.presetId)).toEqual(['minimal-windows', 'minimal-windows-sandboxed'])
    for (const outcome of outcomes) expect(outcome.status).not.toBe('failed')
    // busybox is only ever fetched by `setup --sandboxed`, never silently.
    const sandboxed = outcomes.find(o => o.presetId === 'minimal-windows-sandboxed')!
    if (!existsSync(busyboxPath())) expect(sandboxed.status).toBe('skipped')
  })

  it('resolves DSH_HOME from the environment', () => {
    expect(dshHome()).toContain('.dsh')
  })
})
