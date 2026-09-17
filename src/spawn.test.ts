import process from 'node:process'
import { PassThrough } from 'node:stream'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WindowsSubprocessRuntime from './index.ts'

type Spec = Parameters<LocalSubprocessRuntime['spawn']>[0]
type Handle = ReturnType<LocalSubprocessRuntime['spawn']>
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const streams: PassThrough[] = []

function fixture(overrides: Partial<Spec> = {}) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  streams.push(stdout, stderr)
  const parentDone = Promise.withResolvers<Awaited<Handle['done']>>()
  const inner: Handle = {
    pid: 123,
    stdin: undefined,
    stdout,
    stderr,
    collected: {},
    done: parentDone.promise,
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  }
  const spawn = vi.spyOn(LocalSubprocessRuntime.prototype, 'spawn').mockReturnValue(inner)
  // Exercise the actual override without installing presets or a host service.
  const runtime = Object.create(WindowsSubprocessRuntime.prototype) as WindowsSubprocessRuntime
  const spec: Spec = {
    argv: ['fixture'], cwd: process.cwd(), graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    ...overrides,
  }
  const handle = runtime.spawn(spec)
  return { stdout, stderr, parentDone, inner, spawn, spec, handle }
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', platform)
  for (const stream of streams.splice(0)) stream.destroy()
})

describe('Windows collect-mode spawn', () => {
  it('bounds an inherited pipe only after the parent outcome arrives (#78)', async () => {
    const { handle, stdout, stderr, parentDone } = fixture()
    let result: Awaited<Handle['done']> | undefined
    void handle.done.then(outcome => { result = outcome })
    stdout.write('before exit')
    await vi.advanceTimersByTimeAsync(1000)
    expect(result).toBeUndefined()
    expect(stdout.destroyed).toBe(false)

    const outcome = { exitCode: 0, signal: null }
    parentDone.resolve(outcome)
    await vi.advanceTimersByTimeAsync(99)
    expect(result).toBeUndefined()
    stdout.write(' and final bytes')
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBe(outcome)
    expect(stdout.destroyed).toBe(true)
    expect(stderr.destroyed).toBe(true)
    expect(handle.collected.stdout?.readFrom(0).text).toBe('before exit and final bytes')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drains both streams promptly and clears the unused timeout', async () => {
    const { handle, stdout, stderr, parentDone } = fixture()
    let settled = false
    void handle.done.then(() => { settled = true })
    parentDone.resolve({ exitCode: 7, signal: null })
    await vi.advanceTimersByTimeAsync(10)
    stdout.end('stdout tail')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    stderr.end('stderr tail')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    expect(await handle.done).toEqual({ exitCode: 7, signal: null })
    expect(handle.collected.stdout?.readFrom(0).text).toBe('stdout tail')
    expect(handle.collected.stderr?.readFrom(0).text).toBe('stderr tail')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['stdout', 'stderr'] as const)('does not consume or destroy the caller-owned %s pipe', async (raw) => {
    const collected = raw === 'stdout' ? 'stderr' : 'stdout'
    const f = fixture({ stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', [collected]: { maxBytes: 1024 } } })
    f.parentDone.resolve({ exitCode: null, signal: 'SIGTERM' })
    await vi.advanceTimersByTimeAsync(100)
    expect(f.handle[raw]).toBe(f[raw])
    expect(f[raw].destroyed).toBe(false)
    expect(f[raw].listenerCount('data')).toBe(0)
    expect(f.handle[collected]).toBeUndefined()
    expect(f[collected].destroyed).toBe(true)
    expect(await f.handle.done).toEqual({ exitCode: null, signal: 'SIGTERM' })
  })

  it('propagates spawn failure and closes only owned streams', async () => {
    const f = fixture({ stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: 'pipe' } })
    const failure = new Error('spawn failed')
    const assertion = expect(f.handle.done).rejects.toBe(failure)
    f.parentDone.reject(failure)
    await assertion
    expect(f.stdout.destroyed).toBe(true)
    expect(f.stderr.destroyed).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves non-Windows and raw-only spawns unchanged', () => {
    const raw = fixture({ stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
    expect(raw.handle).toBe(raw.inner)
    expect(raw.spawn).toHaveBeenLastCalledWith(raw.spec)
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    const other = fixture()
    expect(other.handle).toBe(other.inner)
    expect(other.spawn).toHaveBeenLastCalledWith(other.spec)
  })

  it('forwards the exact grace, abort signal, and lifecycle methods', async () => {
    const signal = new AbortController().signal
    const f = fixture({ graceMs: 250, signal })
    expect(f.spawn).toHaveBeenCalledWith({
      ...f.spec, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    f.handle.terminate()
    expect(f.inner.terminate).toHaveBeenCalledOnce()
    expect(await f.handle.waitForExit(signal)).toBe(true)
    expect(f.inner.waitForExit).toHaveBeenCalledWith(signal)
    f.parentDone.resolve({ exitCode: 0, signal: null })
    let settled = false
    void f.handle.done.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(249)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })
})
