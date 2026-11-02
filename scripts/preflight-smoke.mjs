// Runs the real CLI against an installed DSH and the live registry, in a
// throwaway profile. Unit tests stub both, and on Windows this is the only
// place the PowerShell and PATH checks meet a real machine.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const manifest = process.argv[2]
if (manifest === undefined) throw new Error('usage: node scripts/preflight-smoke.mjs <installed dsh package.json> [--require-reviewed]')
const requireReviewed = process.argv.includes('--require-reviewed')
const installed = JSON.parse(readFileSync(manifest, 'utf8')).version
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/cli.mjs')

function snapshot(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return snapshot(root, path)
    return [`${relative(root, path)}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`]
  }).sort()
}

const home = mkdtempSync(join(tmpdir(), 'dsh-preflight-smoke-'))
try {
  const profile = join(home, 'profiles', 'smoke')
  const plugin = join(profile, 'node_modules', 'dsh-smoke-plugin')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-smoke-plugin': '1.0.0' } }))
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-smoke-plugin', version: '1.0.0', engines: { dsh: '*' } }))

  const before = snapshot(home)
  const run = spawnSync(process.execPath, [cli, 'preflight', '--json', '--profile', 'smoke'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, DSH_WIN32_VERIFY_DSH: manifest },
  })
  const report = JSON.parse(run.stdout)
  const status = name => report.checks.find(check => check.name === name)?.status
  const windows = process.platform === 'win32'
  const failures = [
    report.schema !== 'dsh-preflight/v1' && `schema ${report.schema}`,
    run.status !== report.exitCode && `process exited ${run.status}, report says ${report.exitCode}`,
    ![0, 1, 2].includes(run.status) && `exit ${run.status}`,
    report.installed !== installed && `installed ${report.installed}, expected ${installed}`,
    report.target.resolved === undefined && 'latest did not resolve from the registry',
    status('plugins') !== 'pass' && `plugins ${status('plugins')}`,
    status('powershell') !== (windows ? 'pass' : 'skip') && `powershell ${status('powershell')}`,
    status('path') !== (windows ? 'pass' : 'skip') && `path ${status('path')}`,
    JSON.stringify(snapshot(home)) !== JSON.stringify(before) && 'preflight changed the profile',
    requireReviewed && status('release_notes') !== 'pass' && `release rules need a review for ${report.target.resolved}, see docs/releasing.md`,
  ].filter(Boolean)
  if (failures.length > 0) {
    console.error(run.stdout, run.stderr)
    throw new Error(`preflight smoke failed: ${failures.join('; ')}`)
  }
  console.log(`preflight smoke ok: ${installed} -> ${report.target.resolved}, exit ${run.status}, ${JSON.stringify(report.summary)}`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
