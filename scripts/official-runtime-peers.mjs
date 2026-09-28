#!/usr/bin/env node

// CI-only: --legacy-peer-deps omits runtime peers from the hoisted npm tree.
// Read that installed tree without importing package code or querying dist-tags.
// The workflow installs these declared specs and repeats until the graph closes.
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const officialPackage = /^@deepseek-ai\/dsh(?:-[a-z0-9-]+)?$/
const releaseSpec = /^[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/

export function missingOfficialRuntimePeers(dshManifest) {
  const selected = realpathSync(dshManifest)
  const boundary = realpathSync(resolve(dirname(selected), '..', '..'))
  if (selected !== join(boundary, '@deepseek-ai', 'dsh', 'package.json')) {
    throw new Error('expected the installed @deepseek-ai/dsh/package.json in a hoisted npm tree')
  }
  const seen = new Set()
  const missing = new Map()
  const queue = [{ path: selected, name: '@deepseek-ai/dsh' }]

  for (const owner of queue) {
    if (seen.has(owner.path)) continue
    seen.add(owner.path)
    const manifest = JSON.parse(readFileSync(owner.path, 'utf8'))
    if (manifest.name !== owner.name || typeof manifest.version !== 'string') {
      throw new Error(`invalid installed package identity for ${owner.name}`)
    }
    const require = createRequire(owner.path)
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (!officialPackage.test(name)) continue
        if (field === 'peerDependencies' && manifest.peerDependenciesMeta?.[name]?.optional === true) continue
        if (field === 'dependencies' && manifest.optionalDependencies?.[name] !== undefined) continue
        let target
        try {
          target = require.resolve(`${name}/package.json`)
        } catch (error) {
          if (error.code !== 'MODULE_NOT_FOUND') throw error
          if (field === 'dependencies') throw new Error(`${owner.name} is missing its installed dependency ${name}`)
          // Keep the owner's exact/caret/tilde release declaration. Never
          // substitute the DSH root version, a dist-tag, URL, or local path.
          if (typeof spec !== 'string' || !releaseSpec.test(spec)) {
            throw new Error(`unsupported runtime peer declaration ${name} from ${owner.name}`)
          }
          if (missing.has(name) && missing.get(name) !== spec) {
            throw new Error(`conflicting runtime peer declarations for ${name}`)
          }
          missing.set(name, spec)
          continue
        }
        const canonical = realpathSync(target)
        const path = relative(boundary, canonical)
        if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
          throw new Error(`${name} resolved outside the selected DSH installation`)
        }
        queue.push({ path: canonical, name })
      }
    }
  }
  return [...missing].sort(([left], [right]) => left.localeCompare(right)).map(([name, spec]) => `${name}@${spec}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: official-runtime-peers.mjs <installed DSH package.json>')
    const peers = missingOfficialRuntimePeers(process.argv[2])
    if (peers.length > 0) process.stdout.write(`${peers.join('\n')}\n`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
