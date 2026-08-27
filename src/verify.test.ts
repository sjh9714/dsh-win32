import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  findInstalledDsh,
  isolatedEnvironment,
  resolveInstalledTree,
  runWorker,
  supportsDshNode,
  terminateLiveWorkerChild,
  verifyInstalledStack,
  type VerifyDependencies,
  type VerifyReport,
  type WorkerInput,
} from './verify.ts'

const boundary = 'fake official component boundary'
const dshDirect = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-pwsh-persistent',
]
const baseComponents = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
]

function writePackage(root: string, name: string, extra: Record<string, unknown> = {}): string {
  const directory = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'index.js'), 'export default class Fixture {}\n')
  const manifest = join(directory, 'package.json')
  writeFileSync(manifest, JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    exports: { '.': './index.js', './package.json': './package.json' },
    ...extra,
  }))
  return manifest
}

function writeInstalledTree(root: string, { components = true }: { components?: boolean } = {}): string {
  const versions = (names: string[]): Record<string, string> => Object.fromEntries(names.map(name => [name, '1.0.0']))
  const selected = writePackage(root, '@deepseek-ai/dsh', {
    dependencies: { '@deepseek-ai/dsh-base': '1.0.0', ...versions(dshDirect) },
  })
  writePackage(root, '@deepseek-ai/dsh-base', { dependencies: versions(baseComponents) })
  if (components) for (const name of [...dshDirect, ...baseComponents]) writePackage(root, name)
  return selected
}

function workerPass(): VerifyReport {
  return {
    schema: 'dsh-win32/verify/v1',
    status: 'pass',
    ok: true,
    boundary,
    installedDshVersion: '0.1.1-rc.2',
    checks: [{ name: 'live', status: 'pass', detail: 'fake live chain passed' }],
  }
}

function fakeDependencies(overrides: Partial<VerifyDependencies> = {}): VerifyDependencies {
  const root = join(tmpdir(), `dsh-win32-fake-root-${process.pid}-${Math.random().toString(16).slice(2)}`)
  return {
    platform: 'win32',
    nodeVersion: '22.19.0',
    findInstalledDsh: () => ({
      packageJson: join(root, 'installed', 'package.json'),
      version: '0.1.1-rc.2',
      source: 'shared-profile',
    }),
    makeDirectories: () => ({
      root,
      home: join(root, 'home'),
      workspace: join(root, 'workspace'),
      stateDirectory: join(root, 'workspace', 'state'),
      outsideFile: join(root, 'outside.txt'),
      runtimeTemp: join(root, 'runtime-temp'),
    }),
    runWorker: async () => workerPass(),
    cleanup: () => {},
    ...overrides,
  }
}

describe('verify runtime eligibility', () => {
  it('supports the declared DSH Node lines but not Node 23', () => {
    expect(supportsDshNode('22.18.0')).toBe(false)
    expect(supportsDshNode('22.19.0')).toBe(true)
    expect(supportsDshNode('23.11.1')).toBe(false)
    expect(supportsDshNode('24.0.0')).toBe(true)
  })

  it('returns unsupported before installation discovery off Windows', async () => {
    const discover = vi.fn()
    const report = await verifyInstalledStack({}, fakeDependencies({ platform: 'darwin', findInstalledDsh: discover }))
    expect(report.status).toBe('unsupported')
    expect(report.reason).toBe('native Windows only')
    expect(report.boundary).toContain('plugin installer')
    expect(report.boundary).toContain('hook bridges')
    expect(discover).not.toHaveBeenCalled()
  })

  it('returns unsupported for Node 23 before creating temporary state', async () => {
    const makeDirectories = vi.fn()
    const report = await verifyInstalledStack({}, fakeDependencies({ nodeVersion: '23.4.0', makeDirectories }))
    expect(report.status).toBe('unsupported')
    expect(makeDirectories).not.toHaveBeenCalled()
  })
})

