#!/usr/bin/env node
/**
 * dsh-win32 CLI: `doctor` diagnoses the known DSH-on-Windows traps.
 * Current `setup` verifies the official Windows stack and creates a shortcut.
 * `setup --legacy` installs the old custom presets. Zero dependencies.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
// Shared with the runtime so the two never drift; lib/ always ships with bin/.
import { findGitBash, installPreset, busyboxPath } from '../lib/preset-install.js'

const WIN = process.platform === 'win32'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PRESET_ID = 'minimal-windows'
const PRESET_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'preset', PRESET_ID)
const REPO = 'https://github.com/sjh9714/dsh-win32'
const SELF_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version

const ok = message => console.log(`  ok    ${message}`)
const warn = message => console.log(`  WARN  ${message}`)
const bad = message => console.log(`  FAIL  ${message}`)
const info = message => console.log(`  tip   ${message}`)

function tryExec(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

function findPwsh7() {
  if (process.env.ProgramFiles !== undefined) {
    const candidate = join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')
    if (existsSync(candidate)) return candidate
  }
  const located = tryExec('where.exe', ['pwsh'])
  const first = (located ?? '').split(/\r?\n/)[0]?.trim()
  return first !== undefined && first !== '' ? first : undefined
}

/**
 * pnpm backs the profile-directory install: `dsh plugin add` forwards to it,
 * so a box without pnpm fails the bundle wiring with a bare
 * "'pnpm' is not recognized" and no hint about what is actually missing (#13).
 */
function findPnpm() {
  const located = tryExec(WIN ? 'where.exe' : 'which', ['pnpm'])
  const first = (located ?? '').split(/\r?\n/)[0]?.trim()
  return first !== undefined && first !== '' ? first : undefined
}

const OFFICIAL_WINDOWS_DEPS = [
  '@deepseek-ai/dsh-tool-pwsh-persistent',
  '@deepseek-ai/dsh-pwsh-local',
  '@deepseek-ai/dsh-pwsh-sandbox',
]

function dshReleaseMeta() {
  if (process.env.DSH_WINDOWS_DSH_META !== undefined) {
    try {
      return JSON.parse(process.env.DSH_WINDOWS_DSH_META)
    } catch {
      return undefined
    }
  }
  try {
    const output = execFileSync(WIN ? 'npm.cmd' : 'npm', ['view', '@deepseek-ai/dsh', 'version', 'dependencies', '--json'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: WIN,
      timeout: 15_000,
    })
    return JSON.parse(output)
  } catch {
    return undefined
  }
}

function hasOfficialWindowsStack(meta) {
  return OFFICIAL_WINDOWS_DEPS.every((name) => typeof meta?.dependencies?.[name] === 'string')
}

/** node ships corepack, so a missing pnpm is recoverable without a download. */
function enablePnpmViaCorepack() {
  try {
    // Constant argv; shell:true only because Windows corepack is a .cmd shim (CVE-2024-27980 policy).
    execFileSync(WIN ? 'corepack.cmd' : 'corepack', ['enable', 'pnpm'], {
      stdio: 'ignore',
      windowsHide: true,
      shell: WIN,
    })
  } catch {
    return undefined
  }
  return findPnpm()
}

/** koffi 3.1.3/3.1.4 ship a broken win32-x64 prebuilt (segfault chain: install failures, picker crash, silent session-save crash). */
function scanKoffi() {
  const results = []
  const profilesDir = join(DSH_HOME, 'profiles')
  if (!existsSync(profilesDir)) return results
  for (const profile of readdirSync(profilesDir)) {
    const manifest = join(profilesDir, profile, 'node_modules', 'koffi', 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const version = JSON.parse(readFileSync(manifest, 'utf8')).version
      const loadable = tryExec(process.execPath, ['-e', 'require(process.argv[1])', dirname(manifest)]) !== undefined
      results.push({ profile, version, loadable })
    } catch {
      // Unreadable manifest: nothing to report for this profile.
    }
  }
  return results
}

/**
 * True for `Git\bin\bash.exe`, the 47KB wrapper that respawns the real shell
 * in `Git\usr\bin`. Note that the real path also ends in `\bin\bash.exe`,
 * so the `usr` segment is what tells them apart and matching only the tail
 * flags the correct shell as the wrapper.
 */
