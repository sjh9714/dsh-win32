import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runPreflight, unmetRequirements, type PreflightDependencies } from './preflight.ts'

const DSH = '@deepseek-ai/dsh'
// Requirements published by real plugins, so the fixtures replay real upgrades.
const FIND_PLUGIN = {
  name: 'dsh-find-plugin',
  version: '0.4.0',
  peerDependencies: {
    '@deepseek-ai/cordis': '^4.0.1',
    '@deepseek-ai/dsh-tools': '^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.2 || ^0.1.3-alpha.2 || ^0.1.5-alpha.1 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1',
  },
}
const PLUGIN_GUIDE = {
  name: 'dsh-plugin-guide',
  version: '0.3.39',
  engines: { dsh: '>=0.2.1-0 <0.3.0', node: '^22.19.0 || >=24.0.0' },
  peerDependencies: { [DSH]: '>=0.1.2-rc.1 <0.2.0' },
}

function profileHome(dependencies: Record<string, unknown>, files: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-win32-preflight-'))
  const dir = join(home, 'profiles', 'web')
  const manifests = Object.fromEntries(Object.entries(dependencies)
    .filter(([, manifest]) => manifest !== undefined)
    .map(([name, manifest]) => [`node_modules/${name}/package.json`, JSON.stringify(manifest)]))
  const all = { 'package.json': JSON.stringify({ dependencies: Object.fromEntries(Object.keys(dependencies).map(name => [name, '*'])) }), ...manifests, ...files }
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  return home
}

function deps(overrides: Partial<PreflightDependencies> & { meta?: unknown, latest?: Record<string, unknown> } = {}): PreflightDependencies {
  const { meta = { version: '0.2.1-rc.5' }, latest = {}, ...rest } = overrides
  return {
    view: spec => spec.startsWith(`${DSH}@`) ? meta : latest[spec],
    installedVersion: () => '0.2.1-rc.4',
    nodeVersion: '24.10.0',
    ...rest,
  }
}

function check(report: ReturnType<typeof runPreflight>, name: string) {
  return report.checks.find(entry => entry.name === name)
}

describe('unmetRequirements', () => {
  it('rejects a ^0.1.x plugin on a 0.2 runtime, the gate added in 0.2.0-rc.1', () => {
    expect(unmetRequirements(FIND_PLUGIN, '0.2.1-rc.5')).toEqual({
      '@deepseek-ai/dsh-tools': FIND_PLUGIN.peerDependencies['@deepseek-ai/dsh-tools'],
    })
  })

  it('lets engines.dsh decide alone even when a peer would refuse', () => {
    expect(unmetRequirements(PLUGIN_GUIDE, '0.2.1-rc.5')).toEqual({})
    expect(unmetRequirements(PLUGIN_GUIDE, '0.3.0')).toEqual({ 'engines.dsh': '>=0.2.1-0 <0.3.0' })
  })

  it('keeps the prerelease trap: ^0.1.7 does not accept 0.1.7-rc.1', () => {
    expect(unmetRequirements({ peerDependencies: { [DSH]: '^0.1.7' } }, '0.1.7-rc.1')).toEqual({ [DSH]: '^0.1.7' })
    expect(unmetRequirements({ peerDependencies: { [DSH]: '>=0.1.7-0' } }, '0.1.7-rc.1')).toEqual({})
  })

  it('ignores non-DSH peers and reads workspace peers as the runtime', () => {
    expect(unmetRequirements({ peerDependencies: { '@deepseek-ai/cordis': '^1', [DSH]: 'workspace:^' } }, '0.2.0')).toEqual({})
  })

  it('treats a workspace engines.dsh and empty ranges as unmet', () => {
    expect(unmetRequirements({ engines: { dsh: 'workspace:^' } }, '0.2.0')).toEqual({ 'engines.dsh': 'workspace:^' })
    expect(unmetRequirements({ peerDependencies: { [DSH]: ' ' } }, '0.2.0')).toEqual({ [DSH]: ' ' })
  })

  it('throws for fields the host refuses as unreadable', () => {
    expect(() => unmetRequirements({ engines: 'x' }, '0.2.0')).toThrow('engines must be an object')
    expect(() => unmetRequirements({ engines: { dsh: 1 } }, '0.2.0')).toThrow('engines.dsh must be a string')
    expect(() => unmetRequirements({ peerDependencies: { [DSH]: 1 } }, '0.2.0')).toThrow('must be a string')
  })
})

