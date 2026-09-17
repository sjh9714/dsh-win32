import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import { installPreset, PRESET_IDS } from './preset-install.ts'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/persona-contracts.json', import.meta.url), 'utf8'))

// Only the shipped persona row's simple scalar config is read here. Do not
// evaluate Cordis !!js tags elsewhere in the roster or start a DSH host.
function personaConfig(roster: string): Record<string, string | boolean> {
  const row = roster.match(/^- id: persona\r?\n  name: '@deepseek-ai\/dsh-persona'\r?\n  config:\r?\n((?:    [^\r\n]+\r?\n)+)/m)
  expect(row, 'shipped persona row').not.toBeNull()
  return Object.fromEntries(row![1].trimEnd().split(/\r?\n/).filter(line => !line.trimStart().startsWith('#')).map(line => {
    const match = line.match(/^    (\w+): (.+)$/)
    expect(match, 'simple scalar persona config').not.toBeNull()
    const [, key, value] = match!
    return [key, value === 'true' ? true : value === 'false' ? false : value]
  }))
}

describe('published persona contracts', () => {
  for (const fixture of fixtures) {
    // Immutable upstream code, with only its two imports and export removed.
    // Config/apply stay unchanged. The registry is recorded, not launched.
    const source = fixture.source.replace(/^import .+;\n/gm, '').replace(/^export .+;\n/gm, '')
    const { Config, apply } = new Function('z', 'PERSONA_ORDER', 'PERSONA_SECTION', 'PERSONA_PREFIX_SECTION', 'PERSONA_SUFFIX_SECTION',
      `${source}\nreturn { Config, apply };`)(z, 10, 'legacy', 'prefix', 'suffix')

    it(`${fixture.version}: keeps the inspected source identity`, () => {
      expect(createHash('sha256').update(fixture.source).digest('hex')).toBe(fixture.sourceSha256)
    })

    it(`${fixture.version}: rejects the opposite version's single-key config`, () => {
      const key = fixture.version === '0.1.0-rc.6' ? 'prefix' : 'text'
      expect(() => Config({ [key]: 'test persona', complete: true, includeRuntimeContext: false })).toThrow(/missing required/)
    })

    it.each(PRESET_IDS)(`${fixture.version}: installs and applies %s with the same persona`, (preset) => {
      const home = mkdtempSync(join(tmpdir(), 'dsh-persona-contract-'))
      try {
        expect(installPreset(preset, 'C:/Program Files/shell.exe', home).status).toBe('installed')
        const config = personaConfig(readFileSync(join(home, '.agent-presets', preset, 'agent.cordis.yml'), 'utf8'))
        const parsed = Config(config)
        expect(config.text).toBe(config.prefix)
        const sections: { text: string, complete?: boolean }[] = []
        let suppressed = false
        apply({
          effect: (callback: () => void) => callback(),
          systemPrompt: {
            section: (section: { text: string }) => { sections.push(section) },
            getSectionOrder: () => 10,
            suppressRuntimeContext: () => { suppressed = true },
          },
        }, parsed)
        expect(sections[0]).toMatchObject({ text: 'You are a helpful software engineer assistant.', complete: true })
        expect(sections.slice(1).every(section => section.text === '')).toBe(true)
        expect(suppressed).toBe(true)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  }
})
