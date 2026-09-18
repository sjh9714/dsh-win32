/** Static, read-only checks for the two legacy rosters; never load Cordis or evaluate !!js. */
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMap, isScalar, isSeq, parseAllDocuments, type Scalar, type YAMLMap } from 'yaml'
import { PRESET_IDS } from './preset-install.ts'

const MAX_ROSTER_BYTES = 256 * 1024
const RECOVERY = 'https://github.com/sjh9714/dsh-win32/blob/master/docs/windows-details.md#persona-config-recovery'

export interface PersonaDiagnostic {
  status: 'pass' | 'warn' | 'skip'
  detail: string
  fix?: string
}

function literalString(value: unknown): value is Scalar<string> {
  return isScalar(value) && typeof value.value === 'string'
    && (value.tag === undefined || value.tag === 'tag:yaml.org,2002:str')
}

function literalMap(value: unknown): value is YAMLMap {
  return isMap(value) && (value.tag === undefined || value.tag === 'tag:yaml.org,2002:map')
    && value.items.every(({ key }) => literalString(key) && key.value !== '<<')
}

/** Return only fixed diagnostic text: YAML values and parser excerpts must not leave the process. */
function personaProblem(source: string): string | undefined {
  const docs = parseAllDocuments(source, { prettyErrors: false, logLevel: 'silent', uniqueKeys: true })
  if (docs.length !== 1) return 'expected one YAML document; inspect the roster locally'
  const doc = docs[0]!
  if (doc.errors.length > 0) return 'invalid or ambiguous YAML; inspect the roster locally'
  const rows = doc.contents
  if (!isSeq(rows) || (rows.tag !== undefined && rows.tag !== 'tag:yaml.org,2002:seq')) {
    return 'expected a literal plugin list; cannot verify persona'
  }
  const personas: YAMLMap[] = []
  for (const row of rows.items) {
    const name = isMap(row) ? row.get('name', true) : undefined
    if (!literalMap(row) || !literalString(name)) {
      return 'dynamic, aliased or ambiguous plugin row; cannot verify persona'
    }
    if (name.value === '@deepseek-ai/dsh-persona') personas.push(row)
  }
  if (personas.length !== 1) return 'expected exactly one top-level persona row; inspect custom composition locally'
  const config = personas[0]!.get('config', true)
  if (!literalMap(config)) return 'dynamic, aliased or missing persona config; cannot verify its keys'
  const text = config.get('text', true)
  const prefix = config.get('prefix', true)
  if (text === undefined || prefix === undefined) {
    return `missing persona ${[text === undefined ? 'text' : '', prefix === undefined ? 'prefix' : ''].filter(Boolean).join(' and ')} key`
  }
  if (!literalString(text) || !literalString(prefix)) return 'persona text/prefix must be literal strings for this static check'
  if (text.value !== prefix.value) return 'persona text and prefix differ; review the intended value before editing'
  return undefined
}

export function inspectLegacyPersonas(home: string): PersonaDiagnostic {
  const findings: string[] = []
  let inspected = 0
  for (const name of PRESET_IDS) {
    const directory = join(home, '.agent-presets', name)
    let stat
    try { stat = lstatSync(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      findings.push(`${name}: cannot read preset directory`)
      continue
    }
    inspected += 1
    try {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        findings.push(`${name}: linked or non-directory preset; not inspected`)
        continue
      }
      const path = join(directory, 'agent.cordis.yml')
      const file = lstatSync(path)
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_ROSTER_BYTES) {
        findings.push(`${name}: linked, non-file or oversized roster; not inspected`)
        continue
      }
      const source = readFileSync(path, 'utf8')
      const problem = Buffer.byteLength(source) > MAX_ROSTER_BYTES
        ? 'oversized roster; not inspected' : personaProblem(source)
      if (problem !== undefined) findings.push(`${name}: ${problem}`)
    } catch {
      // Never echo an exception: parser errors may contain private prompt text.
      findings.push(`${name}: roster could not be read or parsed; inspect it locally`)
    }
  }
  if (findings.length > 0) return {
    status: 'warn', detail: findings.join('; '),
    fix: `Back up the affected roster and review only its persona keys in place; no files were changed. See ${RECOVERY}`,
  }
  if (inspected === 0) return { status: 'skip', detail: 'no dsh-win32 legacy preset is installed' }
  return {
    status: 'pass',
    detail: 'installed legacy persona text/prefix values match; static key check only, not host/session compatibility',
  }
}
