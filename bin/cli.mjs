#!/usr/bin/env node
/**
 * dsh-win32 CLI: `doctor` diagnoses the known DSH-on-Windows traps,
 * `setup` installs the minimal-windows agent preset (and optionally a
 * desktop shortcut). Zero dependencies.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      results.push({ profile, version: JSON.parse(readFileSync(manifest, 'utf8')).version })
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
function collectChecks() {
  const checks = []
  const add = (name, status, detail) => checks.push({ name, status, detail })

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
  if (pnpm !== undefined) add('pnpm', 'pass', pnpm)
  else add('pnpm', 'warn', 'pnpm not found. The bundle installs into the profile dir with pnpm, so wiring fails without it. setup enables it through corepack, or: npm install -g pnpm')

  // Not a vocabulary name, so it carries the vendor prefix the contract asks for.
  const wiredBundle = bundleVersion()
  if (wiredBundle === undefined) add('dsh-win32/bundle', 'warn', `not wired into the web profile; run: npx dsh-win32 setup`)
  else if (wiredBundle === SELF_VERSION) add('dsh-win32/bundle', 'pass', wiredBundle)
  else add('dsh-win32/bundle', 'warn', `profile runs ${wiredBundle}, this CLI is ${SELF_VERSION}; the runtime lives in the bundle, so run: npx dsh-win32 setup`)

  const gitBash = WIN ? findGitBash() : undefined
  if (!WIN) {
    for (const name of ['git_bash', 'powershell', 'koffi', 'sandbox_shell', 'write_fence']) add(name, 'skip', NOT_WINDOWS)
    return { checks, gitBash }
  }

  if (gitBash === undefined) add('git_bash', 'fail', 'Git Bash not found. Install from https://git-scm.com (winget install Git.Git), then re-run')
  else if (isBashWrapper(gitBash)) add('git_bash', 'warn', `${gitBash} is the 47KB wrapper, not the real shell; the PTY pid lands on the wrapper (see #7)`)
  else add('git_bash', 'pass', gitBash)

  const pwsh7 = findPwsh7()
  if (pwsh7 !== undefined) add('powershell', 'pass', pwsh7)
  else add('powershell', 'warn', 'PowerShell 7 not found. The Windows 5.1 fallback crashes (0xC0000142) inside the DSH sandbox; winget install Microsoft.PowerShell')

  const koffi = scanKoffi()
  const brokenKoffi = koffi.filter(({ version }) => version === '3.1.3' || version === '3.1.4')
  if (brokenKoffi.length > 0) {
    const where = brokenKoffi.map(({ profile, version }) => `${version} in "${profile}"`).join(', ')
    add('koffi', 'warn', `broken win32-x64 prebuilt (${where}); install failures, folder-picker and session-save crashes. Run: npx dsh-win32 fix`)
  } else if (koffi.length === 0) add('koffi', 'pass', 'no koffi found in any profile')
  else add('koffi', 'pass', koffi.map(({ profile, version }) => `${version} in "${profile}"`).join(', '))

  // MSYS bash dies under the workspace-write restricted token, so without the
  // busybox variant a sandboxed session has no working shell at all (#6).
  if (existsSync(join(DSH_HOME, '.agent-presets', 'minimal-windows-sandboxed'))) {
    add('sandbox_shell', 'pass', 'minimal-windows-sandboxed installed; persistent shell works inside workspace-write')
  } else {
    add('sandbox_shell', 'warn', 'only the Git Bash preset is installed, which needs danger-full-access. For a shell that survives the workspace-write sandbox: npx dsh-win32 setup --sandboxed')
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
    add('write_fence', 'warn', `${unfenced.map(({ name }) => name).join(', ')} predates the write fence, so str_replace_editor can write outside the workspace under Read Only. Re-run: npx dsh-win32 setup`)
  }

  return { checks, gitBash }
}

const RENDER = { pass: ok, warn, fail: bad, skip: message => console.log(`  skip  ${message}`) }

function summarize(checks) {
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const { status } of checks) summary[status] += 1
  // Contract exit semantics: 0 all pass, 1 any warn, 2 any fail. skip is neither.
  const exitCode = summary.fail > 0 ? 2 : summary.warn > 0 ? 1 : 0
  return { summary, exitCode }
}

function doctor({ json = false } = {}) {
  const { checks, gitBash } = collectChecks()
  const { summary, exitCode } = summarize(checks)

  if (json) {
    console.log(JSON.stringify({
      schema: 'dsh-doctor/v1',
      generatedAt: new Date().toISOString(),
      profile: null,
      exitCode,
      summary,
      ok: summary.fail === 0,
      checks,
    }, null, 2))
    return { gitBash, exitCode }
  }

  console.log(`dsh-win32 doctor (platform: ${process.platform})`)
  for (const { name, status, detail } of checks) RENDER[status](`${name}: ${detail}`)
  if (!WIN) info('not Windows, so the Windows traps are skipped rather than reported')
  info('open the EXACT url dsh prints (localhost vs 127.0.0.1 are different origins; the wrong one 403s every /api call)')
  info('one-command install: npx dsh-win32 setup  (wires bundle + preset + health report)')
  info('machine-readable output: npx dsh-win32 doctor --json  (dsh-doctor/v1 envelope)')
  info(`${REPO}  (issues and real-hardware reports welcome)`)
  return { gitBash, exitCode }
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

function ensureBundle() {
  const wired = bundleVersion()
  if (wired === SELF_VERSION) {
    ok(`bundle dsh-win32@${wired} already wired into the web profile`)
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
  if (wired === undefined) console.log('wiring the dsh-win32 bundle into the web profile (one-time)...')
  // The profile carries a pnpm minimum-release-age gate, and its exclude list
  // only ever names the version current at wiring time, so a release published
  // today is invisible to an upgrade and pnpm answers "Already up to date"
  // (#17). We scope the override to this one install rather than editing the
  // profile's policy file, which would weaken it permanently, and we say so
  // rather than overriding a supply-chain protection silently.
  info(`installing the exact version you invoked (${SELF_VERSION}) and overriding pnpm's minimum-release-age for this install only`)
  info('the profile\'s own policy file is left untouched')
  // -w: the profile dir is a pnpm workspace root; pnpm 10+ refuses a bare add there.
  runDshPlugin(['--profile', 'web', 'add', '-w', `dsh-win32@${SELF_VERSION}`, '--config.minimumReleaseAge=0'])
}

function fix() {
  const broken = scanKoffi().filter(({ version }) => version === '3.1.3' || version === '3.1.4')
  if (broken.length === 0) {
    ok('nothing to fix, no broken koffi prebuilt found in any profile')
    return
  }
  for (const { profile, version } of broken) {
    console.log(`pinning koffi ${version} -> 3.1.2 in profile "${profile}"...`)
    runDshPlugin(['--profile', profile, 'add', '-w', 'koffi@3.1.2', '--ignore-scripts'])
  }
  ok('koffi pinned; restart dsh web')
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
    '$lnk.Save()',
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
}

async function setup(args) {
  const bashFlagIndex = args.indexOf('--bash')
  const explicitBash = bashFlagIndex !== -1 ? args[bashFlagIndex + 1] : undefined
  const { gitBash } = doctor()
  console.log('')

  const bashPath = explicitBash ?? gitBash
  if (bashPath === undefined) {
    console.error('setup: Git Bash is required for the minimal-windows preset (or pass --bash <path>)')
    process.exit(1)
  }
  if (!args.includes('--no-bundle')) {
    try {
      ensureBundle()
    } catch {
      warn('bundle wiring failed. The preset still installs below; wire the bundle manually with')
      info('npx --yes @deepseek-ai/dsh plugin --profile web add -w dsh-win32')
    }
  }
  const installed = substitutePreset(PRESET_ID, bashPath)
  console.log(`installed agent preset "${PRESET_ID}" -> ${installed}`)
  console.log('it appears in the preset picker immediately (no restart needed)')

  if (args.includes('--sandboxed')) {
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

  if (args.includes('--shortcut')) {
    if (!WIN) {
      console.error('setup: --shortcut is Windows-only')
      process.exit(1)
    }
    createShortcut()
    console.log('created desktop shortcut "DeepSeek Harness"')
  }

  console.log('')
  // A preset in the picker is not a working session. Three more things have to
  // happen and the first one has no in-product guidance at all, so a user who
  // gets this far still lands on a greyed-out composer with no hint (#14).
  const sandboxed = args.includes('--sandboxed')
  console.log('next, in order:')
  console.log('  1. npx @deepseek-ai/dsh web        (use the EXACT url it prints)')
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
  if (command === 'setup') await setup(rest)
  else if (command === 'fix') fix()
  else if (command === 'doctor' || command === undefined) {
    // Exit codes apply to a direct `doctor` run only. `setup` calls doctor for
    // its report and decides for itself whether a finding is fatal.
    process.exitCode = doctor({ json: rest.includes('--json') }).exitCode
  } else {
    console.error(`unknown command ${JSON.stringify(command)}. Usage is dsh-win32 [doctor [--json]|setup|fix] [--bash <path>] [--shortcut] [--no-bundle] [--sandboxed [--busybox <path>]]`)
    process.exit(1)
  }
}

// Only dispatch when run as the CLI. The test suite imports this module for
// its exports and must not trigger a command as a side effect.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
