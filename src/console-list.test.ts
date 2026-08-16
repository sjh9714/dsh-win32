import { describe, expect, it } from 'vitest'
import { parseConsoleProcessList } from './console-list.ts'

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
