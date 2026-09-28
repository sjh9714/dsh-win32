import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { missingOfficialRuntimePeers } from '../scripts/official-runtime-peers.mjs'

const roots: string[] = []
const script = fileURLToPath(new URL('../scripts/official-runtime-peers.mjs', import.meta.url))
const scope = '@deepseek-ai/'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-official-peers-'))
  roots.push(root)
  const install = join(root, 'isolated host')
  const add = (name: string, fields: object = {}, directory = install) => {
    const path = join(directory, 'node_modules', scope, name, 'package.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ name: scope + name, version: '0.1.7-rc.2', ...fields }))
    return path
  }
  const dsh = add('dsh', { dependencies: { [scope + 'dsh-tools']: '0.1.7-rc.2' } })
  add('dsh-tools')
  return { root, install, add, dsh }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('installed official npm runtime peers', () => {
  it('uses the current tools peer contract without requesting the unpublished code-runtime release', () => {
    const { add, dsh } = fixture()
    add('dsh-tools', { peerDependencies: {
      [scope + 'dsh-invariants']: '0.1.7-rc.2',
      [scope + 'dsh-scope']: '0.1.7-rc.2',
      [scope + 'dsh-ptc-runtime']: '0.1.7-rc.2',
      [scope + 'dsh-sandbox']: '0.1.7-rc.2',
    } })
    const peers = missingOfficialRuntimePeers(dsh)
    expect(peers).toEqual([
      scope + 'dsh-invariants@0.1.7-rc.2', scope + 'dsh-ptc-runtime@0.1.7-rc.2',
      scope + 'dsh-sandbox@0.1.7-rc.2', scope + 'dsh-scope@0.1.7-rc.2',
    ])
    expect(peers.some((peer: string) => peer.includes('dsh-code-runtime'))).toBe(false)
  })

  it('retains an older declared code-runtime range instead of copying the root version', () => {
    const { add, dsh } = fixture()
    add('dsh-tools', { version: '0.1.5-rc.3', peerDependencies: { [scope + 'dsh-code-runtime']: '^0.1.5-rc.3' } })
    expect(missingOfficialRuntimePeers(dsh)).toEqual([scope + 'dsh-code-runtime@^0.1.5-rc.3'])
  })

  it('walks installed peers and dependencies, deduplicates requirements, and terminates cycles', () => {
    const { add, dsh } = fixture()
    add('dsh-tools', { peerDependencies: { [scope + 'dsh-scope']: '0.1.7-rc.2', [scope + 'dsh-invariants']: '0.1.7-rc.2' } })
    add('dsh-scope', { peerDependencies: { [scope + 'dsh-tools']: '0.1.7-rc.2', [scope + 'dsh-invariants']: '0.1.7-rc.2' } })
    expect(missingOfficialRuntimePeers(dsh)).toEqual([scope + 'dsh-invariants@0.1.7-rc.2'])
    add('dsh-invariants')
    expect(missingOfficialRuntimePeers(dsh)).toEqual([])
  })

  it('discovers an added peer in the next bounded installation round', () => {
    const { add, dsh } = fixture()
    add('dsh-tools', { peerDependencies: { [scope + 'dsh-ptc-runtime']: '0.1.7-rc.2' } })
    expect(missingOfficialRuntimePeers(dsh)).toEqual([scope + 'dsh-ptc-runtime@0.1.7-rc.2'])
    add('dsh-ptc-runtime', { peerDependencies: { [scope + 'dsh-output-retention']: '0.1.7-rc.2' } })
    expect(missingOfficialRuntimePeers(dsh)).toEqual([scope + 'dsh-output-retention@0.1.7-rc.2'])
    add('dsh-output-retention')
    expect(missingOfficialRuntimePeers(dsh)).toEqual([])
  })

  it('does not add optional peers or unrelated packages', () => {
    const { add, dsh } = fixture()
    add('dsh-tools', { peerDependencies: { [scope + 'dsh-workspace']: '0.1.7-rc.2', unrelated: 'latest' },
      peerDependenciesMeta: { [scope + 'dsh-workspace']: { optional: true } } })
    add('dsh-unrelated', { peerDependencies: { [scope + 'dsh-code-runtime']: '0.1.7-rc.2' } })
    expect(missingOfficialRuntimePeers(dsh)).toEqual([])
  })

  it.each(['latest', '*', 'file:../other', 'npm:other@1.0.0', 'https://example.invalid/pkg.tgz'])(
    'rejects a missing peer with unsupported spec %s', spec => {
      const { add, dsh } = fixture()
      add('dsh-tools', { peerDependencies: { [scope + 'dsh-scope']: spec } })
      expect(() => missingOfficialRuntimePeers(dsh)).toThrow('unsupported runtime peer declaration')
    },
  )

  it('fails on conflicting missing peer specs instead of silently choosing one', () => {
    const { add, dsh } = fixture()
    add('dsh-tools', { dependencies: { [scope + 'dsh-agent']: '0.1.7-rc.2' }, peerDependencies: { [scope + 'dsh-scope']: '0.1.7-rc.2' } })
    add('dsh-agent', { peerDependencies: { [scope + 'dsh-scope']: '0.1.5-rc.3' } })
    expect(() => missingOfficialRuntimePeers(dsh)).toThrow('conflicting runtime peer declarations')
  })

  it('does not hide missing ordinary dependencies as peer repair', () => {
    const { add, dsh } = fixture()
    add('dsh-tools', { dependencies: { [scope + 'dsh-brand']: '0.1.7-rc.2' } })
    expect(() => missingOfficialRuntimePeers(dsh)).toThrow('missing its installed dependency')
  })

  it('rejects packages resolved from outside the isolated installation', () => {
    const { root, add, dsh } = fixture()
    add('dsh-tools', { peerDependencies: { [scope + 'dsh-scope']: '0.1.7-rc.2' } })
    add('dsh-scope', {}, root)
    expect(() => missingOfficialRuntimePeers(dsh)).toThrow('outside the selected DSH installation')
  })

  it('rejects a package with the wrong identity', () => {
    const { add, dsh } = fixture()
    add('dsh-tools', { name: scope + 'dsh-other' })
    expect(() => missingOfficialRuntimePeers(dsh)).toThrow('invalid installed package identity')
  })

  it('only reads manifests and prints one install argument per line', () => {
    const { add, dsh, install } = fixture()
    add('dsh-tools', { main: 'index.js', peerDependencies: { [scope + 'dsh-scope']: '~0.1.7-rc.2' } })
    writeFileSync(join(install, 'node_modules', scope, 'dsh-tools', 'index.js'), 'throw new Error("must not execute package code")')
    const result = spawnSync(process.execPath, [script, dsh], { encoding: 'utf8', timeout: 10_000 })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(scope + 'dsh-scope@~0.1.7-rc.2\n')
    expect(result.stderr).toBe('')
  })

  it('emits no install arguments on malformed input and exits nonzero', () => {
    const { dsh } = fixture()
    writeFileSync(dsh, '{')
    const result = spawnSync(process.execPath, [script, dsh], { encoding: 'utf8', timeout: 10_000 })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
