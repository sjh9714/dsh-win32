/**
 * Run the CLI with `process.platform` forced to win32, so the Windows-only
 * checks can be exercised from macOS and Linux.
 *
 * The win32 branch of `doctor` is the part that carries real logic, and
 * waiting for a Windows runner to find a mistake in it is a slow loop. It
 * already cost one release candidate, an inverted wrapper check that reported
 * a correct Git Bash as the 47KB wrapper.
 *
 * Env. CLI_ARGS (default "doctor --json"), plus DSH_HOME and
 * DSH_WINDOWS_BASH to point the checks at fixtures.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

// Setup fixtures deliberately clear CI flags to exercise the recorded-star
// path. Never let that simulation use a real account or launch a GUI browser
// (rundll32 can keep a headless Windows test alive). The consent unit tests
// cover the authenticated branch separately with injected probe/execute fakes.
const execute = childProcess.execFileSync
childProcess.execFileSync = (file, args, options) => {
  if (file === 'gh.exe') throw new Error('win32-sim has no authenticated GitHub account')
  if (file === 'rundll32.exe') {
    console.log('WIN32_SIM_BROWSER: no browser process was started')
    return ''
  }
  return execute(file, args, options)
}
syncBuiltinESMExports()

Object.defineProperty(process, 'platform', { value: 'win32' })

const testRoot = process.env.DSH_WINDOWS_TEST_ROOT
if (testRoot !== undefined) {
  process.env.ProgramFiles = testRoot
  process.env['ProgramFiles(x86)'] = testRoot
  process.env.LOCALAPPDATA = testRoot
}

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.mjs')
// The CLI dispatches only when argv[1] resolves to its own path.
process.argv = [process.argv[0], cli, ...(process.env.CLI_ARGS ?? 'doctor --json').split(' ')]
await import(pathToFileURL(cli).href)
