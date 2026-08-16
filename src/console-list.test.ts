import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleProbeInternals } from './console-list.ts'
import { parseConsoleProcessList, queryConsoleProcessList, setConsoleProbeWarn } from './console-list.ts'

describe('parseConsoleProcessList', () => {
  it('reads the helper payload', () => {
    expect(parseConsoleProcessList('{"pids":[57944,66288,43168],"self":57944}'))
      .toEqual({ pids: [57944, 66288, 43168], self: 57944 })
  })

  it('drops entries that are not usable pids', () => {
    const parsed = parseConsoleProcessList('{"pids":[1,null,"2",1.5,1e300,3],"self":9}')
    expect(parsed).toEqual({ pids: [1, 3], self: 9 })
  })

  it('returns undefined rather than a half-parsed shape', () => {
    for (const raw of ['', 'not json', 'null', '[]', '{"pids":[1]}', '{"self":1}', '{"pids":"1,2","self":1}']) {
      expect(parseConsoleProcessList(raw), raw).toBeUndefined()
    }
  })

  it('accepts an empty list, which is a real console state', () => {
    expect(parseConsoleProcessList('{"pids":[],"self":9}')).toEqual({ pids: [], self: 9 })
  })
})

describe('the probe says when it has gone permanently quiet', () => {
  const LIST = '{"pids":[1,2],"self":1}'
  /** Wiring a sink also clears the latches, so each case starts fresh. */
  const collect = (): string[] => {
    const warnings: string[] = []
    setConsoleProbeWarn(message => warnings.push(message))
    return warnings
  }
  const probe = (over: Partial<ConsoleProbeInternals>): ConsoleProbeInternals => ({
    helper: () => 'helper.cjs',
    run: () => LIST,
    ...over,
  })
  const query = (internals: ConsoleProbeInternals, times: number): void => {
    for (let i = 0; i < times; i++) queryConsoleProcessList(1234, 5_000, internals)
  }

  afterEach(() => { setConsoleProbeWarn(undefined) })

  it('warns once when the helper cannot be prepared at all, however many probes follow', () => {
    const warnings = collect()
    query(probe({ helper: () => undefined }), 10)
    expect(warnings).toHaveLength(1)
    // Names the consequence, since the symptom is #7, #11 and #24 returning at once.
    expect(warnings[0]).toMatch(/fall back to parent links/)
  })

  it('stays quiet for an isolated failure, which is the ordinary exiting-shell race', () => {
    const warnings = collect()
    query(probe({ run: () => { throw new Error('AttachConsole failed') } }), 1)
    expect(warnings).toEqual([])
  })

  it('warns once on a run of failures, and not again as the run continues', () => {
    const warnings = collect()
    const failing = probe({ run: () => { throw new Error('AttachConsole failed') } })
    query(failing, 3)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/AttachConsole failed/)
    query(failing, 50)
    expect(warnings).toHaveLength(1)
  })

  it('counts a run, not a total, so occasional races never accumulate into one', () => {
    const warnings = collect()
    let calls = 0
    // Fails twice, succeeds, fails twice, succeeds — never three in a row.
    const flaky = probe({
      run: () => {
        if (calls++ % 3 === 2) return LIST
        throw new Error('AttachConsole failed')
      },
    })
    query(flaky, 30)
    expect(warnings).toEqual([])
  })

  it('treats output it cannot read as a failure, since the caller gets nothing either way', () => {
    const warnings = collect()
    query(probe({ run: () => 'not json' }), 3)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/output this build cannot read/)
  })

  it('returns the list and reports nothing while the probe works', () => {
    const warnings = collect()
    expect(queryConsoleProcessList(1234, 5_000, probe({}))).toEqual({ pids: [1, 2], self: 1 })
    expect(warnings).toEqual([])
  })
})
