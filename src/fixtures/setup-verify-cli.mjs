// Subprocess-only CLI fixture. Never shipped or used by the real CLI.
import childProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const record = entry => appendFileSync(process.env.DSH_TEST_CALLS, `${JSON.stringify(entry)}\n`)
const verifyUrl = new URL('../../lib/verify.js', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    if (url !== verifyUrl) return nextLoad(url, context)
    return {
      format: 'module', shortCircuit: true,
      source: `
        import { appendFileSync } from 'node:fs';
        export { supportsDshNode } from ${JSON.stringify(`${verifyUrl}?real`)};
        export async function verifyInstalledStack(options) {
          appendFileSync(process.env.DSH_TEST_CALLS, JSON.stringify({ type: 'verify', options }) + '\\n');
          return JSON.parse(process.env.DSH_TEST_REPORT);
        }
      `,
    }
  },
})

// No host commands, network clients, desktop shortcuts, or account actions.
childProcess.execFileSync = (file, args) => {
  record({ type: 'exec', file, args })
  if (file === 'powershell.exe') return Buffer.from('')
  if (file === 'where.exe' && args[0] === 'pwsh') return join(process.env.DSH_HOME, 'pwsh.exe')
  throw new Error('subprocess blocked by CLI fixture')
}
syncBuiltinESMExports()
Object.defineProperty(process, 'platform', { value: process.env.DSH_TEST_PLATFORM ?? 'win32' })
process.env.ProgramFiles = process.env.DSH_HOME
process.env['ProgramFiles(x86)'] = process.env.DSH_HOME
process.env.LOCALAPPDATA = process.env.DSH_HOME
process.env.CI = 'true'
const cli = new URL('../../bin/cli.mjs', import.meta.url)
process.argv = [process.execPath, fileURLToPath(cli), ...JSON.parse(process.env.DSH_TEST_ARGS)]
await import(cli.href)