export function isBashWrapper(path) {
  const normalized = path.replaceAll('\\', '/')
  return /\/bin\/bash\.exe$/i.test(normalized) && !/\/usr\/bin\/bash\.exe$/i.test(normalized)
}

/** Every win32 name below is meaningless elsewhere, hence `skip`. */
const NOT_WINDOWS = 'win32 only, not applicable on this platform'

/**
 * Run the checks and return them in the `dsh-doctor/v1` vocabulary
 * (deepseek-harness#1719). `status` is pass / warn / fail, plus `skip` for a
 * check that does not apply here, which the vocabulary added at our request
 * because three states force a platform-scoped check to either lie (pass) or
 * poison the run (fail). `skip` carries a mandatory reason and counts as
 * neither pass nor fail.
 */
function collectChecks({ legacy = false, profile = 'web' } = {}) {
  const checks = []
  // `fix` is the instruction on its own, separate from the description. The
  // dsh-doctor v1.1 addendum aggregates these into `remediation`, and it
  // explicitly does not assume the field exists, so it stays optional here and
  // absent from the object when a check has nothing actionable to say.
  const add = (name, status, detail, fix) =>
    checks.push(fix === undefined ? { name, status, detail } : { name, status, detail, fix })

  const [major, minor] = process.versions.node.split('.').map(Number)
  // Range is the one declared by the deepseek-harness root package.json, not
  // a threshold derived from an observed failure (#1719, #2259). Two states on
  // purpose. npm surfaces an out-of-range engine as EBADENGINE, a warning
  // rather than an error, so a doctor that fails here is stricter than the
  // packaging system that owns the constraint. Any `fail` boundary below the
  // declared range would be a number nothing declares.
  if (major > 22 || (major === 22 && minor >= 19)) add('node', 'pass', process.versions.node)
  else add('node', 'warn', `node ${process.versions.node} is outside DSH's declared range ^22.19.0 || >=24.0.0 (deepseek-harness root package.json)`)

  const pnpm = findPnpm()
  if (!legacy) add('pnpm', 'skip', 'current DSH setup does not install a bundle or custom preset')
  else if (pnpm !== undefined) add('pnpm', 'pass', pnpm)
  else add('pnpm', 'warn', 'pnpm not found. The bundle installs into the profile dir with pnpm, so wiring fails without it', 'npx dsh-win32 setup enables it through corepack, or: npm install -g pnpm')

  // Still vendor-prefixed because `installed_bundle` is only nominated for
  // r6/v1.1, not frozen (#1719). The four conditions and their statuses are
  // the agreed ones, co-drafted with @moonquake2004.
  //
  // The first cell is `skip`, not `warn`. This check compares the profile's
  // bundle against the running CLI, and with nothing listed there is no
  // comparison to make. Reporting `pass` would let a CI script conclude "in
  // sync" from nothing, which is the same trap that put `skip` in r5 for
  // `git_bash` on Linux. The "go install it" nudge is a product concern and
  // lives in the tip lines below, not in a shared vocabulary name.
  const wiredBundle = bundleVersion(profile)
  if (!legacy && wiredBundle === undefined) {
    add('dsh-win32/bundle', 'pass', 'not wired into the profile, which is correct for current DSH')
  } else if (!legacy) {
    add('dsh-win32/bundle', 'warn', `legacy bundle ${wiredBundle} is still wired into profile "${profile}"`, `npx @deepseek-ai/dsh plugin --profile ${profile} remove dsh-win32`)
  } else if (wiredBundle === undefined) {
    add('dsh-win32/bundle', 'skip', 'no legacy bundle listed in the profile manifest, so there is nothing to compare the CLI against')
  } else if (wiredBundle === SELF_VERSION) {
    add('dsh-win32/bundle', 'pass', wiredBundle)
  } else if (wiredBundle === 'wired, not installed') {
    add('dsh-win32/bundle', 'warn', 'listed in the profile manifest but absent from its node_modules, so the runtime never loads', 'npx dsh-win32 setup')
  } else if (wiredBundle === 'unreadable') {
    add('dsh-win32/bundle', 'warn', 'the installed bundle manifest could not be read, so its version is unknown', 'npx dsh-win32 setup')
  } else {
    // The age-gate note is load bearing. A profile's pnpm-workspace.yaml
    // carries minimumReleaseAgeExclude listing only the versions current when
    // each bundle was wired, so for about a day after a publish the upgrade is
    // a no-op and pnpm answers "Already up to date". Without this sentence the
    // instruction silently does nothing and the warn looks like the user's
    // fault.
    add('dsh-win32/bundle', 'warn', `profile runs ${wiredBundle}, this CLI is ${SELF_VERSION}`, 'npx dsh-win32 setup. If that reports no change, the profile\'s pnpm minimumReleaseAgeExclude gate is holding the new version, so retry the next day')
  }

  const release = dshReleaseMeta()
  const official = hasOfficialWindowsStack(release)
  if (release === undefined) {
    add('dsh_current', 'warn', 'could not read the current @deepseek-ai/dsh release metadata', 'check the network and re-run npx dsh-win32 doctor')
  } else if (official) {
    add('dsh_current', 'pass', `@deepseek-ai/dsh ${release.version} includes the official Windows stack`)
  } else {
    add('dsh_current', 'warn', `@deepseek-ai/dsh ${release.version ?? 'unknown'} does not declare the complete official Windows stack`, 'update @deepseek-ai/dsh or use npx dsh-win32 setup --legacy for an rc.6-era installation')
  }

  const gitBash = WIN ? findGitBash() : undefined
  if (!WIN) {
    for (const name of ['git_bash', 'powershell', 'koffi', 'persistent_powershell', 'workspace_write', 'sandbox_shell', 'write_fence']) add(name, 'skip', NOT_WINDOWS)
    return { checks, gitBash, official }
  }

  if (!legacy) {
    add('git_bash', 'skip', 'current DSH uses official PowerShell on Windows; Git Bash is needed only by dsh-win32 --legacy')

    const pwsh7 = findPwsh7()
    if (pwsh7 !== undefined) add('powershell', 'pass', pwsh7)
    else add('powershell', 'warn', 'PowerShell 7 not found. Current DSH can fall back to Windows PowerShell, but PowerShell 7 is the supported path', 'install PowerShell 7 from https://learn.microsoft.com/powershell')

    const koffi = scanKoffi()
    const brokenKoffi = koffi.filter(({ version }) => version === '3.1.3' || version === '3.1.4')
    const unloadableKoffi = koffi.filter(({ loadable }) => !loadable)
    if (brokenKoffi.length > 0 || unloadableKoffi.length > 0) {
      const where = [...brokenKoffi, ...unloadableKoffi]
        .map(({ profile: name, version }) => `${version} in "${name}"`).join(', ')
      add('koffi', 'warn', `koffi runtime load failed or has a broken Windows prebuilt (${where})`, 'npx dsh-win32 fix')
    } else if (koffi.length === 0) add('koffi', 'pass', 'no koffi found in any profile')
    else add('koffi', 'pass', koffi.map(({ profile: name, version }) => `${version} in "${name}"`).join(', '))

    if (official) {
      add('persistent_powershell', 'pass', `${release.dependencies['@deepseek-ai/dsh-tool-pwsh-persistent']} is included by @deepseek-ai/dsh ${release.version}`)
      add('workspace_write', 'pass', `${release.dependencies['@deepseek-ai/dsh-pwsh-sandbox']} provides the Windows ACL sandbox`)
      add('sandbox_shell', 'pass', 'the official persistent PowerShell stack is available inside Workspace Write')
    } else {
      add('persistent_powershell', 'warn', 'the current DSH release metadata does not confirm the official persistent PowerShell tool', 'update @deepseek-ai/dsh')
      add('workspace_write', 'warn', 'the current DSH release metadata does not confirm the official Windows ACL sandbox', 'update @deepseek-ai/dsh')
      add('sandbox_shell', 'warn', 'the official Workspace Write shell could not be confirmed', 'update @deepseek-ai/dsh')
    }
    add('write_fence', 'skip', 'the legacy preset fence check does not apply to the official DSH preset')
    return { checks, gitBash, official }
  }

  if (gitBash === undefined) add('git_bash', 'fail', 'Git Bash not found', 'install from https://git-scm.com (winget install Git.Git), then re-run')
  else if (isBashWrapper(gitBash)) add('git_bash', 'warn', `${gitBash} is the 47KB wrapper, not the real shell; the PTY pid lands on the wrapper (see #7)`)
  else add('git_bash', 'pass', gitBash)

  const pwsh7 = findPwsh7()
  if (pwsh7 !== undefined) add('powershell', 'pass', pwsh7)
  else add('powershell', 'warn', 'PowerShell 7 not found. The 5.1 fallback is reported to crash with 0xC0000142 in the packaged desktop app; a confined 5.1 starts fine on this CLI path (scripts/pwsh-sandbox-probe.mjs)', 'winget install Microsoft.PowerShell')

  const koffi = scanKoffi()
  const brokenKoffi = koffi.filter(({ version }) => version === '3.1.3' || version === '3.1.4')
  const unloadableKoffi = koffi.filter(({ loadable }) => !loadable)
  if (brokenKoffi.length > 0 || unloadableKoffi.length > 0) {
    const problems = []
    if (brokenKoffi.length > 0) {
      const where = brokenKoffi.map(({ profile, version }) => `${version} in "${profile}"`).join(', ')
      problems.push(`broken win32-x64 prebuilt (${where}); install failures, folder-picker and session-save crashes`)
    }
    if (unloadableKoffi.length > 0) {
      const where = unloadableKoffi.map(({ profile, version }) => `${version} in "${profile}"`).join(', ')
      problems.push(`runtime load failed (${where}); skipping the install script is safe only when this load succeeds afterward`)
    }
    add('koffi', 'warn', problems.join('; '), 'npx dsh-win32 fix')
  } else if (koffi.length === 0) add('koffi', 'pass', 'no koffi found in any profile')
  else add('koffi', 'pass', koffi.map(({ profile, version }) => `${version} in "${profile}"`).join(', '))

  add('persistent_powershell', 'skip', 'legacy mode uses the dsh-win32 Git Bash or busybox preset')
  add('workspace_write', 'skip', 'legacy mode reports its sandbox through sandbox_shell and write_fence')

  // MSYS bash dies under the workspace-write restricted token, so without the
  // busybox variant a sandboxed session has no working shell at all (#6).
  if (existsSync(join(DSH_HOME, '.agent-presets', 'minimal-windows-sandboxed'))) {
    add('sandbox_shell', 'pass', 'minimal-windows-sandboxed installed; persistent shell works inside workspace-write')
  } else {
    add('sandbox_shell', 'warn', 'only the Git Bash preset is installed, which needs danger-full-access', 'for a shell that survives the workspace-write sandbox: npx dsh-win32 setup --sandboxed')
  }

  // Stock minimal mounts the bare fs-local, which reports no sandboxMode, so
  // tool-str-replace-editor builds no MutationPolicy and the editor can write
  // anywhere while the badge says Read Only (deepseek-harness#2066). Our
  // sandboxed preset mounts the confining backend instead, but a preset
  // installed by an older CLI still has the unfenced one on disk.
  const installed = ['minimal-windows', 'minimal-windows-sandboxed']
    .map((name) => ({ name, yml: join(DSH_HOME, '.agent-presets', name, 'agent.cordis.yml') }))
    .filter(({ yml }) => existsSync(yml))
  const unfenced = installed.filter(({ yml }) => !readFileSync(yml, 'utf8').includes('dsh-win32/fs-confined'))
  if (installed.length === 0) {
    add('write_fence', 'skip', 'no dsh-win32 preset is installed')
  } else if (unfenced.length === 0) {
    add('write_fence', 'pass', `${installed.map(({ name }) => name).join(', ')} fence editor writes by the session permission mode`)
  } else {
    add('write_fence', 'warn', `${unfenced.map(({ name }) => name).join(', ')} predates the write fence, so str_replace_editor can write outside the workspace under Read Only`, 'npx dsh-win32 setup')
  }

  return { checks, gitBash, official }
}

