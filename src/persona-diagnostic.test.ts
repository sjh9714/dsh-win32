import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectLegacyPersonas } from './persona-diagnostic.ts'
import { installPreset, PRESET_IDS } from './preset-install.ts'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
function fixture(source?: string) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-persona-diagnostic-'))
  homes.push(home)
  const dir = join(home, '.agent-presets', 'minimal-windows')
  const path = join(dir, 'agent.cordis.yml')
  if (source !== undefined) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, source)
  }
  return { home, dir, path }
}
const roster = (config: string) => `- name: '@deepseek-ai/dsh-persona'\n  config:\n${config}`

describe('static installed persona diagnostics', () => {
  it('skips missing presets without creating a home or profile', () => {
    const { home } = fixture()
    const absent = join(home, 'absent')
    expect(inspectLegacyPersonas(absent).status).toBe('skip')
    expect(existsSync(absent)).toBe(false)
  })

  it('passes both shipped presets including their unrelated !!js tags', () => {
    const { home } = fixture()
    for (const id of PRESET_IDS) expect(installPreset(id, 'C:/shell.exe', home).status).toBe('installed')
    expect(inspectLegacyPersonas(home)).toMatchObject({ status: 'pass', detail: expect.stringContaining('not host/session compatibility') })
  })

  it.each([
    ['missing prefix', '    text: private-canary\n', 'missing persona prefix'],
    ['missing text', '    prefix: private-canary\n', 'missing persona text'],
    ['missing both', '    complete: true\n', 'text and prefix'],
    ['different values', '    text: private-canary\n    prefix: different-canary\n', 'differ'],
    ['non-string', '    text: 42\n    prefix: 42\n', 'literal strings'],
    ['null', '    text: null\n    prefix: null\n', 'literal strings'],
    ['dynamic strings', '    text: !!js process.exit(99)\n    prefix: !!js process.exit(99)\n', 'literal strings'],
    ['aliases', '    text: &prompt private-canary\n    prefix: *prompt\n', 'literal strings'],
    ['duplicate keys', '    text: private-canary\n    text: other\n    prefix: other\n', 'ambiguous YAML'],
    ['merge keys', '    <<: { text: private-canary, prefix: private-canary }\n', 'config'],
  ])('warns on %s without revealing or rewriting input', (_label, config, reason) => {
    const source = roster(config)
    const { home, path } = fixture(source)
    const check = inspectLegacyPersonas(home)
    expect(check.status).toBe('warn')
    expect(check.detail).toContain(reason)
    expect(JSON.stringify(check)).not.toMatch(/private-canary|different-canary|process\.exit/)
    expect(readFileSync(path, 'utf8')).toBe(source)
  })

  it.each([
    '    text: |-\n      first line\n      second line\n    prefix: "first line\\nsecond line"\n',
    '    text: >-\n      first line\n      second line\n    prefix: first line second line\n',
    '    text: ""\n    prefix: !!str ""\n',
  ])('compares parsed multiline and quoted string values', (config) => {
    const { home } = fixture(roster(config))
    expect(inspectLegacyPersonas(home).status).toBe('pass')
  })

  it.each([
    roster('    text: good\n    prefix: good\n') + roster('    text: good\n    prefix: good\n'),
    '- name: custom-plugin\n',
    '- name: !!js process.exit(99)\n',
    '- &row { name: "@deepseek-ai/dsh-persona", config: { text: ok, prefix: ok } }\n- *row\n',
    '- name: "@deepseek-ai/dsh-persona"\n  config: !!js process.exit(99)\n',
    'not a plugin list',
    '---\n' + roster('    text: ok\n    prefix: ok\n') + '---\nprivate-canary\n',
  ])('does not certify unsupported or ambiguous composition', (source) => {
    const { home } = fixture(source)
    const check = inspectLegacyPersonas(home)
    expect(check.status).toBe('warn')
    expect(JSON.stringify(check)).not.toMatch(/private-canary|process\.exit/)
  })

  it('handles missing, non-file and oversized rosters without crashing', () => {
    const { home, dir, path } = fixture()
    mkdirSync(dir, { recursive: true })
    expect(inspectLegacyPersonas(home).status).toBe('warn')
    mkdirSync(path)
    expect(inspectLegacyPersonas(home).status).toBe('warn')
    rmSync(path, { recursive: true })
    writeFileSync(path, '#'.repeat(256 * 1024 + 1))
    expect(inspectLegacyPersonas(home).detail).toContain('oversized')
  })

  it('does not follow linked preset directories', () => {
    const { home, dir } = fixture()
    const target = join(home, 'linked-target')
    mkdirSync(target)
    mkdirSync(join(home, '.agent-presets'))
    symlinkSync(target, dir, process.platform === 'win32' ? 'junction' : 'dir')
    expect(inspectLegacyPersonas(home).detail).toContain('linked')
    expect(existsSync(join(target, 'agent.cordis.yml'))).toBe(false)
  })
})
