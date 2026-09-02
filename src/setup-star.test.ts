import { PassThrough } from 'node:stream'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isCISetupEnvironment, offerSetupStar } from '../bin/setup-consent.mjs'

function capturedOutput() {
  const output = new PassThrough()
  let rendered = ''
  output.on('data', chunk => { rendered += chunk.toString() })
  return { output, rendered: () => rendered }
}

describe('setup Star', () => {
  it.each(['CI', 'GITHUB_ACTIONS', 'GITLAB_CI'])('recognizes %s as CI', (name) => {
    expect(isCISetupEnvironment({ [name]: '1' })).toBe(true)
  })

  it.each(['', ' ', '0', 'false', ' FALSE ', 'no', 'off'])('does not treat %j as an active CI flag', (value) => {
    expect(isCISetupEnvironment({ CI: value })).toBe(false)
  })

  it('Stars by default after setup', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const { output, rendered } = capturedOutput()
    const execute = vi.fn()

    const status = offerSetupStar({ env: {}, home, win: false, output, probe: () => '', execute })

    expect(status).toBe(0)
    expect(rendered()).toContain('STAR_CONFIRMATION_APPLIED')
    expect(execute).toHaveBeenCalledWith('gh', ['api', '--hostname', 'github.com', '--method', 'PUT', 'user/starred/sjh9714/dsh-win32'], expect.any(Object))
    expect(readFileSync(join(home, '.dsh-win32-star-prompted'), 'utf8')).toMatch(/ yes\n$/)
  })

  it('skips CI without writing a marker or changing GitHub', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const { output, rendered } = capturedOutput()
    const execute = vi.fn()

    expect(offerSetupStar({ env: { CI: '1' }, home, output, execute })).toBe(0)
    expect(rendered()).toContain('STAR_CONFIRMATION_SKIPPED')
    expect(existsSync(join(home, '.dsh-win32-star-prompted'))).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it('runs only once', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const { output, rendered } = capturedOutput()
    const execute = vi.fn()
    const options = { env: {}, home, win: false, output, probe: () => '', execute }

    expect(offerSetupStar(options)).toBe(0)
    expect(offerSetupStar(options)).toBe(0)
    expect(rendered()).toContain('already recorded; no action')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not change GitHub when the marker cannot be written', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const home = join(parent, 'not-a-directory')
    writeFileSync(home, 'fixture')
    const { output, rendered } = capturedOutput()
    const execute = vi.fn()

    expect(offerSetupStar({ env: {}, home, output, probe: () => '', execute })).toBe(1)
    expect(rendered()).toContain('STAR_CONFIRMATION_FAILED')
    expect(execute).not.toHaveBeenCalled()
  })

  it('opens the repository on Windows when gh is not authenticated', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const { output, rendered } = capturedOutput()
    const execute = vi.fn()

    expect(offerSetupStar({ env: {}, home, win: true, output, probe: () => undefined, execute })).toBe(1)
    expect(rendered()).toContain('no authenticated GitHub CLI account was found')
    expect(execute).toHaveBeenCalledWith('rundll32.exe', ['url.dll,FileProtocolHandler', 'https://github.com/sjh9714/dsh-win32'], expect.any(Object))
  })

  it('opens the repository when the GitHub API rejects the Star', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-win32-star-'))
    const { output, rendered } = capturedOutput()
    const execute = vi.fn((file: string) => {
      if (file === 'gh.exe') throw new Error('rejected')
    })

    expect(offerSetupStar({ env: {}, home, win: true, output, probe: () => '', execute })).toBe(1)
    expect(rendered()).toContain('GitHub did not accept the Star request')
    expect(execute).toHaveBeenNthCalledWith(2, 'rundll32.exe', ['url.dll,FileProtocolHandler', 'https://github.com/sjh9714/dsh-win32'], expect.any(Object))
  })
})
