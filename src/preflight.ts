/** Read-only upgrade simulation. Never import the host, run package scripts, or write to a profile. */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { profileDirectory, readManifest } from './profile-disable.ts'
import { supportsDshNode } from './verify.ts'

const DSH = '@deepseek-ai/dsh'
const MAX_BYTES = 1024 * 1024
const NOT_WINDOWS = 'win32 only, not applicable on this platform'
/** Doubles as shell safety: Windows runs npm through cmd.exe. Ranges are rejected on purpose. */
const TARGET = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

export const UPGRADE_GUIDE = 'https://github.com/deepseek-ai/deepseek-harness/tree/main/docs/upgrade-guide'

/**
 * Behavior changes that metadata cannot show. Guidance only, because reading
 * the settings they touch would make this command parse user configuration.
 * Each `since` comes from the upstream release notes of that version.
 */
const RELEASE_RULES = [
  { name: 'saved_models', since: '0.2.0-rc.2', detail: 'some older model IDs were removed, so saved selections may need to be reselected' },
  { name: 'api_key_source', since: '0.2.1-alpha.3', detail: 'Web and Desktop now prefer saved credentials, while headless reads environment variables and .env instead of saved keys' },
  { name: 'ssh_protocol', since: '0.2.2-alpha.2', detail: 'SSH protocol moved from 2 to 3, so self-deployed bootstraps and SSH helpers must be upgraded together' },
]

export type PreflightStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface PreflightCheck {
  name: string
  status: PreflightStatus
  detail: string
  fix?: string
}

export interface PreflightReport {
  schema: 'dsh-preflight/v1'
  generatedAt: string
  profile: string
  target: { requested: string, resolved?: string }
  installed?: string
  exitCode: 0 | 1 | 2
  summary: Record<PreflightStatus, number>
  ok: boolean
  checks: PreflightCheck[]
  guide: string
}

export interface PreflightOptions {
  home: string
  profile?: string
  target?: string
}

