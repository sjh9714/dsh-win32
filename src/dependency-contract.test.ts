import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const lockfile = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const legacyVersion = '0.1.0-rc.6'
const legacyDependencies = [
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-terminal-bash',
]

describe('legacy dependency compatibility', () => {
  it('retains the declared subprocess support boundary', () => {
    expect(manifest.peerDependencies['@deepseek-ai/dsh-subprocess-local'])
      .toBe('>=0.1.0-rc.5 <0.1.0-rc.7')
  })

  it.each(legacyDependencies)('keeps %s on the tested legacy fixture version', (name) => {
    // A floating prerelease range can pull terminal-bash rc.8 into the rc.6
    // subprocess fixture and fail dependency resolution before tests start.
    expect(manifest.devDependencies[name]).toBe(legacyVersion)
    expect(lockfile.packages[`node_modules/${name}`].version).toBe(legacyVersion)

    const installed = JSON.parse(readFileSync(
      new URL(`../node_modules/${name}/package.json`, import.meta.url),
      'utf8',
    ))
    expect(installed.version).toBe(legacyVersion)
  })
})
