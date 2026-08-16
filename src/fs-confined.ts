/**
 * dsh-win32/fs-confined: the legacy-encoding reads of `dsh-win32/fs`, over a
 * backend that actually fences writes.
 *
 * The stock `minimal` preset mounts the bare `fs-local` and says so in its own
 * comment ("The bare local filesystem shadows the host's sandboxed provider
 * only for this preset"). The consequence is not obvious: `fs-local` reports
 * no `sandboxMode`, and `tool-str-replace-editor` reads exactly that to decide
 * whether to build a MutationPolicy at all —
 *
 *   this.policy = ctx.fs.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')
 *
 * so with the bare backend there is no policy and no write fence. The editor
 * can rewrite any absolute path on the box while the session badge still says
 * Read Only. Reads passing through is by design (fs-sandbox passes reads in
 * every mode too); unfenced WRITES are not. Reported upstream in
 * deepseek-harness#2066.
 *
 * This backend is the sandboxed preset's answer. It keeps the GBK/UTF-16 read
 * decoding and inherits the real fence from `fs-sandbox`, so `read-only`
 * denies every write and `workspace-write` denies writes outside the
 * workspace, `/tmp`, and the system temp dir.
 *
 * It requires `ctx.sandboxPolicy`. Presets without a sandbox policy must stay
 * on `dsh-win32/fs`.
 */

import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { legacyText } from './fs.ts'

interface FsTargetLike {
  displayPath: string
  targetKey: string
}

export const name = 'fs-win32-confined'

export default class ConfinedWin32FileSystem extends SandboxedFileSystem {
  override async readText(target: FsTargetLike, signal?: AbortSignal): Promise<string> {
    const legacy = await legacyText((t, s, c) => this.readBytes(t, s, c), target, signal).catch(() => undefined)
    if (legacy !== undefined) return legacy
    return super.readText(target as never, signal)
  }

  override async streamText(target: FsTargetLike, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const legacy = await legacyText((t, s, c) => this.readBytes(t, s, c), target, signal).catch(() => undefined)
    if (legacy !== undefined) {
      return (async function* () { yield legacy })()
    }
    return super.streamText(target as never, signal)
  }
}