const RENDER = { pass: ok, warn, fail: bad, skip: message => console.log(`  skip  ${message}`) }

function summarize(checks) {
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const { status } of checks) summary[status] += 1
  // Contract exit semantics: 0 all pass, 1 any warn, 2 any fail. skip is neither.
  const exitCode = summary.fail > 0 ? 2 : summary.warn > 0 ? 1 : 0
  return { summary, exitCode }
}

/**
 * The `remediation` array of the dsh-doctor v1.1 addendum: the warn and fail
 * checks in check order, one line each, keyed by the exact check name.
 *
 * The key is delimited by the first `]` rather than a character class, so a
 * vendor-prefixed name like `dsh-win32/bundle` survives a consumer's parse.
 * The charset the addendum first proposed would have dropped precisely those
 * lines, silently. A check with no separate `fix` falls back to its `detail`,
 * which the addendum allows, since it does not assume a `fix` field exists.
 */
function remediationLines(checks) {
  return checks
    .filter(({ status }) => status === 'warn' || status === 'fail')
    .map(({ name, detail, fix }) => `[${name}] ${fix ?? detail}`)
}

function doctor({ json = false, remediation = false, legacy = false, profile = 'web' } = {}) {
  const { checks, gitBash, official } = collectChecks({ legacy, profile })
  const { summary, exitCode } = summarize(checks)

  if (json) {
    console.log(JSON.stringify({
      schema: 'dsh-doctor/v1',
      generatedAt: new Date().toISOString(),
      profile,
      exitCode,
      summary,
      ok: summary.fail === 0,
      checks,
      // Opt-in only. A frozen r5 consumer must never see this field.
      ...(remediation ? { remediation: remediationLines(checks) } : {}),
    }, null, 2))
    return { gitBash, official, exitCode }
  }

  console.log(`dsh-win32 doctor (platform: ${process.platform}, mode: ${legacy ? 'legacy' : 'current DSH'})`)
  for (const { name, status, detail, fix } of checks) {
    RENDER[status](fix === undefined ? `${name}: ${detail}` : `${name}: ${detail}. Fix: ${fix}`)
  }
  if (!WIN) info('not Windows, so the Windows traps are skipped rather than reported')
  info('open the EXACT url dsh prints (localhost vs 127.0.0.1 are different origins; the wrong one 403s every /api call)')
  info('current DSH setup: npx dsh-win32 setup  (official PowerShell, Workspace Write, shortcut, health report)')
  info('old rc.6 preset setup: npx dsh-win32 setup --legacy')
  info('machine-readable output: npx dsh-win32 doctor --json  (dsh-doctor/v1 envelope; add --remediation for the v1.1 keyed fix list)')
  info(`${REPO}  (issues and real-hardware reports welcome)`)
  return { gitBash, official, exitCode }
}

