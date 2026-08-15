/**
 * Foreground-shell legacy-encoding proof: a child process writes raw GBK
 * bytes; the runtime's collect reader must serve correctly decoded text.
 * On win32 the decoding spawn override is active; elsewhere the script
 * verifies UTF-8 passthrough only (the override is win32-gated).
 *
 * Run after `npm run build`: node scripts/encoding-smoke.mjs
 */

import process from 'node:process'
import { Context } from '@deepseek-ai/cordis'
import WindowsSubprocessRuntime from '../lib/index.js'

const GBK_BYTES = [0xb1, 0xe0, 0xd2, 0xeb, 0xcd, 0xea, 0xb3, 0xc9] // 编译完成
const EXPECTED = process.platform === 'win32' ? '编译完成' : 'plain-utf8-ok'

const ctx = new Context()
await ctx.plugin(WindowsSubprocessRuntime)

const program = process.platform === 'win32'
  ? `process.stdout.write(Buffer.from([${GBK_BYTES.join(',')}]))`
  : `process.stdout.write('plain-utf8-ok')`

const handle = ctx.subprocess.spawn({
  argv: [process.execPath, '-e', program],
  cwd: process.cwd(),
  stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
  graceMs: 3000,
})
await handle.done
const read = handle.collected.stdout.readFrom(0)

await ctx.fiber.dispose().catch(() => {})
if (!read.text.includes(EXPECTED)) {
  console.error(`FAIL: expected ${JSON.stringify(EXPECTED)}, got ${JSON.stringify(read.text.slice(0, 120))}`)
  process.exit(1)
}
console.log(`ok: collect reader served ${JSON.stringify(EXPECTED)} on ${process.platform}`)
process.exit(0)
