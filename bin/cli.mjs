#!/usr/bin/env node
/**
 * dsh-win32 CLI: `doctor` diagnoses the known DSH-on-Windows traps,
 * `setup` installs the minimal-windows agent preset (and optionally a
 * desktop shortcut). Zero dependencies.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const WIN = process.platform === 'win32'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PRESET_ID = 'minimal-windows'
const PRESET_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'preset', PRESET_ID)

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

/** Locate a Git Bash bash.exe, never the WSL launcher in System32. */
function findGitBash() {
  const explicit = process.env.DSH_WINDOWS_BASH
  if (explicit !== undefined && existsSync(explicit)) return explicit
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]
  for (const root of roots) {
    if (root === undefined) continue
    // usr\bin is the real shell; bin\bash.exe is a 47KB wrapper that respawns
    // it, leaving the PTY pid pointing at the wrapper (#7's SIGKILL-guard trap).
    for (const rel of [['Git', 'usr', 'bin', 'bash.exe'], ['Git', 'bin', 'bash.exe']]) {
      const candidate = join(root, ...rel)
      if (existsSync(candidate)) return candidate
    }
  }
  const located = tryExec('where.exe', ['bash'])
  for (const line of (located ?? '').split(/\r?\n/)) {
    const path = line.trim()
    if (path !== '' && !/system32/i.test(path) && existsSync(path)) return path
  }
  return undefined
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

function doctor() {
  console.log(`dsh-win32 doctor (platform: ${process.platform})`)

  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major > 22 || (major === 22 && minor >= 19)) ok(`node ${process.versions.node}`)
  else bad(`node ${process.versions.node} — DSH needs ^22.19.0 || >=24`)

  const gitBash = WIN ? findGitBash() : undefined
  if (WIN) {
    if (gitBash !== undefined) ok(`Git Bash: ${gitBash}`)
    else bad('Git Bash not found — install from https://git-scm.com (winget install Git.Git), then re-run')

    const pwsh7 = findPwsh7()
    if (pwsh7 !== undefined) ok(`PowerShell 7: ${pwsh7}`)
    else warn('PowerShell 7 not found — the Windows 5.1 fallback crashes (0xC0000142) inside the DSH sandbox; winget install Microsoft.PowerShell')

    for (const { profile, version } of scanKoffi()) {
      if (version === '3.1.3' || version === '3.1.4') {
        warn(`koffi ${version} in profile "${profile}" — broken win32-x64 prebuilt (install failures, folder-picker and session-save crashes)`)
        info(`fix: cd "${join(DSH_HOME, 'profiles', profile)}" && pnpm add koffi@3.1.2 --ignore-scripts`)
      } else {
        ok(`koffi ${version} in profile "${profile}"`)
      }
    }
  } else {
    info('not Windows — doctor checks the Windows traps only when run there')
  }

  if (WIN) {
    warn('mode matters: the Git Bash preset (minimal-windows) needs danger-full-access — MSYS bash dies inside the workspace-write sandbox')
    info('to stay sandboxed, install the busybox variant: npx dsh-win32 setup --sandboxed  (then pick "Minimal (Windows, sandboxed)")')
  }
  info('open the EXACT url dsh prints (localhost vs 127.0.0.1 are different origins; the wrong one 403s every /api call)')
  info(`one-command install: npx dsh-win32 setup  (wires bundle + preset + health report)`)
  return { gitBash }
}

function bundleInstalled(profile = 'web') {
  const manifest = join(DSH_HOME, 'profiles', profile, 'package.json')
  if (!existsSync(manifest)) return false
  try {
    return (JSON.parse(readFileSync(manifest, 'utf8')).dsh?.profile?.bundles ?? []).includes('dsh-win32')
  } catch {
    return false
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
  if (bundleInstalled()) {
    ok('bundle dsh-win32 already wired into the web profile')
    return
  }
  console.log('wiring the dsh-win32 bundle into the web profile (one-time)...')
  // -w: the profile dir is a pnpm workspace root; pnpm 10+ refuses a bare add there.
  runDshPlugin(['--profile', 'web', 'add', '-w', 'dsh-win32'])
}

function fix() {
  const broken = scanKoffi().filter(({ version }) => version === '3.1.3' || version === '3.1.4')
  if (broken.length === 0) {
    ok('nothing to fix — no broken koffi prebuilt found in any profile')
    return
  }
  for (const { profile, version } of broken) {
    console.log(`pinning koffi ${version} -> 3.1.2 in profile "${profile}"...`)
    runDshPlugin(['--profile', profile, 'add', '-w', 'koffi@3.1.2', '--ignore-scripts'])
  }
  ok('koffi pinned; restart dsh web')
}

function substitutePreset(presetId, shellPath) {
  const sourceDir = join(dirname(PRESET_SRC), presetId)
  const targetDir = join(DSH_HOME, '.agent-presets', presetId)
  mkdirSync(targetDir, { recursive: true })
  const forwardSlashes = shellPath.replaceAll('\\', '/')
  const roster = readFileSync(join(sourceDir, 'agent.cordis.yml'), 'utf8')
    .replaceAll('__DSH_WINDOWS_BASH__', forwardSlashes)
  writeFileSync(join(targetDir, 'agent.cordis.yml'), roster)
  writeFileSync(join(targetDir, 'preset.yml'), readFileSync(join(sourceDir, 'preset.yml'), 'utf8'))
  return targetDir
}

const BUSYBOX_URL = 'https://frippery.org/files/busybox/busybox64.exe'

/** busybox-w32 is GPLv2 and therefore never bundled; fetched on explicit consent. */
async function ensureBusybox() {
  const target = join(DSH_HOME, 'dsh-win32', 'busybox64.exe')
  if (existsSync(target)) return target
  console.log(`downloading busybox-w32 (GPLv2, single executable) from ${BUSYBOX_URL}`)
  console.log('project: https://frippery.org/busybox — not bundled with dsh-win32, fetched on demand')
  mkdirSync(dirname(target), { recursive: true })
  let response
  try {
    response = await fetch(BUSYBOX_URL)
  } catch (error) {
    console.error('busybox download failed (network). If frippery.org is unreachable from your network,')
    console.error('download busybox64.exe manually and pass it: npx dsh-win32 setup --sandboxed --busybox <path>')
    throw error
  }
  if (!response.ok) throw new Error(`busybox download failed: HTTP ${response.status} — or pass --busybox <path> manually`)
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
      warn('bundle wiring failed — the preset still installs below; wire the bundle manually with:')
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
}

const [, , command, ...rest] = process.argv
if (command === 'setup') await setup(rest)
else if (command === 'fix') fix()
else if (command === 'doctor' || command === undefined) doctor()
else {
  console.error(`unknown command ${JSON.stringify(command)} — use: dsh-win32 [doctor|setup|fix] [--bash <path>] [--shortcut] [--no-bundle] [--sandboxed [--busybox <path>]]`)
  process.exit(1)
}