/**
 * What the profile actually runs, which is not what the CLI is.
 *
 * The runtime behaviour lives in the bundle inside the profile, so a machine
 * can run `npx dsh-win32@latest setup` and stay on an old runtime while every
 * check reports green (#17). Returns undefined when the bundle is not wired.
 */
function bundleVersion(profile = 'web') {
  const manifest = join(DSH_HOME, 'profiles', profile, 'package.json')
  if (!existsSync(manifest)) return undefined
  try {
    const wired = (JSON.parse(readFileSync(manifest, 'utf8')).dsh?.profile?.bundles ?? []).includes('dsh-win32')
    if (!wired) return undefined
  } catch {
    return undefined
  }
  const installed = join(DSH_HOME, 'profiles', profile, 'node_modules', 'dsh-win32', 'package.json')
  if (!existsSync(installed)) return 'wired, not installed'
  try {
    return JSON.parse(readFileSync(installed, 'utf8')).version
  } catch {
    return 'unreadable'
  }
}

/** Forward to the dsh CLI through npx so this works without a global dsh install. */
function runDshPlugin(args) {
  // Constant argv; shell:true only because Windows npx is a .cmd shim (CVE-2024-27980 policy).
  execFileSync(WIN ? 'npx.cmd' : 'npx', ['--yes', '@deepseek-ai/dsh', 'plugin', ...args], {
    stdio: 'inherit',
    windowsHide: true,
    shell: WIN,
  })
}