describe('runPreflight', () => {
  it('passes a compatible profile with exit 0', () => {
    const report = runPreflight({ home: profileHome({ [PLUGIN_GUIDE.name]: PLUGIN_GUIDE }) }, deps({ meta: { version: '0.2.1-rc.5', engines: { node: '>=22' } } }))
    expect(report).toMatchObject({ schema: 'dsh-preflight/v1', exitCode: 0, ok: true, installed: '0.2.1-rc.4', target: { requested: 'latest', resolved: '0.2.1-rc.5' } })
    expect(check(report, 'plugins')?.status).toBe('pass')
  })

  it('accepts the bare string npm prints when a release has no engines', () => {
    const report = runPreflight({ home: profileHome({}) }, deps({ meta: '0.2.1-rc.5' }))
    expect(report.target.resolved).toBe('0.2.1-rc.5')
    expect(check(report, 'node')).toMatchObject({ status: 'pass', detail: expect.stringContaining('baseline') })
  })

  it('warns rather than fails when only the baseline rejects Node', () => {
    const report = runPreflight({ home: profileHome({}) }, deps({ meta: '0.2.1-rc.5', nodeVersion: '20.0.0' }))
    expect(check(report, 'node')?.status).toBe('warn')
    expect(report.exitCode).toBe(1)
  })

  it('fails on the Node floor the target declares, the 0.2.2-alpha.2 break', () => {
    const report = runPreflight({ home: profileHome({}) }, deps({ meta: { version: '0.2.2-alpha.2', engines: { node: '>=24.9.0' } }, nodeVersion: '22.19.0' }))
    expect(check(report, 'node')?.status).toBe('fail')
    expect(report.exitCode).toBe(2)
  })

  it('offers the newest plugin release when it fits the target', () => {
    const report = runPreflight({ home: profileHome({ [FIND_PLUGIN.name]: FIND_PLUGIN }) }, deps({
      latest: { [`${FIND_PLUGIN.name}@latest`]: { version: '0.5.0', engines: { dsh: '>=0.2.0-0' } } },
    }))
    expect(check(report, `plugin:${FIND_PLUGIN.name}`)).toMatchObject({ status: 'fail', fix: expect.stringContaining('dsh plugin --profile web add dsh-find-plugin@0.5.0') })
    expect(check(report, 'plugins')?.status).toBe('fail')
    expect(report.exitCode).toBe(2)
  })

  it('says to postpone when no release fits, and pins the installed version', () => {
    const report = runPreflight({ home: profileHome({ [FIND_PLUGIN.name]: FIND_PLUGIN }) }, deps({
      latest: { [`${FIND_PLUGIN.name}@latest`]: { version: FIND_PLUGIN.version, peerDependencies: FIND_PLUGIN.peerDependencies } },
    }))
    expect(check(report, `plugin:${FIND_PLUGIN.name}`)?.fix).toContain(`npm install -g ${DSH}@0.2.1-rc.4`)
  })

  it('keeps the verdict when the plugin lookup fails', () => {
    const report = runPreflight({ home: profileHome({ [FIND_PLUGIN.name]: FIND_PLUGIN }) }, deps())
    expect(check(report, `plugin:${FIND_PLUGIN.name}`)).toMatchObject({ status: 'fail', fix: expect.stringContaining('update the plugin') })
  })

  it('never carries an exemption from another runtime to the target', () => {
    const key = `${FIND_PLUGIN.name}@${FIND_PLUGIN.version}`
    const home = profileHome({ [FIND_PLUGIN.name]: FIND_PLUGIN }, { 'compatibility.json': JSON.stringify({ [key]: ['0.2.1-rc.4'] }) })
    expect(check(runPreflight({ home }, deps()), `plugin:${FIND_PLUGIN.name}`)?.status).toBe('fail')
  })

  it('downgrades to a warning for an exemption naming the exact target', () => {
    const key = `${FIND_PLUGIN.name}@${FIND_PLUGIN.version}`
    const home = profileHome({ [FIND_PLUGIN.name]: FIND_PLUGIN }, { 'compatibility.json': JSON.stringify({ [key]: ['0.2.1-rc.5'] }) })
    const report = runPreflight({ home }, deps())
    expect(check(report, `plugin:${FIND_PLUGIN.name}`)?.status).toBe('warn')
    expect(check(report, 'plugins')?.status).toBe('warn')
    expect(report.exitCode).toBe(1)
  })

  it('applies no exemption from an unparsable file, and says so', () => {
    const home = profileHome({ [FIND_PLUGIN.name]: FIND_PLUGIN }, { 'compatibility.json': '{' })
    const report = runPreflight({ home }, deps())
    expect(check(report, 'compatibility_file')?.status).toBe('warn')
    expect(check(report, `plugin:${FIND_PLUGIN.name}`)?.status).toBe('fail')
  })

  it('excludes official packages and warns about a plugin it cannot read', () => {
    const report = runPreflight({ home: profileHome({ '@deepseek-ai/dsh-old': { peerDependencies: { [DSH]: '0.0.1' } }, missing: undefined }) }, deps())
    expect(check(report, 'plugin:@deepseek-ai/dsh-old')).toBeUndefined()
    expect(check(report, 'plugin:missing')?.status).toBe('warn')
    expect(check(report, 'plugins')?.detail).toContain('1 checked')
  })

  it('refuses to follow a traversal in a dependency key', () => {
    const report = runPreflight({ home: profileHome({ '../../outside': undefined }) }, deps())
    expect(check(report, 'plugin:../../outside')?.status).toBe('warn')
  })

  it('fails a malformed plugin manifest the host would refuse', () => {
    const report = runPreflight({ home: profileHome({ bad: { name: 'bad', version: '1.0.0', engines: 'x' } }) }, deps())
    expect(check(report, 'plugin:bad')?.status).toBe('fail')
  })

  it.each([
    ['a failed registry lookup', undefined, 'could not read'],
    ['a range that matches several releases', [{ version: '0.2.0' }, { version: '0.2.1' }], 'more than one'],
    ['a malformed answer', { version: 'nope' }, 'did not resolve'],
  ])('fails closed on %s', (_, meta, message) => {
    const view = () => meta
    const report = runPreflight({ home: profileHome({}) }, deps({ view }))
    expect(check(report, 'target')).toMatchObject({ status: 'fail', detail: expect.stringContaining(message) })
    expect(check(report, 'plugins')?.status).toBe('skip')
    expect(report.exitCode).toBe(2)
  })

  it.each(['^0.2.0', '>=0', 'a b', 'x&calc', '--registry=evil'])('rejects %s before it reaches npm', target => {
    const report = runPreflight({ home: profileHome({}), target }, deps({ view: () => { throw new Error('must not run') } }))
    expect(report.exitCode).toBe(2)
  })

  it('fails closed on a missing profile', () => {
    const report = runPreflight({ home: mkdtempSync(join(tmpdir(), 'dsh-win32-preflight-')) }, deps())
    expect(check(report, 'profile')?.status).toBe('fail')
    expect(report.exitCode).toBe(2)
  })

  it('does not leak profile content from invalid JSON', () => {
    const report = runPreflight({ home: profileHome({}, { 'package.json': '{"secret":"do-not-print"' }) }, deps())
    expect(JSON.stringify(report)).not.toContain('do-not-print')
    expect(check(report, 'profile')?.detail).toContain('invalid JSON')
  })

  it('warns only for release rules this upgrade crosses', () => {
    const report = runPreflight({ home: profileHome({}), target: '0.2.2-alpha.2' }, deps({ meta: { version: '0.2.2-alpha.2' }, installedVersion: () => '0.2.1-alpha.2' }))
    expect(check(report, 'saved_models')?.status).toBe('skip')
    expect(check(report, 'api_key_source')?.status).toBe('warn')
    expect(check(report, 'ssh_protocol')?.status).toBe('warn')
  })

  it('skips release rules but still judges plugins without an installed DSH', () => {
    const report = runPreflight({ home: profileHome({ [FIND_PLUGIN.name]: FIND_PLUGIN }) }, deps({ installedVersion: () => undefined }))
    expect(report.installed).toBeUndefined()
    expect(check(report, 'installed_dsh')?.status).toBe('warn')
    expect(check(report, 'ssh_protocol')?.status).toBe('skip')
    expect(check(report, `plugin:${FIND_PLUGIN.name}`)).toMatchObject({ status: 'fail', fix: expect.stringContaining('postpone this upgrade') })
  })

  it('skips Windows checks elsewhere and reports them on Windows', () => {
    expect(check(runPreflight({ home: profileHome({}) }, deps()), 'powershell')?.status).toBe('skip')
    const report = runPreflight({ home: profileHome({}) }, deps({ windows: { pwsh: 'C:\\pwsh.exe' } }))
    expect(check(report, 'powershell')?.status).toBe('pass')
    expect(check(report, 'path')?.status).toBe('warn')
  })
})
