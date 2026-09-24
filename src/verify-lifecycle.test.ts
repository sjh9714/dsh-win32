import { describe, expect, it, vi } from 'vitest'
import {
  composeOfficialHarness,
  disposeOfficialHarness,
  type ResolvedInstalledTree,
} from './verify.ts'

function fixture(register: () => unknown = () => () => {}) {
  const disposeContext = vi.fn(async () => {})
  const registrationStarted = Promise.withResolvers<void>()
  const registerAgent = vi.fn(() => {
    registrationStarted.resolve()
    return register()
  })
  class Context {
    fiber = { dispose: disposeContext }
    agents = { register: registerAgent }
    plugin = () => ({ ctx: this })
    get = () => ({})
  }
  const load = async (name: string) => {
    if (name === '@deepseek-ai/cordis') return { Context }
    if (name === '@deepseek-ai/dsh-session') {
      return { SessionId: (id: string) => id, Session: { create: (id: string) => ({ id }) } }
    }
    return { default: {}, TerminalSessionService: {} }
  }
  return {
    disposeContext,
    registerAgent,
    registrationStarted: registrationStarted.promise,
    compose: () => composeOfficialHarness({} as ResolvedInstalledTree, load),
  }
}

describe('official verifier harness lifecycle', () => {
  it('retains compatibility with synchronous agent registration and disposal', async () => {
    const disposeAgent = vi.fn()
    const installed = fixture(() => disposeAgent)
    vi.stubEnv('DSH_WIN32_VERIFY_WORKSPACE', 'fixture-workspace')
    try {
      const harness = await installed.compose()
      expect(installed.registerAgent).toHaveBeenCalledOnce()
      expect(harness.disposeAgent).toBe(disposeAgent)
      await disposeOfficialHarness(harness)
      expect(disposeAgent).toHaveBeenCalledOnce()
      expect(installed.disposeContext).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('does not expose the harness for a first tool call until async registration finishes', async () => {
    const registration = Promise.withResolvers<() => void>()
    const installed = fixture(() => registration.promise)
    const firstToolCall = vi.fn()
    vi.stubEnv('DSH_WIN32_VERIFY_WORKSPACE', 'fixture-workspace')
    const pending = installed.compose().then(harness => {
      firstToolCall()
      return harness
    })
    try {
      await installed.registrationStarted
      await Promise.resolve()
      await Promise.resolve()
      expect(firstToolCall).not.toHaveBeenCalled()
      registration.resolve(() => {})
      const harness = await pending
      expect(firstToolCall).toHaveBeenCalledOnce()
      await disposeOfficialHarness(harness)
    } finally {
      registration.resolve(() => {})
      await pending
      vi.unstubAllEnvs()
    }
  })

  it('fails composition and cleans the context when async registration rejects', async () => {
    const registration = Promise.withResolvers<() => void>()
    const installed = fixture(() => registration.promise)
    // The old implementation leaves the registration promise unobserved.
    // Observe that promise independently so this regression reports its
    // assertion failure instead of leaking an unhandled rejection.
    void registration.promise.catch(() => {})
    vi.stubEnv('DSH_WIN32_VERIFY_WORKSPACE', 'fixture-workspace')
    try {
      const pending = installed.compose().then(() => undefined)
      const rejected = expect(pending).rejects.toThrow('official_components')
      await installed.registrationStarted
      registration.reject(new Error('fixture registration failed'))
      await rejected
      expect(installed.disposeContext).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('waits for async agent disposal before starting context disposal', async () => {
    const release = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const events: string[] = []
    const harness = {
      agent: {},
      disposeAgent: async () => {
        events.push('agent:start')
        started.resolve()
        await release.promise
        events.push('agent:done')
      },
      ctx: { fiber: { dispose: async () => { events.push('context:dispose') } } },
    }
    const pending = disposeOfficialHarness(harness)
    try {
      await started.promise
      await Promise.resolve()
      expect([...events]).toEqual(['agent:start'])
    } finally {
      release.resolve()
      await pending
    }
    expect(events).toEqual(['agent:start', 'agent:done', 'context:dispose'])
  })

  it('still attempts context disposal after synchronous agent disposal failure', async () => {
    const disposeContext = vi.fn(async () => {})
    await expect(disposeOfficialHarness({
      agent: {},
      disposeAgent: () => { throw new Error('fixture detach failed') },
      ctx: { fiber: { dispose: disposeContext } },
    })).rejects.toThrow('fixture detach failed')
    expect(disposeContext).toHaveBeenCalledOnce()
  })

  it('still attempts context disposal and reports async agent disposal failure', async () => {
    const rejection = Promise.reject(new Error('fixture async detach failed'))
    void rejection.catch(() => {})
    const disposeContext = vi.fn(async () => {})
    await expect(disposeOfficialHarness({
      agent: {},
      disposeAgent: () => rejection,
      ctx: { fiber: { dispose: disposeContext } },
    })).rejects.toThrow('fixture async detach failed')
    expect(disposeContext).toHaveBeenCalledOnce()
  })

  it('does not hide context disposal failure', async () => {
    await expect(disposeOfficialHarness({
      agent: {},
      disposeAgent: () => {},
      ctx: { fiber: { dispose: async () => { throw new Error('fixture context failed') } } },
    })).rejects.toThrow('fixture context failed')
  })

  it('bounds a stalled agent disposer and still attempts context teardown', async () => {
    vi.useFakeTimers()
    const disposeContext = vi.fn(async () => {})
    const stalled = Promise.withResolvers<void>()
    try {
      const pending = disposeOfficialHarness({
        agent: {},
        disposeAgent: () => stalled.promise,
        ctx: { fiber: { dispose: disposeContext } },
      })
      const rejected = expect(pending).rejects.toThrow('bounded operation timed out')
      await vi.advanceTimersByTimeAsync(20_000)
      await rejected
      expect(disposeContext).toHaveBeenCalledOnce()
    } finally {
      stalled.resolve()
      vi.useRealTimers()
    }
  })
})