function ensureBundle(profile = 'web') {
  const wired = bundleVersion(profile)
  if (wired === SELF_VERSION) {
    ok(`bundle dsh-win32@${wired} already wired into the ${profile} profile`)
    return
  }
  if (wired !== undefined) {
    console.log(`bundle is dsh-win32@${wired}, this CLI is ${SELF_VERSION}; re-wiring...`)
  }
  if (findPnpm() === undefined) {
    console.log('pnpm not found, enabling it through corepack (ships with node)...')
    if (enablePnpmViaCorepack() === undefined) {
      warn('pnpm is missing and corepack could not enable it, so the wiring below will fail')
      info('install pnpm and re-run: npm install -g pnpm')
    } else {
      ok('pnpm enabled through corepack')
    }
  }
  if (wired === undefined) console.log(`wiring the dsh-win32 bundle into the ${profile} profile (one-time)...`)
  // The profile carries a pnpm minimum-release-age gate, and its exclude list
  // only ever names the version current at wiring time, so a release published
  // today is invisible to an upgrade and pnpm answers "Already up to date"
  // (#17). We scope the override to this one install rather than editing the
  // profile's policy file, which would weaken it permanently, and we say so
  // rather than overriding a supply-chain protection silently.
  info(`installing the exact version you invoked (${SELF_VERSION}) and overriding pnpm's minimum-release-age for this install only`)
  info('the profile\'s own policy file is left untouched')
  // -w: the profile dir is a pnpm workspace root; pnpm 10+ refuses a bare add there.
  runDshPlugin(['--profile', profile, 'add', '-w', `dsh-win32@${SELF_VERSION}`, '--config.minimumReleaseAge=0'])
}

