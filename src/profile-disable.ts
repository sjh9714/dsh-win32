/** Offline bundle deactivation. Never import the host, run package scripts, or evaluate profile YAML. */
import { closeSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isSeq, parseDocument } from 'yaml'

const MAX_BYTES = 1024 * 1024
const GUIDE = 'https://github.com/sjh9714/dsh-win32/blob/master/docs/uninstall.md'

export interface DisableOptions {
  home: string
  profile?: string
  profileDir?: string
  apply?: boolean
}

export interface DisableResult {
  status: 'preview' | 'disabled' | 'already-disabled'
  manifestPath: string
  backupPath?: string
  notes: string[]
}

function directory(path: string): string {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('refusing a linked or non-directory profile path')
  return realpathSync(path)
}

function profileDirectory({ home, profile, profileDir }: DisableOptions): string {
  if (profileDir !== undefined) {
    if (profile !== undefined) throw new Error('choose either --profile or --profile-dir')
    return directory(resolve(profileDir))
  }
  const name = profile ?? 'web'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.toLowerCase() === 'node_modules') {
    throw new Error('--profile needs one safe profile name')
  }
  const profiles = directory(join(realpathSync(home), 'profiles'))
  return directory(join(profiles, name))
}

function readManifest(path: string): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
    throw new Error('refusing a linked, non-file, or oversized package.json')
  }
  const bytes = readFileSync(path)
  if (bytes.length > MAX_BYTES) throw new Error('package.json exceeds the recovery size limit')
  return bytes
}

/** Replace only the activation array's text; preserve unrelated values, precision, and formatting. */
function deactivate(bytes: Buffer): Buffer | undefined {
  const source = bytes.toString('utf8')
  if (!Buffer.from(source).equals(bytes)) throw new Error('package.json must be valid UTF-8')
  let parsed
  try { parsed = JSON.parse(source) } catch { throw new Error('invalid JSON in package.json; inspect it locally') }
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(parsed)) throw new Error('package.json must contain an object')
  const doc = parseDocument(source, { schema: 'json', uniqueKeys: true, prettyErrors: false, logLevel: 'silent' })
  if (doc.errors.length > 0) throw new Error('ambiguous package.json, including duplicate keys; inspect it locally')
  if (parsed.dsh === undefined) return undefined
  if (!object(parsed.dsh)) throw new Error('invalid dsh metadata in package.json')
  if (parsed.dsh.profile === undefined) return undefined
  if (!object(parsed.dsh.profile)) throw new Error('invalid dsh.profile metadata in package.json')
  const bundles = parsed.dsh.profile.bundles
  if (bundles === undefined) return undefined
  if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) {
    throw new Error('dsh.profile.bundles must be an array of package names')
  }
  if (!bundles.includes('dsh-win32')) return undefined
  const node = doc.getIn(['dsh', 'profile', 'bundles'], true)
  if (!isSeq(node) || node.range == null) throw new Error('cannot locate the bundle list safely')
  return Buffer.from(source.slice(0, node.range[0])
    + JSON.stringify(bundles.filter(name => name !== 'dsh-win32')) + source.slice(node.range[1]))
}

function manualNotes(dir: string): string[] {
  const notes = [
    'Dependencies, lockfiles, presets, custom patches, shortcuts and sessions are retained.',
    'Start a new session with the official stock Minimal preset and Workspace Write; do not resume a legacy preset.',
    `For manual patch recovery, full uninstall and backup restoration: ${GUIDE}`,
  ]
  for (const name of ['cordis.patch.yml', 'cordis.yml']) {
    try {
      const file = join(dir, name)
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) {
        notes.push(`${name} could not be inspected safely; review it locally.`)
      } else if (/dsh-win32|subprocess-windows|minimal-windows/.test(readFileSync(file, 'utf8'))) {
        notes.push(`${name} mentions legacy Windows components; review custom entries using the uninstall guide. It was not changed.`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') notes.push(`${name} could not be read; review it locally.`)
    }
  }
  return notes
}

/**
 * Remove only the exact dsh-win32 activation entry from one existing profile.
 * Uses the host's exclusive package.json.lock protocol and a same-filesystem
 * atomic replacement. The original bytes remain in a unique private backup.
 */
export function disableProfile(options: DisableOptions): DisableResult {
  let backupPath: string | undefined
  try {
    const dir = profileDirectory(options)
    const manifestPath = join(dir, 'package.json')
    const original = readManifest(manifestPath)
    const next = deactivate(original)
    const notes = manualNotes(dir)
    if (next === undefined) return { status: 'already-disabled', manifestPath, notes }
    if (!options.apply) return { status: 'preview', manifestPath, notes }

    // Never steal an existing lock, even if its owner appears to have stopped.
    const lockPath = `${manifestPath}.lock`
    let lock: number
    try { lock = openSync(lockPath, 'wx', 0o600) } catch {
      throw new Error('could not acquire package.json.lock; stop the host/package operation and inspect the lock locally')
    }
    try {
      writeFileSync(lock, `${process.pid}\n`)
      if (!readManifest(manifestPath).equals(original)) throw new Error('package.json changed during preview; run the command again')
      const backupDir = mkdtempSync(join(dir, '.dsh-win32-backup-'))
      const originalPath = join(backupDir, 'package.json')
      const saved = openSync(originalPath, 'wx', 0o600)
      try { writeFileSync(saved, original); fsyncSync(saved) } finally { closeSync(saved) }
      backupPath = originalPath
      const replacement = join(backupDir, 'next-package.json')
      const pending = openSync(replacement, 'wx', 0o600)
      try { writeFileSync(pending, next); fsyncSync(pending) } finally { closeSync(pending) }
      if (!readManifest(manifestPath).equals(original)) throw new Error('package.json changed during backup; replacement was stopped')
      renameSync(replacement, manifestPath)
      return { status: 'disabled', manifestPath, backupPath, notes }
    } finally {
      closeSync(lock)
      unlinkSync(lockPath)
    }
  } catch (error) {
    // Native/JSON errors can contain configuration excerpts; expose only our
    // fixed diagnostics or a filesystem error code, plus a recoverable backup.
    const code = (error as NodeJS.ErrnoException).code
    const detail = code === undefined ? (error as Error).message : `profile files could not be accessed (${code})`
    throw new Error(`${detail}${backupPath === undefined ? '' : `; original backup: ${backupPath}`}`)
  }
}
