import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  isCISetupEnvironment,
  runSetupStarConfirmation,
} from '../bin/setup-consent.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.mjs')

function capturedOutput(isTTY = true) {
  const output = Object.assign(new PassThrough(), { isTTY })
  let rendered = ''
  output.on('data', chunk => { rendered += chunk.toString() })
  return { output, rendered: () => rendered }
}

describe('deferred Star confirmation command', () => {
  it.each(['CI', 'GITHUB_ACTIONS', 'GITLAB_CI'])('recognizes %s as CI', (name) => {
    expect(isCISetupEnvironment({ [name]: '1' })).toBe(true)
  })

  it.each(['', ' ', '0', 'false', ' FALSE ', 'no', 'off'])('does not treat %j as an active environment flag', (value) => {
    expect(isCISetupEnvironment({ CI: value })).toBe(false)
  })

  it('applies --yes from an agent without requiring a TTY', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const { output, rendered } = capturedOutput(false)
    const execute = vi.fn()

    const status = runSetupStarConfirmation(['--yes'], {
      env: { CODEX_CI: '1' }, home, win: false, output, probe: () => '', execute,
    })

    expect(status).toBe(0)
    expect(rendered()).toContain('STAR_CONFIRMATION_APPLIED')
    expect(execute).toHaveBeenCalledWith('gh', ['api', '--hostname', 'github.com', '--method', 'PUT', 'user/starred/sjh9714/dsh-win32'], expect.any(Object))
    expect(readFileSync(join(home, '.dsh-win32-star-prompted'), 'utf8')).toMatch(/ yes\n$/)
  })

  it('records --no from an agent without probing or changing GitHub', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const { output, rendered } = capturedOutput(false)
    const probe = vi.fn()
    const execute = vi.fn()

    const status = runSetupStarConfirmation(['--no'], {
      env: { CODEX_THREAD_ID: 'thread' }, home, output, probe, execute,
    })

    expect(status).toBe(0)
    expect(rendered()).toContain('STAR_CONFIRMATION_RECORDED: No')
    expect(probe).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(readFileSync(join(home, '.dsh-win32-star-prompted'), 'utf8')).toMatch(/ no\n$/)
  })

  it('does not treat a missing agent answer as Yes', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const { output } = capturedOutput(false)
    const { output: errorOutput, rendered: error } = capturedOutput(false)
    const probe = vi.fn()
    const execute = vi.fn()

    const status = runSetupStarConfirmation([], {
      env: { CODEX_CI: '1' }, home, output, errorOutput, probe, execute,
    })

    expect(status).toBe(1)
    expect(error()).toContain('exactly one of --yes or --no')
    expect(existsSync(join(home, '.dsh-win32-star-prompted'))).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports a CI skip without writing a marker or changing GitHub', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const { output, rendered } = capturedOutput(false)
    const probe = vi.fn()
    const execute = vi.fn()

    const status = runSetupStarConfirmation(['--yes'], { env: { CI: '1' }, home, output, probe, execute })

    expect(status).toBe(0)
    expect(rendered()).toContain('STAR_CONFIRMATION_SKIPPED: CI environment')
    expect(existsSync(join(home, '.dsh-win32-star-prompted'))).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports an already recorded answer and takes no action', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    writeFileSync(join(home, '.dsh-win32-star-prompted'), 'previous answer\n')
    const { output, rendered } = capturedOutput(false)
    const probe = vi.fn()
    const execute = vi.fn()

    const status = runSetupStarConfirmation(['--yes'], { env: { CODEX_CI: '1' }, home, output, probe, execute })

    expect(status).toBe(0)
    expect(rendered()).toContain('already recorded; no action')
    expect(probe).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports marker write failure as nonzero and takes no action', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const home = join(parent, 'not-a-directory')
    writeFileSync(home, 'fixture')
    const { output, rendered } = capturedOutput(false)
    const probe = vi.fn()
    const execute = vi.fn()

    const status = runSetupStarConfirmation(['--yes'], { env: { CODEX_CI: '1' }, home, output, probe, execute })

    expect(status).toBe(1)
    expect(rendered()).toContain('STAR_CONFIRMATION_FAILED')
    expect(probe).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('shows and opens the repository after --yes when gh is not authenticated', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const { output, rendered } = capturedOutput(false)
    const execute = vi.fn()

    const status = runSetupStarConfirmation(['--yes'], {
      env: { CODEX_CI: '1' }, home, win: true, output, probe: () => undefined, execute,
    })

    expect(status).toBe(1)
    expect(rendered()).toContain('no authenticated GitHub CLI account was found')
    expect(rendered()).toContain('Repository: https://github.com/sjh9714/dsh-win32')
    expect(execute).toHaveBeenCalledWith('rundll32.exe', ['url.dll,FileProtocolHandler', 'https://github.com/sjh9714/dsh-win32'], expect.any(Object))
  })

  it('reports gh API failure as nonzero even when the repository opens', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const { output, rendered } = capturedOutput(false)
    const execute = vi.fn((file: string) => {
      if (file === 'gh.exe') throw new Error('rejected')
    })

    const status = runSetupStarConfirmation(['--yes'], {
      env: { CODEX_CI: '1' }, home, win: true, output, probe: () => '', execute,
    })

    expect(status).toBe(1)
    expect(rendered()).toContain('GitHub did not accept the Star request')
    expect(execute).toHaveBeenNthCalledWith(1, 'gh.exe', ['api', '--hostname', 'github.com', '--method', 'PUT', 'user/starred/sjh9714/dsh-win32'], expect.any(Object))
    expect(execute).toHaveBeenNthCalledWith(2, 'rundll32.exe', ['url.dll,FileProtocolHandler', 'https://github.com/sjh9714/dsh-win32'], expect.any(Object))
  })

  it('dispatches the explicit --no command through the real CLI entry point', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const env = { ...process.env, DSH_HOME: home, CODEX_CI: '1' }
    for (const name of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TEAMCITY_VERSION', 'TF_BUILD']) {
      delete env[name]
    }

    const run = spawnSync(process.execPath, [CLI, 'star', '--no'], { encoding: 'utf8', env })

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('STAR_CONFIRMATION_RECORDED: No')
    expect(readFileSync(join(home, '.dsh-win32-star-prompted'), 'utf8')).toMatch(/ no\n$/)
  })
})
