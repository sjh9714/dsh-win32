import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

describe('official Windows acceptance policy', () => {
  it('discovers omitted npm peers from the installed official tree instead of guessing release names', () => {
    expect(workflow).toContain('node scripts/official-runtime-peers.mjs $dshManifest')
    expect(workflow).not.toContain("'@deepseek-ai/dsh-code-runtime'")
    expect(workflow).not.toContain('ForEach-Object { "$_@$dshVersion" }')
    expect(workflow).toContain('could not inspect installed DSH runtime peers')
    expect(workflow).toContain('official DSH runtime peer installation failed')
    expect(workflow).toContain('official DSH runtime peers did not converge')
  })

  it('compares preflight judgments with the installed host on the strict lane', () => {
    expect(workflow).toContain('node scripts/preflight-contract.mjs')
    expect(workflow).toContain('preflight judgments differ from the installed host')
  })

  it('runs the preflight CLI against the installed stack', () => {
    expect(workflow).toContain('node scripts/preflight-smoke.mjs')
    expect(workflow).toContain('preflight CLI smoke failed')
  })

  it('flags a due release rule review on scheduled and manual runs, never on pull requests', () => {
    const step = workflow.split('- name: preflight release rules cover the latest DSH')[1]?.split('\n\n')[0]
    expect(step).toContain('--require-reviewed')
    expect(step).toContain("if: (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && matrix.installer == 'pnpm-strict'")
  })

  it('keeps the pnpm graph isolated and preserves the release-age gate', () => {
    for (const setting of [
      'nodeLinker: isolated',
      'hoist: false',
      'shamefullyHoist: false',
      'strictDepBuilds: true',
      'minimumReleaseAge: 1440',
      'minimumReleaseAgeStrict: true',
    ]) expect(workflow).toContain(`'${setting}'`)
    expect(workflow).not.toMatch(/minimumReleaseAge(?:Exclude|IgnoreMissingTime)|minimumReleaseAge:\s*0\b|strictDepBuilds:\s*false/)
    expect(workflow).toContain('npm install --global pnpm@11.7.0')
  })

  it('approves only the identified runtime build scripts', () => {
    const policy = workflow.split("'allowBuilds:',")[1]?.split(") | Set-Content")[0]
    expect(policy).toBeDefined()
    const names = [...policy.matchAll(/^\s*["']\s{2}'?([^'"\n]+?)'?: true["']/gm)].map(match => match[1])
    expect(names.sort()).toEqual([
      '@deepseek-ai/dsh-subprocess-local', '@google/genai', 'koffi', 'node-pty', 'protobufjs',
    ].sort())
  })

  it('keeps both layouts and requires the live result even on scheduled runs', () => {
    expect(workflow.match(/"installer":\["npm","pnpm-strict"\]/g)).toHaveLength(2)
    const gate = workflow.slice(workflow.indexOf('  ci-gate:'))
    expect(gate.indexOf('require_success official-live-acceptance "$OFFICIAL_RESULT"'))
      .toBeLessThan(gate.indexOf('if [ "$EVENT_NAME" != schedule ]'))
    expect(gate).not.toContain('continue-on-error')
  })

  it('exercises opt-in setup verification without replacing standalone acceptance', () => {
    expect(workflow).toContain('node bin/cli.mjs verify')
    expect(workflow).toContain('node bin/cli.mjs setup --verify --profile acceptance --no-shortcut')
    expect(workflow).toContain('setup-verify-isolated-home')
    expect(workflow).toContain('setup verification unexpectedly wrote profile data')
  })
})
