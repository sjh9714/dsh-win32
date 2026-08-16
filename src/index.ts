/**
 * dsh-win32: Windows-aware local subprocess runtime for DeepSeek Harness.
 *
 * Identical to the stock @deepseek-ai/dsh-subprocess-local runtime except it
 * supplies a Windows ProcessInspector, which the stock runtime lacks. That one
 * gap is what makes every PTY spawn (dsh-terminal-bash, and with it the
 * Minimal preset's persistent bash) throw on win32. The bundle patch swaps
 * this runtime in on Windows only; on other platforms the stock row stays.
 */

import { spawnSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { WindowsProcessInspector } from './inspector.ts'
import { collectStream } from './shell-decode.ts'
import { wrapTerminalHandle } from './terminal-wrap.ts'

export { WindowsProcessInspector } from './inspector.ts'
export type { ProcessIdentity, WindowsInspectorInternals } from './inspector.ts'
export { parseConsoleProcessList, queryConsoleProcessList } from './console-list.ts'
export type { ConsoleProcessList } from './console-list.ts'
export { wrapTerminalHandle } from './terminal-wrap.ts'

export const name = 'subprocess-windows'

export default class WindowsSubprocessRuntime extends LocalSubprocessRuntime {
  constructor(ctx: Context) {
    super(ctx)
    if (process.platform === 'win32') {
      // Field is the runtime's designed injection seam; production otherwise
      // resolves an inspector lazily per PTY spawn and throws on win32.
      this.terminalInspector = new WindowsProcessInspector() as typeof this.terminalInspector
      // The stock teardown taskkill omits windowsHide, so every timeout kill
      // flashes a console window (community report #409). SpawnInternals is
      // the runtime's own injection hook for exactly this knob.
      this.internals = {
        ...this.internals,
        taskkill: pid => {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        },
      }
    }
  }

  override async spawnTerminal(spec: Parameters<LocalSubprocessRuntime['spawnTerminal']>[0]): ReturnType<LocalSubprocessRuntime['spawnTerminal']> {
    const handle = await super.spawnTerminal(spec)
    // On win32 the foreground-group signal path cannot exist; deliver
    // keyboard-equivalent signals as PTY input instead (Ctrl-C injection).
    return process.platform === 'win32' ? wrapTerminalHandle(handle) : handle
  }

  override spawn(spec: Parameters<LocalSubprocessRuntime['spawn']>[0]): ReturnType<LocalSubprocessRuntime['spawn']> {
    if (process.platform !== 'win32') return super.spawn(spec)
    // Legacy-encoding-aware collect: the stock collector hardcodes UTF-8, so
    // native tools writing OEM 936 / UTF-16 garble. Rewrite collect-mode
    // streams to raw pipes, consume the bytes ourselves, and serve the
    // reader contract from sniffed-and-decoded UTF-8 text.
    const stdoutCollect = typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout : undefined
    const stderrCollect = typeof spec.stdio.stderr === 'object' ? spec.stdio.stderr : undefined
    if (stdoutCollect === undefined && stderrCollect === undefined) return super.spawn(spec)
    const rewritten = {
      ...spec,
      stdio: {
        ...spec.stdio,
        stdout: stdoutCollect !== undefined ? 'pipe' as const : spec.stdio.stdout,
        stderr: stderrCollect !== undefined ? 'pipe' as const : spec.stdio.stderr,
      },
    }
    const handle = super.spawn(rewritten)
    const collected: { stdout?: unknown, stderr?: unknown } = {}
    const drains: Promise<void>[] = []
    if (stdoutCollect !== undefined && handle.stdout !== undefined) {
      const { reader, done } = collectStream(handle.stdout, stdoutCollect.maxBytes, stdoutCollect.spill?.maxBytes)
      collected.stdout = reader
      drains.push(done)
    }
    if (stderrCollect !== undefined && handle.stderr !== undefined) {
      const { reader, done } = collectStream(handle.stderr, stderrCollect.maxBytes, stderrCollect.spill?.maxBytes)
      collected.stderr = reader
      drains.push(done)
    }
    // The outcome must not settle before the pipes drain, or a read right
    // after `done` can miss the final chunks.
    const doneWithDrain = handle.done.then(async outcome => {
      await Promise.all(drains)
      return outcome
    })
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'collected') return collected
        if (property === 'done') return doneWithDrain
        // Streams claimed for decoding are not the caller's to consume.
        if (property === 'stdout' && stdoutCollect !== undefined) return undefined
        if (property === 'stderr' && stderrCollect !== undefined) return undefined
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as ReturnType<LocalSubprocessRuntime['spawn']>
  }
}