function fix() {
  const broken = scanKoffi().filter(({ version, loadable }) => version === '3.1.3' || version === '3.1.4' || !loadable)
  if (broken.length === 0) {
    ok('nothing to fix, every installed koffi version is supported and loads at runtime')
    return
  }
  for (const { profile, version, loadable } of broken) {
    console.log(`${loadable ? 'pinning' : 'repairing'} koffi ${version} -> 3.1.2 in profile "${profile}"...`)
    runDshPlugin(['--profile', profile, 'add', '-w', 'koffi@3.1.2', '--ignore-scripts', '--force'])
  }
  const remaining = scanKoffi().filter(({ version, loadable }) => version === '3.1.3' || version === '3.1.4' || !loadable)
  if (remaining.length > 0) {
    bad(`koffi still cannot load in ${remaining.map(({ profile }) => `"${profile}"`).join(', ')}`)
    process.exitCode = 1
  } else {
    ok('koffi 3.1.2 installed and runtime load verified; restart dsh web')
  }
}

/** setup rewrites on purpose: the user asked for this shell explicitly. */
function substitutePreset(presetId, shellPath) {
  const targetDir = join(DSH_HOME, '.agent-presets', presetId)
  rmSync(targetDir, { recursive: true, force: true })
  const outcome = installPreset(presetId, shellPath, DSH_HOME)
  if (outcome.status === 'failed') throw new Error(`preset ${presetId} could not be written: ${outcome.detail}`)
  return targetDir
}

const BUSYBOX_URL = 'https://frippery.org/files/busybox/busybox64.exe'

/** busybox-w32 is GPLv2 and therefore never bundled; fetched on explicit consent. */
async function ensureBusybox() {
  const target = busyboxPath()
  if (existsSync(target)) return target
  console.log(`downloading busybox-w32 (GPLv2, single executable) from ${BUSYBOX_URL}`)
  console.log('project https://frippery.org/busybox, not bundled with dsh-win32, fetched on demand')
  mkdirSync(dirname(target), { recursive: true })
  let response
  try {
    response = await fetch(BUSYBOX_URL)
  } catch (error) {
    console.error('busybox download failed (network). If frippery.org is unreachable from your network,')
    console.error('download busybox64.exe manually and pass it: npx dsh-win32 setup --sandboxed --busybox <path>')
    throw error
  }
  if (!response.ok) throw new Error(`busybox download failed with HTTP ${response.status}. Pass --busybox <path> to use a local copy instead`)
  writeFileSync(target, Buffer.from(await response.arrayBuffer()))
  return target
}

