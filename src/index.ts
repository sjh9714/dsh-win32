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
import { wrapTerminalHandle } from './terminal-wrap.ts'

export { WindowsProcessInspector } from './inspector.ts'
export type { ProcessIdentity, WindowsInspectorInternals } from './inspector.ts'
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
}
