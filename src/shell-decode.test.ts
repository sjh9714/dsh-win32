import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import { DecodingCollector } from './shell-decode.ts'

const GBK_TEXT = '编译完成，没有错误。'

describe('DecodingCollector', () => {
  it('passes UTF-8 through unchanged with incremental offsets', () => {
    const collector = new DecodingCollector(1024)
    collector.push(Buffer.from('hello '))
    const first = collector.readFrom(0)
    expect(first.text).toBe('hello ')
    expect(first.lossy).toBe(false)
    collector.push(Buffer.from('world'))
    const second = collector.readFrom(first.nextOffset)
    expect(second.text).toBe('world')
  })

  it('decodes GBK output transparently', () => {
    const collector = new DecodingCollector(4096)
    collector.push(new Uint8Array(iconv.encode(GBK_TEXT, 'gbk')) as Buffer)
    expect(collector.readFrom(0).text).toBe(GBK_TEXT)
  })

  it('survives a GBK sequence split across chunk boundaries', () => {
    const bytes = iconv.encode(GBK_TEXT, 'gbk')
    const collector = new DecodingCollector(4096)
    collector.push(bytes.subarray(0, 3) as Buffer)
    collector.push(bytes.subarray(3) as Buffer)
    expect(collector.readFrom(0).text).toBe(GBK_TEXT)
  })

  it('keeps the tail and flags lossy on overflow', () => {
    const collector = new DecodingCollector(10)
    collector.push(Buffer.from('0123456789ABCDEF'))
    const read = collector.readFrom(0)
    expect(read.text).toBe('6789ABCDEF')
    expect(read.lossy).toBe(true)
    expect(read.nextOffset).toBe(16)
  })

  it('reads at the current tail return empty and clean', () => {
    const collector = new DecodingCollector(64)
    collector.push(Buffer.from('abc'))
    const first = collector.readFrom(0)
    expect(collector.readFrom(first.nextOffset)).toEqual({ text: '', nextOffset: 3, lossy: false })
  })
})

describe('DecodingCollector spill', () => {
  it('creates a raw spill on overflow and reports its path', () => {
    const collector = new DecodingCollector(8, 1024)
    collector.push(Buffer.from('0123456789'))
    collector.push(Buffer.from('ABCDEF'))
    const read = collector.readFrom(0)
    expect(read.spillPath).toBeDefined()
    expect(readFileSync(read.spillPath!, 'utf8')).toBe('0123456789ABCDEF')
  })

  it('discards the spill past its cap', () => {
    const collector = new DecodingCollector(4, 10)
    collector.push(Buffer.from('0123456789'))
    const before = collector.readFrom(0)
    collector.push(Buffer.from('OVERFLOW!'))
    const after = collector.readFrom(0)
    expect(after.spillPath).toBeUndefined()
    if (before.spillPath !== undefined) expect(existsSync(before.spillPath)).toBe(false)
  })

  it('produces no spill when none was requested', () => {
    const collector = new DecodingCollector(4)
    collector.push(Buffer.from('0123456789'))
    expect(collector.readFrom(0).spillPath).toBeUndefined()
  })
})