function createShortcut() {
  const script = [
    '$shell = New-Object -ComObject WScript.Shell',
    '$desktop = [Environment]::GetFolderPath("Desktop")',
    '$lnk = $shell.CreateShortcut((Join-Path $desktop "DeepSeek Harness.lnk"))',
    '$lnk.TargetPath = "cmd.exe"',
    '$lnk.Arguments = "/c npx @deepseek-ai/dsh web"',
    // Without this the shortcut inherits whatever cwd Explorer hands it, which
    // can be System32. dsh resolves the profile from DSH_HOME rather than cwd,
    // so this is about where a relative path in the session lands, not startup.
    '$lnk.WorkingDirectory = [Environment]::GetFolderPath("UserProfile")',
    '$lnk.Description = "Start DeepSeek Harness (opens a console, then a browser tab)"',
    '$lnk.Save()',
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
}

function profileFrom(args) {
  const index = args.indexOf('--profile')
  const profile = index === -1 ? 'web' : args[index + 1]
  if (profile === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) {
    console.error('setup: --profile needs one safe profile name')
    process.exit(1)
  }
  return profile
}

function claimSetupStarPrompt() {
  const marker = join(DSH_HOME, '.dsh-win32-star-prompted')
  if (existsSync(marker)) return false
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    writeFileSync(marker, `${new Date().toISOString()}\n`, { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

async function offerSetupStar() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !claimSetupStarPrompt()) return

  const githubCli = WIN ? 'gh.exe' : 'gh'
  const canStar = tryExec(githubCli, ['auth', 'status', '--hostname', 'github.com']) !== undefined

  if (canStar) {
    try {
      execFileSync(githubCli, ['api', '--method', 'PUT', 'user/starred/sjh9714/dsh-win32'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      console.log('  Starred dsh-win32 with your authenticated GitHub account')
      return
    } catch {
      warn('GitHub did not accept the Star request; opening the repository instead')
    }
  }

  try {
    execFileSync('rundll32.exe', ['url.dll,FileProtocolHandler', REPO], { windowsHide: true })
    console.log('  opened GitHub in your default browser; the final Star click is yours')
  } catch {
    console.log(`  could not open the browser; visit ${REPO}`)
  }
}

async function setupCurrent(args) {
  const profile = profileFrom(args)
  if (!WIN) {
    console.error('setup: current DSH Windows setup is Windows-only')
    process.exit(1)
  }
  const health = doctor({ profile })
  console.log('')
  if (!health.official) {
    console.error('setup: the published DSH release does not expose the complete official Windows stack')
    console.error('update DSH or run npx dsh-win32 setup --legacy for an rc.6-era installation')
    process.exit(1)
  }
  console.log('current DSH already includes persistent PowerShell and the Windows Workspace Write sandbox')
  console.log('dsh-win32 did not install a bundle, custom preset, Git Bash, busybox, or another program')
  if (args.includes('--sandboxed')) {
    console.log('--sandboxed is no longer needed; the official preset uses Workspace Write directly')
  }

  if (profile === 'web' && !args.includes('--no-shortcut')) {
    try {
      createShortcut()
      console.log('created desktop shortcut "DeepSeek Harness"')
    } catch {
      warn('could not create the desktop shortcut. Start with: npx @deepseek-ai/dsh web')
    }
  }

  console.log('')
  console.log('next, in order:')
  if (profile === 'web' && !args.includes('--no-shortcut')) {
    console.log('  1. double-click "DeepSeek Harness" on your desktop')
  } else {
    console.log(profile === 'web'
      ? '  1. npx @deepseek-ai/dsh web'
      : `  1. start or restart the DSH host that uses profile "${profile}"`)
  }
  console.log('  2. add a workspace from the sidebar')
  console.log('  3. choose the stock Minimal preset and keep Workspace Write enabled')
  await offerSetupStar()
  console.log('')
  console.log(`${REPO}  (Windows fixes, doctor output, and legacy rc.6 support)`)
}

async function setupLegacy(args) {
  const bashFlagIndex = args.indexOf('--bash')
  const explicitBash = bashFlagIndex !== -1 ? args[bashFlagIndex + 1] : undefined
  const profile = profileFrom(args)
  const { gitBash } = doctor({ legacy: true, profile })
  console.log('')

  const sandboxed = args.includes('--sandboxed')
  const bashPath = explicitBash ?? gitBash
  if (bashPath === undefined && !sandboxed) {
    console.error('setup: Git Bash is required for the minimal-windows preset (or pass --bash <path>)')
    process.exit(1)
  }
  if (!args.includes('--no-bundle')) {
    try {
      ensureBundle(profile)
    } catch {
      warn('bundle wiring failed. The preset still installs below; wire the bundle manually with')
      info(`npx --yes @deepseek-ai/dsh plugin --profile ${profile} add -w dsh-win32`)
    }
  }
  if (bashPath === undefined) {
    console.log('Git Bash was not found; skipped the "minimal-windows" preset')
  } else {
    const installed = substitutePreset(PRESET_ID, bashPath)
    console.log(`installed agent preset "${PRESET_ID}" -> ${installed}`)
    console.log('it appears in the preset picker immediately (no restart needed)')
  }

  if (sandboxed) {
    const busyboxFlag = args.indexOf('--busybox')
    const busybox = busyboxFlag !== -1 ? args[busyboxFlag + 1] : (WIN ? await ensureBusybox() : undefined)
    if (busybox === undefined) {
      console.error('setup: --sandboxed needs Windows (auto-download) or an explicit --busybox <path>')
      process.exit(1)
    }
    const sandboxed = substitutePreset('minimal-windows-sandboxed', busybox)
    console.log(`installed agent preset "minimal-windows-sandboxed" -> ${sandboxed}`)
    console.log('this variant stays inside the workspace-write sandbox (busybox ash, measured on CI)')
  }

  // On by default because the double-click is the point. `install.ps1` has
  // always passed --shortcut, so the scripted path got one and the far more
  // common `npx dsh-win32 setup` did not, which is two entry points with
  // different outcomes for no reason. --shortcut is still accepted so the
  // installer and anyone's notes keep working.
  if (profile === 'web' && WIN && !args.includes('--no-shortcut')) {
    try {
      createShortcut()
      console.log('created desktop shortcut "DeepSeek Harness" (skip it with --no-shortcut)')
    } catch {
      // A shortcut is a convenience, not part of a working install. Saying so
      // beats failing a setup that otherwise succeeded.
      warn('could not create the desktop shortcut; everything else is installed. Start with: npx @deepseek-ai/dsh web')
    }
  } else if (!WIN && args.includes('--shortcut')) {
    console.error('setup: --shortcut is Windows-only')
    process.exit(1)
  }

  console.log('')
  // A preset in the picker is not a working session. Three more things have to
  // happen and the first one has no in-product guidance at all, so a user who
  // gets this far still lands on a greyed-out composer with no hint (#14).
  console.log('next, in order:')
  if (profile === 'web' && WIN && !args.includes('--no-shortcut')) {
    console.log('  1. double-click "DeepSeek Harness" on your desktop  (or: npx @deepseek-ai/dsh web)')
    console.log('     it opens a console, then use the EXACT url that console prints')
  } else {
    console.log(profile === 'web'
      ? '  1. npx @deepseek-ai/dsh web        (use the EXACT url it prints)'
      : `  1. start or restart the DSH host that uses profile "${profile}"`)
  }
  console.log('  2. sidebar > Workspaces > folder icon, and add a workspace')
  console.log('     until you do, the composer is greyed out and takes no input')
  if (sandboxed) {
    console.log('  3. preset picker > "Minimal (Windows, sandboxed)", leave the badge on Workspace Write')
  } else {
    console.log('  3. preset picker > "Minimal (Windows)", then switch the badge to danger-full-access')
    console.log('     (Git Bash cannot run in the sandbox; re-run with --sandboxed for a preset that can)')
  }
  console.log('')
  console.log(`${REPO}  (docs, known Windows traps, and where to report what broke)`)
}

async function main([command, ...rest]) {
  if (command === 'setup') {
    if (rest.includes('--legacy')) await setupLegacy(rest.filter((arg) => arg !== '--legacy'))
    else await setupCurrent(rest)
  }
  else if (command === 'fix') fix()
  else if (command === 'doctor' || command === undefined) {
    // Exit codes apply to a direct `doctor` run only. `setup` calls doctor for
    // its report and decides for itself whether a finding is fatal.
    const profile = profileFrom(rest)
    process.exitCode = doctor({
      json: rest.includes('--json'),
      remediation: rest.includes('--remediation'),
      legacy: rest.includes('--legacy'),
      profile,
    }).exitCode
  } else {
    console.error(`unknown command ${JSON.stringify(command)}. Usage is dsh-win32 [doctor [--json] [--remediation] [--legacy]|setup [--profile <name>] [--no-shortcut] [--sandboxed]|setup --legacy [--bash <path>] [--no-bundle] [--sandboxed [--busybox <path>]]|fix]`)
    process.exit(1)
  }
}

/**
 * Is this process running the CLI, rather than importing it for its exports.
 *
 * Both sides go through realpath, and the reason is that `npx dsh-win32
 * doctor` printed NOTHING and exited 0 on macOS and Linux until this was
 * fixed. On POSIX, npm installs a bin as a SYMLINK in `node_modules/.bin`, so
 * `process.argv[1]` is the symlink while `import.meta.url` is the real file.
 * `resolve()` normalizes a path but does not follow symlinks, the comparison
 * was false, and `main()` simply never ran. Windows was unaffected because npm
 * writes a `.cmd` shim there that invokes the real path, which is why a
 * Windows-facing tool shipped this for thirteen releases without a report.
 * @returns true when this module is the entry point.
 */
function runningAsCli() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (runningAsCli()) {
  await main(process.argv.slice(2))
}