describe('verify isolation orchestration with fakes', () => {
  it('finds the shared profiles/node_modules DSH layout used by current installs', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-shared-profile-'))
    const manifest = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    mkdirSync(join(manifest, '..'), { recursive: true })
    writeFileSync(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.8.7' }))
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('DSH_WIN32_VERIFY_DSH', '')
    try {
      const installed = findInstalledDsh('web')
      expect(installed?.version).toBe('9.8.7')
      expect(installed?.source).toBe('shared-profile')
      expect(installed?.packageJson).toBe(realpathSync(manifest))
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('resolves every component through its one declared canonical owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-win32-owner-tree-'))
    try {
      const selected = writeInstalledTree(root)
      const tree = resolveInstalledTree(selected)
      expect(tree.selectedManifestPath).toBe(realpathSync(selected))
      expect(tree.components['@deepseek-ai/cordis'].owner).toBe('@deepseek-ai/dsh')
      expect(tree.components['@deepseek-ai/dsh-tools'].owner).toBe('@deepseek-ai/dsh-base')
      expect(Object.keys(tree.components)).toHaveLength(dshDirect.length + baseComponents.length)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a component borrowed from the dsh-win32 development tree', () => {
    // Nest beneath the repository so ordinary Node fallback can see the
    // repository's own @deepseek-ai/cordis. The selected fixture deliberately
    // omits it; canonical boundary validation must reject that ambient copy.
    const root = mkdtempSync(join(process.cwd(), '.dsh-win32-ambient-fixture-'))
    try {
      const selected = writeInstalledTree(root, { components: false })
      expect(() => resolveInstalledTree(selected)).toThrow(/outside the selected installation boundary/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('passes only Windows runtime and locale facts into the isolated worker', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-win32-env-'))
    const input: WorkerInput = {
      root,
      home: join(root, 'home'),
      workspace: join(root, 'workspace'),
      stateDirectory: join(root, 'workspace', 'state'),
      outsideFile: join(root, 'outside.txt'),
      runtimeTemp: join(root, 'runtime-temp'),
      packageJson: join(root, 'installed', 'package.json'),
    }
    mkdirSync(input.runtimeTemp, { recursive: true })
    try {
      const env = isolatedEnvironment(input, {
        Path: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
        LC_SECRET: 'must-not-pass',
        DATABASE_URL: 'postgres://secret',
        PRIVATE_KEY: 'private',
        SESSION_COOKIE: 'cookie',
        JWT: 'jwt',
        NODE_PATH: 'C:\\ambient',
        NODE_OPTIONS: '--require=C:\\hook.js',
        NODE_V8_COVERAGE: 'C:\\coverage',
        NODE_COMPILE_CACHE: 'C:\\cache',
        npm_config_userconfig: 'C:\\secret-npmrc',
        HOMEDRIVE: 'Z:',
        HOMEPATH: '\\real-user',
      })
      expect(env.Path).toBe('C:\\Windows\\System32')
      expect(env.SystemRoot).toBe('C:\\Windows')
      expect(env.LANG).toBe('en_US.UTF-8')
      expect(env.LC_ALL).toBe('C')
      expect(env.LC_SECRET).toBeUndefined()
      for (const key of [
        'DATABASE_URL', 'PRIVATE_KEY', 'SESSION_COOKIE', 'JWT',
        'NODE_PATH', 'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'NODE_COMPILE_CACHE',
        'npm_config_userconfig',
      ]) expect(env[key]).toBeUndefined()
      expect(Object.keys(env).filter(key => /^NODE_/i.test(key))).toEqual([])
      expect(env.HOME).toBe(input.home)
      expect(env.USERPROFILE).toBe(input.home)
      expect(env.HOMEDRIVE).not.toBe('Z:')
      expect(env.HOMEPATH).not.toBe('\\real-user')
      expect(env.TEMP).toBe(input.runtimeTemp)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('signals only an unsettled retained child handle', () => {
    const kill = vi.fn(() => true)
    expect(terminateLiveWorkerChild({ exitCode: null, signalCode: null, kill }, false)).toBe(true)
    expect(kill).toHaveBeenCalledOnce()

    kill.mockClear()
    expect(terminateLiveWorkerChild({ exitCode: 0, signalCode: null, kill }, false)).toBe(false)
    expect(terminateLiveWorkerChild({ exitCode: null, signalCode: 'SIGTERM', kill }, false)).toBe(false)
    expect(terminateLiveWorkerChild({ exitCode: null, signalCode: null, kill }, true)).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })

  it('settles after a bounded post-kill grace and preserves an uncontained snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-win32-unclosed-worker-'))
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdout,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
      unref: vi.fn(),
    })
    const cleanup = vi.fn()
    try {
      const reportPromise = verifyInstalledStack({}, fakeDependencies({
        makeDirectories: () => ({
          root,
          home: join(root, 'home'),
          workspace: join(root, 'workspace'),
          stateDirectory: join(root, 'workspace', 'state'),
          outsideFile: join(root, 'outside.txt'),
          runtimeTemp: join(root, 'runtime-temp'),
        }),
        runWorker: input => runWorker(input, {
          spawnWorker: (() => child) as unknown as typeof spawn,
          timeoutMs: 5,
          postKillGraceMs: 10,
        }),
        cleanup,
      }))
      const report = await Promise.race([
        reportPromise,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('worker promise did not settle')), 500)),
      ])

      expect(child.kill).toHaveBeenCalledOnce()
      expect(child.unref).toHaveBeenCalledOnce()
      expect(stdout.destroyed).toBe(true)
      expect(cleanup).not.toHaveBeenCalled()
      expect(report.status).toBe('fail')
      expect(report.checks.some(check => check.name === 'worker_timeout')).toBe(true)
      expect(report.checks.at(-1)).toEqual({
        name: 'temporary_snapshot_preserved',
        status: 'fail',
        detail: 'isolated snapshot preserved because temporary-root and descendant containment could not be confirmed',
      })
      expect(report.checks.some(check => check.name === 'temporary_cleanup')).toBe(false)
    } finally {
      // The production orchestrator intentionally preserves this state. The
      // unit-test fixture removes its own synthetic snapshot after assertions.
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves the snapshot when the worker emits an error after timeout signaling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-win32-errored-worker-'))
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit('error', new Error('post-timeout worker error')))
        return true
      }),
      unref: vi.fn(),
    })
    const cleanup = vi.fn()
    try {
      const report = await verifyInstalledStack({}, fakeDependencies({
        makeDirectories: () => ({
          root,
          home: join(root, 'home'),
          workspace: join(root, 'workspace'),
          stateDirectory: join(root, 'workspace', 'state'),
          outsideFile: join(root, 'outside.txt'),
          runtimeTemp: join(root, 'runtime-temp'),
        }),
        runWorker: input => runWorker(input, {
          spawnWorker: (() => child) as unknown as typeof spawn,
          timeoutMs: 5,
          postKillGraceMs: 100,
        }),
        cleanup,
      }))

      expect(cleanup).not.toHaveBeenCalled()
      expect(report.checks.map(check => check.name)).toEqual([
        'worker_timeout',
        'temporary_snapshot_preserved',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the selected installed identity and reports cleanup only after it succeeds', async () => {
    const cleanup = vi.fn()
    const runWorker = vi.fn(async () => workerPass())
    const report = await verifyInstalledStack({ profile: 'desktop' }, fakeDependencies({ cleanup, runWorker }))

    expect(report.status).toBe('pass')
    expect(report.installedDshVersion).toBe('0.1.1-rc.2')
    expect(report.installedDshSource).toBe('shared-profile')
    expect(report.checks.at(-1)).toEqual({
      name: 'temporary_cleanup',
      status: 'pass',
      detail: 'isolated home and workspace removed',
    })
    expect(runWorker).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('redacts worker failures and still cleans the temporary root', async () => {
    const cleanup = vi.fn()
    const runWorker = vi.fn(async () => { throw new Error('secret C:\\Users\\private\\workspace') })
    const report = await verifyInstalledStack({}, fakeDependencies({ cleanup, runWorker }))

    expect(report.status).toBe('fail')
    expect(JSON.stringify(report)).not.toContain('private')
    expect(JSON.stringify(report)).not.toContain('secret')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(report.checks.some(check => check.name === 'temporary_cleanup' && check.status === 'pass')).toBe(true)
  })

  it('cannot pass when cleanup reports failure', async () => {
    const report = await verifyInstalledStack({}, fakeDependencies({ cleanup: () => { throw new Error('busy') } }))
    expect(report.status).toBe('fail')
    expect(report.ok).toBe(false)
    expect(report.checks.at(-1)?.name).toBe('temporary_cleanup')
    expect(report.checks.at(-1)?.status).toBe('fail')
  })
})
