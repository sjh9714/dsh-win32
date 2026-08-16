/**
 * Preset installation, shared by the CLI and by plugin activation.
 *
 * Presets in DSH are plain directories under `$DSH_HOME/.agent-presets/`, so a
 * plugin can put its own there when it loads. That is what makes
 * `dsh plugin add dsh-win32` a complete install rather than a half one, and it
 * matches how the rest of the ecosystem ships presets.
 *
 * Two rules the install has to respect. It is idempotent, so an existing
 * directory is left alone rather than overwritten, since a user may have
 * edited the roster. And it never throws, because this runs during plugin
 * construction and a preset that cannot be written is not a reason to take the
 * subprocess runtime down with it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

export const PRESET_IDS = ['minimal-windows', 'minimal-windows-sandboxed'] as const
export type PresetId = typeof PRESET_IDS[number]

export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Where `setup --sandboxed` puts the busybox it downloads. */
export function busyboxPath(): string {
  return join(dshHome(), 'dsh-win32', 'busybox64.exe')
}

function presetSource(presetId: string): string {
  // lib/ at runtime, src/ under the test loader; the preset dir is a sibling of both.
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'preset', presetId)
}

/**
 * Locate a Git Bash `bash.exe`, never the WSL launcher in System32 and never
 * the `Git\bin\bash.exe` wrapper when the real shell in `usr\bin` is present.
 */
export function findGitBash(): string | undefined {
  const explicit = process.env.DSH_WINDOWS_BASH
  if (explicit !== undefined && existsSync(explicit)) return explicit
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA !== undefined ? join(process.env.LOCALAPPDATA, 'Programs') : undefined,
  ]
  for (const root of roots) {
    if (root === undefined) continue
    for (const rel of [['Git', 'usr', 'bin', 'bash.exe'], ['Git', 'bin', 'bash.exe']]) {
      const candidate = join(root, ...rel)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export interface InstallOutcome {
  presetId: string
  status: 'installed' | 'exists' | 'skipped' | 'failed'
  detail: string
}

/** Write one preset, substituting the shell path. Existing directories win. */
export function installPreset(presetId: PresetId, shellPath: string, home = dshHome()): InstallOutcome {
  const targetDir = join(home, '.agent-presets', presetId)
  if (existsSync(join(targetDir, 'agent.cordis.yml'))) {
    return { presetId, status: 'exists', detail: targetDir }
  }
  try {
    const sourceDir = presetSource(presetId)
    mkdirSync(targetDir, { recursive: true })
    const roster = readFileSync(join(sourceDir, 'agent.cordis.yml'), 'utf8')
      .replaceAll('__DSH_WINDOWS_BASH__', shellPath.replaceAll('\\', '/'))
    writeFileSync(join(targetDir, 'agent.cordis.yml'), roster)
    writeFileSync(join(targetDir, 'preset.yml'), readFileSync(join(sourceDir, 'preset.yml'), 'utf8'))
    return { presetId, status: 'installed', detail: targetDir }
  } catch (error) {
    return { presetId, status: 'failed', detail: String(error) }
  }
}

/**
 * Install whatever can be installed without network access or user consent.
 *
 * The Git Bash preset needs a Git Bash. The sandboxed one needs a busybox that
 * only `setup --sandboxed` fetches, since busybox-w32 is GPLv2 and downloading
 * it silently during plugin load would be both a licence and a consent
 * problem. Missing either is `skipped`, not `failed`.
 */
export function installPresets(home = dshHome()): InstallOutcome[] {
  const outcomes: InstallOutcome[] = []

  const gitBash = findGitBash()
  if (gitBash === undefined) {
    outcomes.push({ presetId: 'minimal-windows', status: 'skipped', detail: 'no Git Bash found' })
  } else {
    outcomes.push(installPreset('minimal-windows', gitBash, home))
  }

  const busybox = busyboxPath()
  if (!existsSync(busybox)) {
    outcomes.push({ presetId: 'minimal-windows-sandboxed', status: 'skipped', detail: 'no busybox; run: npx dsh-win32 setup --sandboxed' })
  } else {
    outcomes.push(installPreset('minimal-windows-sandboxed', busybox, home))
  }

  return outcomes
}
