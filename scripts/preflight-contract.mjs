#!/usr/bin/env node
/**
 * Prove lib/preflight.js judges plugins the way the installed host does.
 * Usage: node scripts/preflight-contract.mjs <path to @deepseek-ai/dsh/package.json>
 *
 * app-boot is a sibling of the selected DSH in both the flattened npm tree and
 * pnpm's strict graph, so this reads it from there rather than resolving it
 * from this repository. A mismatch means upstream changed the rule.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { unmetRequirements } from '../lib/preflight.js'

const DSH = '@deepseek-ai/dsh'
const RUNTIMES = ['0.1.7-rc.1', '0.1.7', '0.2.0-rc.1', '0.2.1-rc.5', '0.2.2-alpha.2', '0.3.0']
const RANGES = ['^0.1.7', '>=0.1.7-0', '^0.1.0-rc.6 || ^0.1.7-alpha.1', '>=0.2.0-0 <0.3.0', '0.2.1-rc.5', '*', '', ' ', 'not a range', 'workspace:^', 'workspace:~', 'workspace:*', 'workspace:1.0.0']
const IDENTITY = { name: 'contract-plugin', version: '1.0.0' }

const manifests = [
  {},
  { engines: {} },
  { engines: { node: '>=1' } },
  { engines: 'x' },
  { engines: [] },
  { engines: null },
  { engines: { dsh: 1 } },
  { peerDependencies: 'x' },
  { peerDependencies: { [DSH]: 1 } },
  { peerDependencies: { '@deepseek-ai/cordis': '^1', other: '^1' } },
  { engines: { dsh: '>=0.2.0-0' }, peerDependencies: { [DSH]: '0.0.1' } },
  { engines: { dsh: '0.0.1' }, peerDependencies: { [DSH]: '*' } },
  ...RANGES.flatMap(range => [
    { engines: { dsh: range } },
    { peerDependencies: { [DSH]: range } },
    { peerDependencies: { [`${DSH}-tools`]: range, [DSH]: '*' } },
  ]),
].map(fields => ({ ...IDENTITY, ...fields }))

const outcome = (judge) => {
  try { return JSON.stringify(judge()) } catch { return 'refused' }
}

const selected = process.argv[2]
if (selected === undefined) throw new Error('usage: node scripts/preflight-contract.mjs <dsh package.json>')
const appBootDir = join(dirname(realpathSync(selected)), '..', 'dsh-app-boot')
const appBoot = JSON.parse(readFileSync(join(appBootDir, 'package.json'), 'utf8'))
const entry = appBoot.exports?.['.']?.default ?? appBoot.exports?.['.'] ?? appBoot.main
const { evaluatePluginCompatibility } = await import(pathToFileURL(join(appBootDir, entry)).href)
if (typeof evaluatePluginCompatibility !== 'function') throw new Error(`dsh-app-boot ${appBoot.version} exports no evaluatePluginCompatibility`)

const differences = []
for (const runtime of RUNTIMES) {
  for (const manifest of manifests) {
    const host = outcome(() => evaluatePluginCompatibility(manifest, {}, runtime)?.requirements ?? {})
    const port = outcome(() => unmetRequirements(manifest, runtime))
    if (host !== port) differences.push({ runtime, manifest, host, port })
  }
}

if (differences.length > 0) {
  console.error(JSON.stringify(differences.slice(0, 20), null, 2))
  throw new Error(`${differences.length} judgments differ from dsh-app-boot ${appBoot.version}`)
}
console.log(`${RUNTIMES.length * manifests.length} judgments match dsh-app-boot ${appBoot.version}`)
