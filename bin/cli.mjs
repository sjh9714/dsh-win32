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
    const candidate = join(root, 'Git', 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
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

  info('open the EXACT url dsh prints (localhost vs 127.0.0.1 are different origins; the wrong one 403s every /api call)')
  info(`bundle install: dsh plugin --profile web add dsh-win32  (then: npx dsh-win32 setup)`)
  return { gitBash }
}

function substitutePreset(bashPath) {
  const targetDir = join(DSH_HOME, '.agent-presets', PRESET_ID)
  mkdirSync(targetDir, { recursive: true })
  const forwardSlashes = bashPath.replaceAll('\\', '/')
  const roster = readFileSync(join(PRESET_SRC, 'agent.cordis.yml'), 'utf8')
    .replaceAll('__DSH_WINDOWS_BASH__', forwardSlashes)
  writeFileSync(join(targetDir, 'agent.cordis.yml'), roster)
  writeFileSync(join(targetDir, 'preset.yml'), readFileSync(join(PRESET_SRC, 'preset.yml'), 'utf8'))
  return targetDir
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

function setup(args) {
  const bashFlagIndex = args.indexOf('--bash')
  const explicitBash = bashFlagIndex !== -1 ? args[bashFlagIndex + 1] : undefined
  const { gitBash } = doctor()
  console.log('')

  const bashPath = explicitBash ?? gitBash
  if (bashPath === undefined) {
    console.error('setup: Git Bash is required for the minimal-windows preset (or pass --bash <path>)')
    process.exit(1)
  }
  const installed = substitutePreset(bashPath)
  console.log(`installed agent preset "${PRESET_ID}" -> ${installed}`)
  console.log('it appears in the preset picker immediately (no restart needed)')

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
if (command === 'setup') setup(rest)
else if (command === 'doctor' || command === undefined) doctor()
else {
  console.error(`unknown command ${JSON.stringify(command)} — use: dsh-win32 [doctor|setup] [--bash <path>] [--shortcut]`)
  process.exit(1)
}