export interface PreflightDependencies {
  /** `npm view <spec> <fields> --json`, parsed; undefined when the lookup fails. */
  view(spec: string, fields: string[]): unknown
  installedVersion(profile: string): string | undefined
  nodeVersion: string
  /** Undefined off Windows. */
  windows?: { pwsh?: string, pathPwsh?: string }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${field} must be an object`)
  return value
}

function satisfies(version: string, range: string): boolean {
  return range.trim() !== '' && semver.satisfies(version, range, { includePrerelease: true })
}

/**
 * The requirements `runtime` leaves unmet, using the host's rule from
 * app-boot's plugin-compatibility.ts. An own `engines.dsh` decides alone and
 * peers are ignored; otherwise every DSH peer must match. CI compares this
 * port with the installed upstream function (scripts/preflight-contract.mjs).
 * @throws for fields the host refuses as unreadable.
 */
export function unmetRequirements(manifest: Record<string, unknown>, runtime: string): Record<string, string> {
  const engines = Object.hasOwn(manifest, 'engines') ? objectOf(manifest.engines, 'engines') : {}
  if (Object.hasOwn(engines, 'dsh')) {
    const range = engines.dsh
    if (typeof range !== 'string') throw new Error('engines.dsh must be a string')
    return satisfies(runtime, range) ? {} : { 'engines.dsh': range }
  }
  if (!Object.hasOwn(manifest, 'peerDependencies')) return {}
  const unmet: Record<string, string> = {}
  for (const [name, range] of Object.entries(objectOf(manifest.peerDependencies, 'peerDependencies'))) {
    if (typeof range !== 'string') throw new Error(`peerDependencies[${JSON.stringify(name)}] must be a string`)
    if (name !== DSH && !name.startsWith(`${DSH}-`)) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtime : range
    if (!satisfies(runtime, requirement)) unmet[name] = range
  }
  return unmet
}

function readJson(path: string): unknown {
  if (statSync(path).size > MAX_BYTES) throw new Error('oversized manifest')
  return JSON.parse(readFileSync(path, 'utf8'))
}

function isExactVersion(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const parsed = semver.parse(value)
  return parsed !== null && value === `${parsed.version}${parsed.build.length === 0 ? '' : `+${parsed.build.join('.')}`}`
}

/** A bad file authorizes nothing and never blocks the check, matching the host. */
function readExemptions(dir: string): { exemptions: Record<string, unknown>, problem?: string } {
  let value: unknown
  try { value = readJson(join(dir, 'compatibility.json')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exemptions: {} }
    return { exemptions: {}, problem: 'compatibility.json could not be read, so no exemptions were applied' }
  }
  if (!isObject(value)) return { exemptions: {}, problem: 'compatibility.json must map package@version keys to DSH versions, so no exemptions were applied' }
  return { exemptions: value }
}

function isExempt(exemptions: Record<string, unknown>, key: string, target: string): boolean {
  const versions = Object.hasOwn(exemptions, key) ? exemptions[key] : undefined
  return Array.isArray(versions) && versions.every(isExactVersion) && versions.includes(target)
}

function stayCommand(installed: string | undefined): string {
  return installed === undefined
    ? 'postpone this upgrade'
    : `postpone this upgrade and keep ${installed} (npm install -g ${DSH}@${installed})`
}

/** Only ever advice, so a failed lookup drops the suggestion and keeps the verdict. */
function pluginFix(
  manifest: Record<string, unknown>,
  target: string,
  profile: string,
  installed: string | undefined,
  view: PreflightDependencies['view'],
): string {
  const stay = stayCommand(installed)
  const { name, version } = manifest
  if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) return `update the plugin or ${stay}`
  const latest = view(`${name}@latest`, ['version', 'engines', 'peerDependencies'])
  if (!isObject(latest) || typeof latest.version !== 'string') return `update the plugin or ${stay}`
  try {
    if (latest.version !== version && Object.keys(unmetRequirements(latest, target)).length === 0) {
      return `update it first (dsh plugin --profile ${profile} add ${name}@${latest.version})`
    }
  } catch {
    // An unreadable newest manifest is the same as having no compatible release.
  }
  return `its newest release ${latest.version} is not compatible either, so ${stay}`
}

function checkNode(add: Add, range: unknown, nodeVersion: string, target: string): void {
  if (typeof range === 'string' && semver.validRange(range) !== null) {
    if (semver.satisfies(nodeVersion, range)) add('node', 'pass', `${nodeVersion} satisfies ${range} declared by ${target}`)
    else add('node', 'fail', `node ${nodeVersion} is outside ${range} declared by ${target}`, 'upgrade Node.js before upgrading DSH')
  } else if (supportsDshNode(nodeVersion)) {
    add('node', 'pass', `${target} declares no engines.node; ${nodeVersion} meets the dsh-win32 baseline ^22.19.0 || >=24`)
  } else {
    add('node', 'warn', `${target} declares no engines.node, and ${nodeVersion} is outside the dsh-win32 baseline ^22.19.0 || >=24`)
  }
}

type Add = (name: string, status: PreflightStatus, detail: string, fix?: string) => void

function checkPlugins(add: Add, dir: string, target: string, profile: string, installed: string | undefined, view: PreflightDependencies['view']): void {
  const manifest = JSON.parse(readManifest(join(dir, 'package.json')).toString('utf8')) as unknown
  const dependencies = objectOf(objectOf(manifest, 'package.json').dependencies ?? {}, 'dependencies')
  // Official packages move with the host, so only third-party plugins can fall behind it.
  const plugins = Object.keys(dependencies).filter(name => !name.startsWith('@deepseek-ai/')).sort()
  if (plugins.length === 0) {
    add('plugins', 'skip', `profile "${profile}" has no third-party plugins, so there is nothing to compare`)
    return
  }
  const { exemptions, problem } = readExemptions(dir)
  if (problem !== undefined) add('compatibility_file', 'warn', problem)
  const counts = { compatible: 0, exempted: 0, unknown: 0, incompatible: 0 }
  for (const name of plugins) {
    const check = `plugin:${name}`
    let plugin: Record<string, unknown>
    try {
      if (!PACKAGE_NAME.test(name)) throw new Error('unsafe name')
      plugin = objectOf(readJson(join(dir, 'node_modules', name, 'package.json')), 'package.json')
    } catch {
      counts.unknown += 1
      add(check, 'warn', 'not installed or its manifest is unreadable, so its compatibility is unknown')
      continue
    }
    let unmet: Record<string, string>
    try { unmet = unmetRequirements(plugin, target) }
    catch (error) {
      counts.incompatible += 1
      add(check, 'fail', `DSH refuses this manifest: ${(error as Error).message}`, `update the plugin or ${stayCommand(installed)}`)
      continue
    }
    if (Object.keys(unmet).length === 0) {
      counts.compatible += 1
      continue
    }
    const version = typeof plugin.version === 'string' ? plugin.version : 'unknown'
    const key = `${typeof plugin.name === 'string' ? plugin.name : name}@${version}`
    if (isExempt(exemptions, key, target)) {
      counts.exempted += 1
      add(check, 'warn', `${key} does not accept ${target} (${JSON.stringify(unmet)}) but holds an exact-version exemption for it`)
    } else {
      counts.incompatible += 1
      add(check, 'fail', `${key} does not accept ${target}: ${JSON.stringify(unmet)}`, pluginFix(plugin, target, profile, installed, view))
    }
  }
  const status = counts.incompatible > 0 ? 'fail' : counts.exempted + counts.unknown > 0 ? 'warn' : 'pass'
  add('plugins', status, `${plugins.length} checked against ${target}: ${counts.compatible} compatible, ${counts.incompatible} incompatible, ${counts.exempted} exempted, ${counts.unknown} unknown`)
}

function checkWindows(add: Add, windows: PreflightDependencies['windows']): void {
  if (windows === undefined) {
    add('powershell', 'skip', NOT_WINDOWS)
    add('path', 'skip', NOT_WINDOWS)
    return
  }
  if (windows.pwsh !== undefined) add('powershell', 'pass', windows.pwsh)
  else add('powershell', 'warn', 'PowerShell 7 not found', 'install PowerShell 7 from https://learn.microsoft.com/powershell')
  if (windows.pathPwsh !== undefined) add('path', 'pass', `pwsh resolves through PATH to ${windows.pathPwsh}`)
  else add('path', 'warn', 'pwsh does not resolve through this PATH, so child processes may not find it', 'add PowerShell 7 to PATH, then open a new terminal')
}

function resolveTarget(requested: string, view: PreflightDependencies['view']): { version?: string, node?: unknown, problem?: string } {
  if (!TARGET.test(requested)) return { problem: `--target needs one exact version or dist-tag, got ${JSON.stringify(requested)}` }
  const meta = view(`${DSH}@${requested}`, ['version', 'engines'])
  if (meta === undefined) return { problem: `could not read ${DSH}@${requested} from the registry` }
  if (Array.isArray(meta)) return { problem: `${requested} matches more than one release; name one exact version or dist-tag` }
  // npm prints a bare string instead of an object when only one requested field exists.
  const version = isObject(meta) ? meta.version : meta
  if (typeof version !== 'string' || semver.valid(version) === null) return { problem: `${DSH}@${requested} did not resolve to a release` }
  return { version, node: isObject(meta) && isObject(meta.engines) ? meta.engines.node : undefined }
}

/** Judge an upgrade to `target` without changing anything. Unfinished judgments are failures, never a pass. */
export function runPreflight(options: PreflightOptions, deps: PreflightDependencies): PreflightReport {
  const profile = options.profile ?? 'web'
  const requested = options.target ?? 'latest'
  const checks: PreflightCheck[] = []
  const add: Add = (name, status, detail, fix) => {
    checks.push(fix === undefined ? { name, status, detail } : { name, status, detail, fix })
  }

  const resolved = resolveTarget(requested, deps.view)
  const target = resolved.version
  const found = deps.installedVersion(profile)
  const installed = found !== undefined && semver.valid(found) !== null ? found : undefined

  if (target === undefined) add('target', 'fail', resolved.problem ?? 'target did not resolve', 'check the target and the network, then run preflight again')
  else add('target', 'pass', requested === target ? target : `${requested} resolves to ${target}`)
  if (installed === undefined) add('installed_dsh', 'warn', 'no installed DSH was found, so the release rules were skipped')
  else add('installed_dsh', 'pass', installed)

  if (target === undefined) {
    add('node', 'skip', 'needs a resolved target')
    add('plugins', 'skip', 'needs a resolved target')
  } else {
    checkNode(add, resolved.node, deps.nodeVersion, target)
    try {
      checkPlugins(add, profileDirectory({ home: options.home, profile }), target, profile, installed, deps.view)
    } catch (error) {
      // Native and JSON errors can quote configuration, so keep only the code.
      const code = (error as NodeJS.ErrnoException).code
      const reason = code === undefined && !(error instanceof SyntaxError) ? (error as Error).message : `could not be read (${code ?? 'invalid JSON'})`
      add('profile', 'fail', `profile "${profile}": ${reason}`, 'name an existing profile with --profile')
    }
  }

  checkWindows(add, deps.windows)

  for (const { name, since, detail } of RELEASE_RULES) {
    if (installed === undefined || target === undefined) add(name, 'skip', 'needs both the installed and the target version')
    else if (semver.lt(installed, since) && semver.gte(target, since)) add(name, 'warn', `this upgrade crosses ${since}: ${detail}`)
    else add(name, 'skip', `this upgrade does not cross ${since}`)
  }

  const summary: Record<PreflightStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const { status } of checks) summary[status] += 1
  return {
    schema: 'dsh-preflight/v1',
    generatedAt: new Date().toISOString(),
    profile,
    target: target === undefined ? { requested } : { requested, resolved: target },
    ...(installed === undefined ? {} : { installed }),
    // The dsh-doctor/v1 exit contract: 0 all pass, 1 any warn, 2 any fail.
    exitCode: summary.fail > 0 ? 2 : summary.warn > 0 ? 1 : 0,
    summary,
    ok: summary.fail === 0,
    checks,
    guide: UPGRADE_GUIDE,
  }
}
