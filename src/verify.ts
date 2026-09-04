/**
 * Destructive-model-free acceptance check for the installed official DSH
 * PowerShell stack. The parent owns isolation and cleanup; the worker loads
 * every DSH component through one installed @deepseek-ai/dsh package tree.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import { execFileSync } from 'node:child_process'

export type VerifyCheckStatus = 'pass' | 'fail'

export interface VerifyCheck {
  name: string
  status: VerifyCheckStatus
  detail: string
}

export interface VerifyReport {
  schema: 'dsh-win32/verify/v1'
  status: 'pass' | 'fail' | 'unsupported'
  ok: boolean
  boundary: string
  installedDshVersion?: string
  installedDshSource?: 'explicit' | 'shared-profile' | 'profile' | 'workspace' | 'package-tree' | 'global' | 'npx-cache'
  checks: VerifyCheck[]
  reason?: string
}

export interface InstalledDsh {
  packageJson: string
  version: string
  source: NonNullable<VerifyReport['installedDshSource']>
}

export interface VerifyDirectories {
  root: string
  home: string
  workspace: string
  stateDirectory: string
  outsideFile: string
  runtimeTemp: string
}

export interface WorkerInput extends VerifyDirectories {
  packageJson: string
}

export interface VerifyDependencies {
  platform: string
  nodeVersion: string
  findInstalledDsh: (profile: string) => InstalledDsh | undefined
  makeDirectories: () => VerifyDirectories
  runWorker: (input: WorkerInput) => Promise<VerifyReport>
  cleanup: (root: string) => void
}

const BOUNDARY = 'the installed model-facing persistent PowerShell tool over the official terminal, subprocess, policy, and local sandbox components; the stock Minimal host/preset, plugin installer, and hook bridges are not exercised'
const VERIFY_PROGRESS_FILE = 'worker-progress.json'
const VERIFY_PROGRESS_STAGES = [
  'worker_started',
  'installed_tree_validated',
  'outside_control_passed',
  'official_components_starting',
  'official_components_composed',
  'powershell_launch_starting',
  'powershell_launched',
  'persistent_state_passed',
  'workspace_write_passed',
  'outside_write_blocked',
  'denial_recovery_passed',
  'cancellation_recovery_passed',
  'repeat_lifecycle_passed',
  'runtime_teardown_starting',
  'worker_finished',
] as const
type VerifyProgressStage = typeof VERIFY_PROGRESS_STAGES[number]
const VERIFY_PROGRESS_STAGE_SET = new Set<string>(VERIFY_PROGRESS_STAGES)
const OFFICIAL_DECLARATIONS = [
  '@deepseek-ai/dsh-tool-pwsh-persistent',
  '@deepseek-ai/dsh-pwsh-local',
  '@deepseek-ai/dsh-pwsh-sandbox',
] as const
const DSH_DIRECT_COMPONENTS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-pwsh-persistent',
] as const
const BASE_COMPONENTS = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
] as const
type LiveComponent = typeof DSH_DIRECT_COMPONENTS[number] | typeof BASE_COMPONENTS[number]

function unsupported(reason: string): VerifyReport {
  return { schema: 'dsh-win32/verify/v1', status: 'unsupported', ok: false, boundary: BOUNDARY, checks: [], reason }
}

function failed(name: string, detail: string, installedDshVersion?: string): VerifyReport {
  return {
    schema: 'dsh-win32/verify/v1',
    status: 'fail',
    ok: false,
    boundary: BOUNDARY,
    ...(installedDshVersion === undefined ? {} : { installedDshVersion }),
    checks: [{ name, status: 'fail', detail }],
  }
}

/** DSH supports Node 22.19+, skips 23, and supports 24+. */
export function supportsDshNode(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return (major === 22 && minor >= 19) || major >= 24
}

function readInstalledDsh(packageJson: string, source: InstalledDsh['source']): InstalledDsh | undefined {
  try {
    const canonical = realpathSync(packageJson)
    const manifest = JSON.parse(readFileSync(canonical, 'utf8')) as { name?: unknown; version?: unknown }
    if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string') return undefined
    return { packageJson: canonical, version: manifest.version, source }
  } catch {
    return undefined
  }
}

function packageCandidate(path: string): string {
  return basename(path).toLowerCase() === 'package.json' ? path : join(path, 'package.json')
}

function ancestorCandidates(start: string): string[] {
  const candidates: string[] = []
  let current = resolve(start)
  for (;;) {
    candidates.push(join(current, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    const parent = dirname(current)
    if (parent === current) return candidates
    current = parent
  }
}

function commandOutput(file: string, args: string[]): string | undefined {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
      timeout: 10_000,
    }).trim()
  } catch {
    return undefined
  }
}

