/**
 * The CLI runs when npm invokes it the way npm actually invokes it.
 *
 * This exists because `npx dsh-win32 doctor` printed nothing and exited 0 on
 * macOS and Linux for thirteen releases. On POSIX, npm installs a bin as a
 * SYMLINK in `node_modules/.bin`, so `process.argv[1]` is the symlink while
 * `import.meta.url` is the real file. The entry guard compared them with
 * `resolve()`, which normalizes a path but does not follow symlinks, so the
 * comparison was false and `main()` never ran.
 *
 * Every other test in this suite invokes `node bin/cli.mjs` directly, which is
 * precisely the path that always worked. Testing the real path is what let a
 * silent no-op ship. Windows escaped it because npm writes a `.cmd` shim there
 * that names the real file, which is also why a Windows-facing tool went that
 * long without a report.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'bin', 'cli.mjs')

/**
 * Run `doctor` and return stdout, ignoring the exit code on purpose. `doctor`
 * exits non-zero when a check warns, and a runner without pnpm warns, so
 * asserting through a throwing spawn would fail for a reason that has nothing
 * to do with whether the entry point dispatched.
 */
function runDoctor(entry: string): string {
  const run = spawnSync(process.execPath, [entry, 'doctor'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-win32-home-')) },
  })
  return run.stdout ?? ''
}

describe('the CLI entry point', () => {
  it('runs when invoked through a symlink, which is how npm installs a bin', () => {
    let link: string
    try {
      link = join(mkdtempSync(join(tmpdir(), 'dsh-win32-bin-')), 'dsh-win32')
      symlinkSync(CLI, link)
    } catch (error) {
      // Windows without developer mode cannot create symlinks, and npm does
      // not use them there either, so there is nothing to assert.
      if (process.platform === 'win32') return
      throw error
    }

    const output = runDoctor(link)

    // The assertion is only that it ran at all. The bug produced zero bytes
    // and exit 0, which every "did it crash" style check reads as success.
    expect(output.length).toBeGreaterThan(0)
    expect(output).toContain('dsh-win32 doctor')
  })

  it('still runs when invoked by its real path', () => {
    expect(runDoctor(CLI)).toContain('dsh-win32 doctor')
  })
})
