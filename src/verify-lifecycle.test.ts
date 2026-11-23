import { describe, expect, it, vi } from 'vitest'
import {
  composeOfficialHarness,
  disposeOfficialHarness,
  errorCode,
  runPwshTool,
  type ResolvedInstalledTree,
} from './verify.ts'

function fixture(register: () => unknown = () => () => {}, workingDirectory = false, executor: { selects: boolean, declared: boolean } = { selects: false, declared: false }) {
  const disposeContext = vi.fn(async () => {})
  const registrationStarted = Promise.withResolvers<void>()
  const registerAgent = vi.fn(() => {
    registrationStarted.resolve()
    return register()
  })
  const mounted = new Map<string, unknown>()
  const fsPlugin = { name: 'fixture-fs-sandbox' }
  const cwdPlugin = { name: 'fixture-working-directory' }
  const executorModule = { name: 'native-tool-executor', apply: () => {} }
  class Context {
    fiber = { dispose: disposeContext }
    agents = { register: registerAgent }
    plugin = (plugin: unknown, config?: unknown) => {
      if (plugin === fsPlugin) mounted.set('fs', config)
      if (plugin === executorModule) mounted.set('executor', true)
      if (plugin === cwdPlugin) {
        if (!mounted.has('fs')) throw new Error('filesystem must precede working directory')
        mounted.set('workingDirectory', config)
      }
      return { ctx: this }
    }
    get = (name: string) => name === 'workingDirectory' ? mounted.get(name) : name === 'tools' && executor.selects ? { setExecutor: () => {} } : {}
  }
  const load = async (name: string) => {
    if (name === '@deepseek-ai/cordis') return { Context }
    if (name === '@deepseek-ai/dsh-session') {
      return { SessionId: (id: string) => id, Session: { create: (id: string) => ({ id }) } }
    }
    if (name === '@deepseek-ai/dsh-fs-sandbox') return { default: fsPlugin }
    if (name === '@deepseek-ai/dsh-working-directory') return { default: cwdPlugin }
    if (name === '@deepseek-ai/dsh-tool-executor-native') return executorModule
    return { default: {}, TerminalSessionService: {} }
  }
  return {
    disposeContext,
    registerAgent,
    registrationStarted: registrationStarted.promise,
    mounted,
    compose: () => composeOfficialHarness({
      components: {
        ...workingDirectory ? { '@deepseek-ai/dsh-working-directory': {} } : {},
        ...executor.declared ? { '@deepseek-ai/dsh-tool-executor-native': {} } : {},
      },
    } as ResolvedInstalledTree, load),
  }
}

describe('official verifier harness lifecycle', () => {
  it('mounts the declared native executor when the tools service selects executors', async () => {
    const installed = fixture(undefined, false, { selects: true, declared: true })
    vi.stubEnv('DSH_WIN32_VERIFY_WORKSPACE', 'fixture-workspace')
    try {
      const harness = await installed.compose()
      expect(installed.mounted.get('executor')).toBe(true)
      await disposeOfficialHarness(harness)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([
    { selects: true, declared: false },
    { selects: false, declared: true },
  ])('fails composition when executor selection and declaration disagree (%o)', async (executor) => {
    const installed = fixture(undefined, false, executor)
    vi.stubEnv('DSH_WIN32_VERIFY_WORKSPACE', 'fixture-workspace')
    try {
      await expect(installed.compose()).rejects.toThrow('official_components')
      expect(installed.mounted.has('executor')).toBe(false)
      expect(installed.disposeContext).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('mounts the declared working-directory service over the sandbox filesystem at the isolated workspace', async () => {
    const installed = fixture(undefined, true)
    vi.stubEnv('DSH_WIN32_VERIFY_WORKSPACE', '/isolated/workspace')
    try {
      const harness = await installed.compose()
      expect(installed.mounted.get('fs')).toMatchObject({ cwd: '/isolated/workspace' })
      expect(installed.mounted.get('workingDirectory')).toMatchObject({ defaultDirectory: '/isolated/workspace' })
      await disposeOfficialHarness(harness)
    } finally {
      vi.unstubAllEnvs()
    }
  })

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

describe('pwsh tool dispatch', () => {
  it('keeps the single-call contract for tools services without executors', async () => {
    const execute = vi.fn(async () => ({ isError: false, value: 'ok' }))
    const signal = new AbortController().signal
    const result = await runPwshTool({ tools: { execute } }, 'agent', 'Get-Date', signal)
    expect(result).toEqual({ isError: false, value: 'ok' })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'pwsh', arguments: { command: 'Get-Date' }, agent: 'agent', signal }))
  })

  it('sends one raw model call through executor batches and returns its own result', async () => {
    const execute = vi.fn(async (input: any) => ({
      results: [{ callId: 'other', result: { isError: true } }, { callId: input.calls[0].id, result: { isError: false, value: 'ok' } }],
      additionalContexts: [],
      concluded: false,
    }))
    const signal = new AbortController().signal
    const result = await runPwshTool({ tools: { execute, setExecutor: () => {} } }, 'agent', 'Get-Date', signal)
    expect(result).toEqual({ isError: false, value: 'ok' })
    const input = execute.mock.calls[0]![0]
    expect(input).toMatchObject({ agent: 'agent', signal, calls: [{ type: 'tool-call', name: 'pwsh' }] })
    expect(JSON.parse(input.calls[0].arguments)).toEqual({ command: 'Get-Date' })
  })

  it('rejects a batch that omits the call', async () => {
    const tools = { setExecutor: () => {}, execute: async () => ({ results: [], additionalContexts: [], concluded: false }) }
    await expect(runPwshTool({ tools }, 'agent', 'Get-Date', new AbortController().signal)).rejects.toThrow('omitted')
  })

  it('reports only identifier-shaped upstream error codes', () => {
    expect(errorCode({ code: 'TOOL_EXECUTOR_UNAVAILABLE' })).toBe('TOOL_EXECUTOR_UNAVAILABLE')
    expect(errorCode({ code: 'C:\\Users\\me' })).toBeUndefined()
    expect(errorCode({ code: 42 })).toBeUndefined()
    expect(errorCode(undefined)).toBeUndefined()
  })
})