/** Locate only already-installed DSH trees. This never consults the registry. */
export function findInstalledDsh(profile = 'web'): InstalledDsh | undefined {
  const candidates: Array<{ path: string; source: InstalledDsh['source'] }> = []
  const override = process.env.DSH_WIN32_VERIFY_DSH
  if (override !== undefined && override !== '') candidates.push({ path: packageCandidate(override), source: 'explicit' })

  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  candidates.push({ path: join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), source: 'profile' })
  candidates.push({ path: join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), source: 'shared-profile' })
  const profiles = join(dshHome, 'profiles')
  if (existsSync(profiles)) {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push({ path: join(profiles, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), source: 'profile' })
    }
  }
  candidates.push(...ancestorCandidates(process.cwd()).map(path => ({ path, source: 'workspace' as const })))

  try {
    const require_ = createRequire(import.meta.url)
    candidates.push({ path: require_.resolve('@deepseek-ai/dsh/package.json'), source: 'package-tree' })
  } catch {
    // dsh-win32 is normally installed independently of DSH.
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const globalRoot = commandOutput(npm, ['root', '-g'])
  if (globalRoot !== undefined) candidates.push({ path: join(globalRoot, '@deepseek-ai', 'dsh', 'package.json'), source: 'global' })

  // `npx @deepseek-ai/dsh` is an installation too. Prefer the newest cache
  // entry, but never run npm install or fetch a registry manifest here.
  const npmCache = commandOutput(npm, ['config', 'get', 'cache'])
  const npxCache = npmCache === undefined ? undefined : join(npmCache, '_npx')
  if (npxCache !== undefined && existsSync(npxCache)) {
    const cached = readdirSync(npxCache, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(npxCache, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      .filter(path => existsSync(path))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    candidates.push(...cached.map(path => ({ path, source: 'npx-cache' as const })))
  }

  const seen = new Set<string>()
  for (const candidate of candidates) {
    const absolute = resolve(candidate.path)
    const installed = readInstalledDsh(absolute, candidate.source)
    if (installed === undefined || seen.has(installed.packageJson)) continue
    seen.add(installed.packageJson)
    return installed
  }
  return undefined
}

interface PackageManifest {
  name?: unknown
  version?: unknown
  dependencies?: unknown
  peerDependencies?: unknown
}

interface ResolvedOwner {
  manifestPath: string
  manifest: PackageManifest
  require: NodeJS.Require
}

export interface ResolvedInstalledComponent {
  name: LiveComponent
  version: string
  manifestPath: string
  entryPath: string
  owner: '@deepseek-ai/dsh' | '@deepseek-ai/dsh-base'
}

export interface ResolvedInstalledTree {
  selectedManifestPath: string
  selectedVersion: string
  components: Record<LiveComponent, ResolvedInstalledComponent>
}

function canonicalBoundaryFor(manifestPath: string): string {
  let current = dirname(manifestPath)
  let boundary: string | undefined
  for (;;) {
    if (basename(current).toLowerCase() === 'node_modules') boundary = current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  if (boundary === undefined) throw new Error('selected DSH is not inside one node_modules installation boundary')
  return realpathSync(boundary)
}

function isWithin(boundary: string, target: string): boolean {
  const path = relative(boundary, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function readOwner(manifestPath: string, expectedName: string, boundary: string): ResolvedOwner {
  const canonical = realpathSync(manifestPath)
  if (!isWithin(boundary, canonical)) throw new Error(`${expectedName} owner escaped the selected installation boundary`)
  const manifest = JSON.parse(readFileSync(canonical, 'utf8')) as PackageManifest
  if (manifest.name !== expectedName || typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new Error(`invalid ${expectedName} owner manifest`)
  }
  return { manifestPath: canonical, manifest, require: createRequire(canonical) }
}

function declaredBy(owner: ResolvedOwner, dependency: string, allowPeer: boolean): boolean {
  for (const field of [owner.manifest.dependencies, ...(allowPeer ? [owner.manifest.peerDependencies] : [])]) {
    if (field === null || typeof field !== 'object') continue
    const value = (field as Record<string, unknown>)[dependency]
    if (typeof value === 'string' && value.trim() !== '') return true
  }
  return false
}

function resolveOwnedComponent(
  owner: ResolvedOwner,
  ownerName: ResolvedInstalledComponent['owner'],
  name: LiveComponent,
  boundary: string,
  allowPeer: boolean,
): ResolvedInstalledComponent {
  if (!declaredBy(owner, name, allowPeer)) throw new Error(`${ownerName} does not declare ${name} on the required owner edge`)
  const manifestPath = realpathSync(owner.require.resolve(`${name}/package.json`))
  const entryPath = realpathSync(owner.require.resolve(name))
  if (!isWithin(boundary, manifestPath) || !isWithin(boundary, entryPath)) {
    throw new Error(`${name} resolved outside the selected installation boundary`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
  if (manifest.name !== name || typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new Error(`${name} owner resolution has the wrong package identity`)
  }
  const packageRoot = dirname(manifestPath)
  if (!isWithin(packageRoot, entryPath)) throw new Error(`${name} entry does not belong to its owner-resolved package`)
  const selfManifest = realpathSync(createRequire(manifestPath).resolve(`${name}/package.json`))
  if (selfManifest !== manifestPath) throw new Error(`${name} self identity differs from its owner-resolved manifest`)
  return { name, version: manifest.version, manifestPath, entryPath, owner: ownerName }
}

/**
 * Close resolution over two exact package-owner manifests. There is no
 * multi-root retry: every component must be declared by and resolve from the
 * same installed DSH or dsh-base owner edge, inside one canonical install.
 */
export function resolveInstalledTree(selectedPackageJson: string): ResolvedInstalledTree {
  const selectedManifestPath = realpathSync(selectedPackageJson)
  const boundary = canonicalBoundaryFor(selectedManifestPath)
  const dsh = readOwner(selectedManifestPath, '@deepseek-ai/dsh', boundary)
  if (!declaredBy(dsh, '@deepseek-ai/dsh-base', false)) throw new Error('@deepseek-ai/dsh does not directly declare dsh-base')
  const baseManifestPath = realpathSync(dsh.require.resolve('@deepseek-ai/dsh-base/package.json'))
  const base = readOwner(baseManifestPath, '@deepseek-ai/dsh-base', boundary)
  const entries = [
    ...DSH_DIRECT_COMPONENTS.map(name => resolveOwnedComponent(dsh, '@deepseek-ai/dsh', name, boundary, false)),
    ...BASE_COMPONENTS.map(name => resolveOwnedComponent(base, '@deepseek-ai/dsh-base', name, boundary, true)),
  ]
  const components = Object.fromEntries(entries.map(component => [component.name, component])) as ResolvedInstalledTree['components']
  // Peer imports inside each loaded package must converge on the exact
  // authoritative component selected above. A second Cordis/terminal/tools
  // copy would otherwise pass path containment but split service identity.
  for (const component of entries) {
    const componentOwner = readOwner(component.manifestPath, component.name, boundary)
    if (componentOwner.manifest.peerDependencies === null
      || typeof componentOwner.manifest.peerDependencies !== 'object') continue
    for (const peerName of Object.keys(componentOwner.manifest.peerDependencies as Record<string, unknown>)) {
      if (!Object.prototype.hasOwnProperty.call(components, peerName)) continue
      const actual = realpathSync(componentOwner.require.resolve(`${peerName}/package.json`))
      const expected = components[peerName as LiveComponent].manifestPath
      if (actual !== expected) throw new Error(`${component.name} resolves a different ${peerName} peer identity`)
    }
  }
  return {
    selectedManifestPath,
    selectedVersion: dsh.manifest.version as string,
    components,
  }
}

function makeDirectories(): VerifyDirectories {
  const root = mkdtempSync(join(tmpdir(), 'dsh-win32-verify-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const stateDirectory = join(workspace, 'state')
  const runtimeTemp = join(root, 'runtime-temp')
  for (const path of [home, workspace, stateDirectory, runtimeTemp]) mkdirSync(path, { recursive: true })
  return { root, home, workspace, stateDirectory, outsideFile: join(root, 'outside.txt'), runtimeTemp }
}

const WORKER_HOST_ENV = new Set([
  'path',
  'pathext',
  'systemroot',
  'windir',
  'comspec',
  'systemdrive',
  'programfiles',
  'programfiles(x86)',
  'programw6432',
  'commonprogramfiles',
  'commonprogramfiles(x86)',
  'commonprogramw6432',
  'os',
  'processor_architecture',
  'processor_architew6432',
  'number_of_processors',
  'lang',
  'language',
  'tz',
  'lc_all',
  'lc_collate',
  'lc_ctype',
  'lc_messages',
  'lc_monetary',
  'lc_numeric',
  'lc_time',
])

/** Preserve only process-launch, Windows runtime, architecture, and locale facts. */
export function allowlistedWorkerHostEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const normalized = key.toLowerCase()
    if (!WORKER_HOST_ENV.has(normalized)) continue
    env[key] = value
  }
  return env
}

export function isolatedEnvironment(input: WorkerInput, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = allowlistedWorkerHostEnvironment(source)
  const dshHome = join(input.home, '.dsh')
  const appData = join(input.home, 'AppData', 'Roaming')
  const localAppData = join(input.home, 'AppData', 'Local')
  const xdgConfig = join(input.home, '.config')
  const xdgCache = join(input.home, '.cache')
  const xdgData = join(input.home, '.local', 'share')
  const xdgState = join(input.home, '.local', 'state')
  for (const path of [dshHome, appData, localAppData, xdgConfig, xdgCache, xdgData, xdgState]) mkdirSync(path, { recursive: true })
  const homeRoot = parse(input.home).root
  return {
    ...env,
    HOME: input.home,
    USERPROFILE: input.home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    USERNAME: 'dsh-win32-verify',
    ...(homeRoot.length >= 2 && homeRoot[1] === ':'
      ? { HOMEDRIVE: homeRoot.slice(0, 2), HOMEPATH: input.home.slice(2) }
      : {}),
    DSH_HOME: dshHome,
    TEMP: input.runtimeTemp,
    TMP: input.runtimeTemp,
    DSH_WIN32_VERIFY_PACKAGE_JSON: input.packageJson,
    DSH_WIN32_VERIFY_ROOT: input.root,
    DSH_WIN32_VERIFY_WORKSPACE: input.workspace,
    DSH_WIN32_VERIFY_STATE_DIRECTORY: input.stateDirectory,
    DSH_WIN32_VERIFY_OUTSIDE_FILE: input.outsideFile,
    DSH_WIN32_VERIFY_PROGRESS_FILE: join(input.runtimeTemp, VERIFY_PROGRESS_FILE),
  }
}

function readWorkerProgress(runtimeTemp: string): VerifyProgressStage | undefined {
  try {
    const value = JSON.parse(readFileSync(join(runtimeTemp, VERIFY_PROGRESS_FILE), 'utf8')) as { stage?: unknown }
    return typeof value.stage === 'string' && VERIFY_PROGRESS_STAGE_SET.has(value.stage)
      ? value.stage as VerifyProgressStage
      : undefined
  } catch {
    return undefined
  }
}

interface KillableChild {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: () => boolean
}

/**
 * Signal only Node's retained child-process handle while it is observably
 * unsettled. Windows exposes no public creation-time identity that could make
 * a later PID-based taskkill immune to PID reuse, so verify deliberately never
 * performs an unrelated PID lookup or process-tree kill.
 */
export function terminateLiveWorkerChild(child: KillableChild, closeSeen: boolean): boolean {
  if (closeSeen || child.exitCode !== null || child.signalCode !== null) return false
  try {
    return child.kill()
  } catch {
    return false
  }
}

class WorkerTerminationError extends Error {
  readonly containmentUnconfirmed = true

  constructor(readonly check: 'worker_timeout' | 'worker_output_bound', readonly safeDetail: string) {
    super(check)
  }
}

interface RunWorkerOptions {
  spawnWorker?: typeof spawn
  timeoutMs?: number
  postKillGraceMs?: number
}

/** Run the isolated worker with a bounded grace period after forced termination. */
export function runWorker(input: WorkerInput, options: RunWorkerOptions = {}): Promise<VerifyReport> {
  const worker = fileURLToPath(new URL('../bin/verify-worker.mjs', import.meta.url))
  return new Promise((resolveReport, reject) => {
    const child = (options.spawnWorker ?? spawn)(process.execPath, [worker], {
      cwd: input.workspace,
      env: isolatedEnvironment(input),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    let terminationReason: 'timeout' | 'output-bound' | undefined
    let closeSeen = false
    let directChildSignaled = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let postKillTimer: NodeJS.Timeout | undefined

    const clearTimers = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (postKillTimer !== undefined) clearTimeout(postKillTimer)
    }
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimers()
      action()
    }
    const terminationError = (): WorkerTerminationError => {
      const check = terminationReason === 'output-bound' ? 'worker_output_bound' : 'worker_timeout'
      const reason = terminationReason === 'output-bound'
        ? 'the worker exceeded its output bound'
        : 'the worker timed out'
      const signal = directChildSignaled
        ? 'only its retained direct-child handle was signaled'
        : 'its retained direct-child handle could not be signaled safely'
      const lastCheckpoint = readWorkerProgress(input.runtimeTemp)
      const progress = lastCheckpoint === undefined ? '' : `; last safe worker checkpoint: ${lastCheckpoint}`
      const nestedSandboxHint = terminationReason === 'timeout'
        ? '; if verify was launched inside another Workspace Write or Windows ACL sandbox, rerun only this verify command outside that outer sandbox because verify creates and tests its own confined child'
        : ''
      return new WorkerTerminationError(
        check,
        `${reason}${progress}; ${signal}; temporary-root and descendant containment are unconfirmed${nestedSandboxHint}`,
      )
    }
    const detachUnclosedChild = (): void => {
      // Closing the parent-side pipe plus unref'ing both handles ensures an
      // uncooperative Windows descendant cannot keep this CLI alive forever.
      try {
        child.stdout.removeAllListeners('data')
        child.stdout.destroy()
        ;(child.stdout as typeof child.stdout & { unref?: () => void }).unref?.()
      } catch {
        // The stream may already be closed.
      }
      try {
        child.removeAllListeners('error')
        // A late ChildProcess error after detachment must not become an
        // uncaught EventEmitter error while the parent is reporting failure.
        child.on('error', () => {})
        child.removeAllListeners('close')
        child.unref()
      } catch {
        // Rejection below must still settle even if handle detachment fails.
      }
    }
    const rejectTermination = (detach: boolean): void => {
      if (detach) detachUnclosedChild()
      settle(() => reject(terminationError()))
    }
    const terminate = (reason: 'timeout' | 'output-bound'): void => {
      if (terminationReason !== undefined) return
      terminationReason = reason
      if (timer !== undefined) clearTimeout(timer)
      directChildSignaled = terminateLiveWorkerChild(child, closeSeen)
      postKillTimer = setTimeout(
        () => rejectTermination(true),
        options.postKillGraceMs ?? 2_000,
      )
      try {
        child.stdout.removeAllListeners('data')
        child.stdout.destroy()
      } catch {
        // The bounded grace still settles even if the pipe is already closed.
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > 128 * 1024) {
        terminate('output-bound')
        return
      }
      stdout += chunk
    })
    timer = setTimeout(() => terminate('timeout'), options.timeoutMs ?? 150_000)
    child.once('error', (error) => {
      closeSeen = true
      if (terminationReason !== undefined) return rejectTermination(true)
      child.stdout.destroy()
      settle(() => reject(error))
    })
    child.once('close', (code) => {
      closeSeen = true
      if (terminationReason !== undefined) return rejectTermination(false)
      if (code !== 0 && stdout.trim() === '') return settle(() => reject(new Error('worker exited without a report')))
      try {
        const report = JSON.parse(stdout) as VerifyReport
        if (report.schema !== 'dsh-win32/verify/v1') throw new Error('wrong worker schema')
        settle(() => resolveReport(report))
      } catch {
        settle(() => reject(new Error('worker returned an invalid report')))
      }
    })
  })
}

const DEFAULT_DEPENDENCIES: VerifyDependencies = {
  platform: process.platform,
  nodeVersion: process.versions.node,
  findInstalledDsh,
  makeDirectories,
  runWorker,
  cleanup: root => rmSync(root, { recursive: true, force: true }),
}

/** Parent-side orchestration, injectable so isolation and cleanup are unit-tested without Windows. */
export async function verifyInstalledStack(
  { profile = 'web' }: { profile?: string } = {},
  dependencies: VerifyDependencies = DEFAULT_DEPENDENCIES,
): Promise<VerifyReport> {
  if (dependencies.platform !== 'win32') return unsupported('native Windows only')
  if (!supportsDshNode(dependencies.nodeVersion)) return unsupported('requires Node 22.19+ (except Node 23) or Node 24+')

  const installed = dependencies.findInstalledDsh(profile)
  if (installed === undefined) {
    return failed('installed_dsh', 'no installed @deepseek-ai/dsh dependency tree was found; run verify from an existing DSH installation')
  }

  let directories: VerifyDirectories
  try {
    directories = dependencies.makeDirectories()
  } catch {
    return failed('isolation', 'could not create the isolated temporary home and workspace', installed.version)
  }

  let report: VerifyReport
  let preserveSnapshot = false
  try {
    report = await dependencies.runWorker({ ...directories, packageJson: installed.packageJson })
  } catch (error) {
    if (error instanceof WorkerTerminationError) {
      preserveSnapshot = error.containmentUnconfirmed
      report = failed(error.check, error.safeDetail, installed.version)
    } else {
      report = failed('official_component_chain', 'the isolated verification worker failed without a usable report', installed.version)
    }
  }

  if (preserveSnapshot) {
    report.checks.push({
      name: 'temporary_snapshot_preserved',
      status: 'fail',
      detail: 'isolated snapshot preserved because temporary-root and descendant containment could not be confirmed',
    })
  } else {
    try {
      dependencies.cleanup(directories.root)
      if (existsSync(directories.root)) throw new Error('temporary root remains')
      report.checks.push({ name: 'temporary_cleanup', status: 'pass', detail: 'isolated home and workspace removed' })
    } catch {
      report.checks.push({ name: 'temporary_cleanup', status: 'fail', detail: 'isolated home or workspace could not be fully removed' })
    }
  }
  report.installedDshVersion ??= installed.version
  report.installedDshSource ??= installed.source
  report.ok = report.checks.length > 0 && report.checks.every(check => check.status === 'pass')
  report.status = report.ok ? 'pass' : 'fail'
  return report
}

function quotePwsh(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

class CheckFailure extends Error {
  constructor(readonly check: string, readonly safeDetail: string) {
    super(check)
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new CheckFailure('isolation', 'the verification worker did not receive its isolated paths')
  return value
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('bounded operation timed out')), milliseconds)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function installedManifest(packageJson: string): { version: string; dependencies: Record<string, string> } {
  try {
    const value = JSON.parse(readFileSync(packageJson, 'utf8')) as {
      name?: unknown
      version?: unknown
      dependencies?: unknown
    }
    if (value.name !== '@deepseek-ai/dsh' || typeof value.version !== 'string'
      || value.dependencies === null || typeof value.dependencies !== 'object') throw new Error('invalid manifest')
    return { version: value.version, dependencies: value.dependencies as Record<string, string> }
  } catch {
    throw new CheckFailure('installed_dsh', 'the selected installed DSH manifest is invalid or unreadable')
  }
}

interface TerminalHarness {
  ctx: any
  agent: any
  disposeAgent: () => void
}

async function composeOfficialHarness(tree: ResolvedInstalledTree): Promise<TerminalHarness> {
  const load = async (name: LiveComponent): Promise<any> => import(pathToFileURL(tree.components[name].entryPath).href)
  let ctx: any
  try {
    const [cordis, agentModule, sessionModule, sessionProjectionModule, terminalModule, terminalBash, systemPromptModule, toolsModule, persistentPwsh, subprocessModule, sandboxModule, policyModule] = await Promise.all([
      load('@deepseek-ai/cordis'),
      load('@deepseek-ai/dsh-agent'),
      load('@deepseek-ai/dsh-session'),
      load('@deepseek-ai/dsh-session-projection'),
      load('@deepseek-ai/dsh-terminal'),
      load('@deepseek-ai/dsh-terminal-bash'),
      load('@deepseek-ai/dsh-system-prompt'),
      load('@deepseek-ai/dsh-tools'),
      load('@deepseek-ai/dsh-tool-pwsh-persistent'),
      load('@deepseek-ai/dsh-subprocess-local'),
      load('@deepseek-ai/dsh-sandbox-local'),
      load('@deepseek-ai/dsh-sandbox-policy'),
    ])
    ctx = new cordis.Context()
    // Match the stock base ordering: the execution world precedes tools;
    // tools waits on systemPrompt, which is mounted immediately after it.
    await ctx.plugin(agentModule.default)
    await ctx.plugin(sessionProjectionModule.default)
    await ctx.plugin(subprocessModule.default)
    await ctx.plugin(sandboxModule.default)
    await ctx.plugin(policyModule.default, { mode: 'workspace-write', workspaceRoot: requireEnvironment('DSH_WIN32_VERIFY_WORKSPACE') })
    await ctx.plugin(toolsModule.default)
    await ctx.plugin(systemPromptModule.default, { persona: '' })
    if (ctx.get('systemPrompt') === undefined || ctx.get('tools') === undefined) {
      throw new Error('stock tools/systemPrompt services did not activate')
    }
    await ctx.plugin(terminalModule.TerminalSessionService)
    await ctx.plugin(terminalBash, {
      backendType: 'verify-pwsh',
      shellDialect: 'pwsh',
      pollIntervalMs: 50,
      exactProbeAfterMs: 150,
      idleSilenceMs: 1_000,
      handoffGraceMs: 500,
      timeoutMs: 20_000,
      disposeGraceMs: 3_000,
      scrollbackLines: 1_000,
      scrollbackMaxBytes: 262_144,
      maxReadBytes: 131_072,
    })
    await ctx.plugin(persistentPwsh, {
      backendType: 'verify-pwsh',
      timeoutMs: 30_000,
      maxOutputChars: 32_000,
      description: 'Internal dsh-win32 acceptance check',
    })

    const rawId = `dsh-win32-verify-${process.pid}`
    const id = sessionModule.SessionId(rawId)
    const scope = ctx.plugin(() => {})
    const session = sessionModule.Session.create(id)
    const agent = {
      id,
      options: {},
      session,
      inbox: new agentModule.Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      ctx: scope.ctx,
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      runMaintenance: (task: (signal: AbortSignal) => unknown) => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    const disposeAgent = ctx.agents.register(agent)
    return { ctx, agent, disposeAgent }
  } catch {
    if (ctx !== undefined) {
      try {
        await ctx.fiber.dispose()
      } catch {
        throw new CheckFailure('runtime_teardown', 'partial official-component composition did not cleanly tear down')
      }
    }
    throw new CheckFailure('official_components', 'the required official components could not be resolved and composed from the installed DSH tree')
  }
}

let nextCallId = 0

async function executePwsh(ctx: any, agent: any, command: string, signal = new AbortController().signal): Promise<string> {
  const result: any = await withTimeout(ctx.tools.execute({
    callId: `dsh-win32-verify-${++nextCallId}`,
    name: 'pwsh',
    arguments: { command },
    agent,
    signal,
  }), 40_000)
  if (result.isError || typeof result.value !== 'string') throw new Error('persistent pwsh tool failed')
  return result.value
}

async function expectToolMarker(ctx: any, agent: any, command: string, marker: string): Promise<void> {
  if (!(await executePwsh(ctx, agent, command)).includes(marker)) throw new Error('expected marker absent')
}

async function cancelTool(ctx: any, agent: any): Promise<void> {
  const controller = new AbortController()
  const running = ctx.tools.execute({
    callId: `dsh-win32-verify-${++nextCallId}`,
    name: 'pwsh',
    arguments: { command: "Start-Sleep -Seconds 30; [Console]::WriteLine(('DSH_VERIFY_' + 'CANCEL_NOT_DELIVERED'))" },
    agent,
    signal: controller.signal,
  })
  await new Promise(resolve => setTimeout(resolve, 700))
  controller.abort(new Error('dsh-win32 verification cancellation'))
  const result: any = await withTimeout(running, 20_000)
  if (!result.isError) throw new Error('canceled tool call reported success')
  if (ctx.terminals.list(agent).length !== 0) throw new Error('canceled persistent shell was not torn down')
}

/** Hidden worker entry. It emits only the structured, path-free report. */
export async function runVerifyWorker(): Promise<VerifyReport> {
  if (process.platform !== 'win32') return unsupported('native Windows only')
  const packageJson = requireEnvironment('DSH_WIN32_VERIFY_PACKAGE_JSON')
  const workspace = requireEnvironment('DSH_WIN32_VERIFY_WORKSPACE')
  const stateDirectory = requireEnvironment('DSH_WIN32_VERIFY_STATE_DIRECTORY')
  const outsideFile = requireEnvironment('DSH_WIN32_VERIFY_OUTSIDE_FILE')
  const progressFile = requireEnvironment('DSH_WIN32_VERIFY_PROGRESS_FILE')
  const checkpoint = (stage: VerifyProgressStage): void => {
    try {
      writeFileSync(progressFile, JSON.stringify({ stage }), 'utf8')
    } catch {
      // Progress is diagnostic-only and must never weaken or block acceptance.
    }
  }
  checkpoint('worker_started')
  const checks: VerifyCheck[] = []
  const pass = (name: string, detail: string): void => { checks.push({ name, status: 'pass', detail }) }
  let harness: TerminalHarness | undefined
  let cleanupFailed = false
  let selectedVersion: string | undefined

  try {
    let tree: ResolvedInstalledTree
    let manifest: ReturnType<typeof installedManifest>
    try {
      tree = resolveInstalledTree(packageJson)
      manifest = installedManifest(tree.selectedManifestPath)
      selectedVersion = tree.selectedVersion
    } catch {
      throw new CheckFailure('installed_tree', 'the selected DSH dependency graph failed canonical owner-edge validation')
    }
    if (!OFFICIAL_DECLARATIONS.every(name => typeof manifest.dependencies[name] === 'string')) {
      throw new CheckFailure('installed_dsh', `installed @deepseek-ai/dsh ${manifest.version} does not declare the complete official Windows stack`)
    }
    pass('installed_dsh', `using installed @deepseek-ai/dsh ${manifest.version}, not registry metadata`)
    checkpoint('installed_tree_validated')

    writeFileSync(outsideFile, 'control', 'utf8')
    if (readFileSync(outsideFile, 'utf8') !== 'control') throw new Error('outside control mismatch')
    unlinkSync(outsideFile)
    pass('outside_control', 'the isolated outside target is writable by the normal parent token')
    checkpoint('outside_control_passed')

    checkpoint('official_components_starting')
    harness = await composeOfficialHarness(tree)
    pass('official_components', 'loaded and composed the official components through that installed DSH dependency tree')
    checkpoint('official_components_composed')
    const { ctx, agent } = harness
    if (ctx.get('systemPrompt') === undefined || ctx.get('tools') === undefined) {
      throw new CheckFailure('service_preflight', 'the stock systemPrompt/tools service pair is not active')
    }
    pass('service_preflight', 'the installed stock systemPrompt/tools service pair is active before tool execution')
    const checked = async (name: string, detail: string, operation: () => Promise<void>): Promise<void> => {
      try {
        await operation()
        pass(name, detail)
      } catch {
        throw new CheckFailure(name, `${name} did not satisfy its live acceptance condition`)
      }
    }

    checkpoint('powershell_launch_starting')
    await checked('powershell_launch', 'PowerShell launched through the confined official persistent-tool chain', async () => {
      await expectToolMarker(
        ctx,
        agent,
        "$p = (Get-Process -Id $PID).Path; if ($PSVersionTable.PSVersion.Major -ge 7 -and [Environment]::Is64BitProcess -and -not [String]::IsNullOrWhiteSpace($PSHOME) -and [IO.File]::Exists($p)) { [Console]::WriteLine(('DSH_VERIFY_PWSH' + '7_OK')) }",
        'DSH_VERIFY_PWSH7_OK',
      )
      if (ctx.terminals.list(agent).length !== 1) throw new Error('persistent session absent')
    })
    pass('powershell_7', 'the same child is 64-bit PowerShell 7+, has PSHOME, and reports an existing executable path')
    checkpoint('powershell_launched')

    const firstSession = String(ctx.terminals.list(agent)[0]?.sessionId ?? '')
    await checked('persistent_state', 'two model-facing pwsh calls retained cwd and environment in one PTY', async () => {
      await executePwsh(ctx, agent, `Set-Location -LiteralPath ${quotePwsh(stateDirectory)}; $env:DSH_WIN32_VERIFY_STATE = '42'`)
      await expectToolMarker(
        ctx,
        agent,
        "if ($env:DSH_WIN32_VERIFY_STATE -eq '42') { [IO.File]::WriteAllText((Join-Path (Get-Location).ProviderPath 'state-location.txt'), 'cwd-ok'); [Console]::WriteLine(('DSH_VERIFY_' + 'STATE_OK')) }",
        'DSH_VERIFY_STATE_OK',
      )
      const current = String(ctx.terminals.list(agent)[0]?.sessionId ?? '')
      if (firstSession === '' || current !== firstSession) throw new Error('tool changed PTY')
      if (readFileSync(join(stateDirectory, 'state-location.txt'), 'utf8') !== 'cwd-ok') throw new Error('cwd state mismatch')
    })
    checkpoint('persistent_state_passed')

    await checked('workspace_write_read', 'exact content was written and read inside the temporary workspace', async () => {
      await expectToolMarker(
        ctx,
        agent,
        "[IO.File]::WriteAllText((Join-Path (Get-Location).ProviderPath 'inside.txt'), 'inside-ok'); if ([IO.File]::ReadAllText((Join-Path (Get-Location).ProviderPath 'inside.txt')) -eq 'inside-ok') { [Console]::WriteLine(('DSH_VERIFY_INSIDE_' + 'OK')) }",
        'DSH_VERIFY_INSIDE_OK',
      )
      if (readFileSync(join(stateDirectory, 'inside.txt'), 'utf8') !== 'inside-ok') throw new Error('inside content mismatch')
    })
    checkpoint('workspace_write_passed')

    await checked('outside_write_blocked', 'the control-writable target was denied under Workspace Write and no file was created', async () => {
      await expectToolMarker(
        ctx,
        agent,
        `try { [IO.File]::WriteAllText(${quotePwsh(outsideFile)}, 'must-not-exist'); [Console]::WriteLine(('DSH_VERIFY_OUTSIDE_' + 'ALLOWED')) } catch { [Console]::WriteLine(('DSH_VERIFY_OUTSIDE_' + 'DENIED')) }`,
        'DSH_VERIFY_OUTSIDE_DENIED',
      )
      if (existsSync(outsideFile)) throw new Error('outside file exists')
    })
    checkpoint('outside_write_blocked')

    await checked('denial_recovery', 'the same persistent-tool PTY remained usable after the denied write', async () => {
      await expectToolMarker(ctx, agent, "[Console]::WriteLine(('DSH_VERIFY_DENIAL_' + 'RECOVERY_OK'))", 'DSH_VERIFY_DENIAL_RECOVERY_OK')
      if (String(ctx.terminals.list(agent)[0]?.sessionId ?? '') !== firstSession) throw new Error('tool changed PTY')
    })
    checkpoint('denial_recovery_passed')

    await checked('cancel_recovery', 'cancellation tore down the first PTY and the next pwsh call spawned a working replacement', async () => {
      await cancelTool(ctx, agent)
      await expectToolMarker(ctx, agent, "[Console]::WriteLine(('DSH_VERIFY_CANCEL_' + 'RECOVERY_OK'))", 'DSH_VERIFY_CANCEL_RECOVERY_OK')
      const replacement = String(ctx.terminals.list(agent)[0]?.sessionId ?? '')
      if (replacement === '' || replacement === firstSession) throw new Error('replacement PTY absent')
    })
    checkpoint('cancellation_recovery_passed')

    await checked('repeat_lifecycle', 'two persistent PTYs completed spawn, cancellation, and awaited teardown', async () => {
      await cancelTool(ctx, agent)
      if (ctx.terminals.list(agent).length !== 0) throw new Error('second PTY remains')
    })
    checkpoint('repeat_lifecycle_passed')
  } catch (error) {
    const failure = error instanceof CheckFailure
      ? error
      : new CheckFailure('official_component_chain', 'the official component chain did not satisfy every live acceptance invariant')
    checks.push({ name: failure.check, status: 'fail', detail: failure.safeDetail })
  } finally {
    if (harness !== undefined) {
      checkpoint('runtime_teardown_starting')
      try {
        harness.disposeAgent()
        await withTimeout(harness.ctx.fiber.dispose(), 20_000)
      } catch {
        cleanupFailed = true
      }
    }
  }
  if (!checks.some(check => check.name === 'runtime_teardown' && check.status === 'fail')) {
    checks.push({
      name: 'runtime_teardown',
      status: cleanupFailed ? 'fail' : 'pass',
      detail: cleanupFailed ? 'one or more official runtime resources did not report a clean teardown' : 'all terminal and component resources reported awaited teardown',
    })
  }
  const ok = checks.length > 0 && checks.every(check => check.status === 'pass')
  checkpoint('worker_finished')
  return {
    schema: 'dsh-win32/verify/v1',
    status: ok ? 'pass' : 'fail',
    ok,
    boundary: BOUNDARY,
    ...(selectedVersion === undefined ? {} : { installedDshVersion: selectedVersion }),
    checks,
  }
}
