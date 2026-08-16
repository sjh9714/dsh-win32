import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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

  // deepseek-harness#2252: a Windows temp cleaner removes the spill directory
  // during a long session, and the next spill open throws ENOENT out of a
  // stream 'data' listener, killing the host. The directory is re-made on
  // every open rather than cached, so the cleaner costs nothing.
  it('recreates a spill directory removed before the first spill', () => {
    const first = new DecodingCollector(4, 4096)
    first.push(Buffer.from('0123456789'))
    const dir = dirname(first.readFrom(0).spillPath!)
    rmSync(dir, { recursive: true, force: true })

    const second = new DecodingCollector(4, 4096)
    expect(() => second.push(Buffer.from('abcdefghij'))).not.toThrow()
    const path = second.readFrom(0).spillPath
    expect(path).toBeDefined()
    expect(readFileSync(path!, 'utf8')).toBe('abcdefghij')
  })

  // The same guard has to hold when the target cannot be made at all, since
  // push() runs inside a stream listener where a throw is unrecoverable.
  it('degrades instead of throwing when the spill target cannot be created', () => {
    const probe = new DecodingCollector(4, 4096)
    probe.push(Buffer.from('0123456789'))
    const dir = dirname(probe.readFrom(0).spillPath!)
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, 'a file where the directory should be')
    try {
      const collector = new DecodingCollector(4, 4096)
      expect(() => collector.push(Buffer.from('0123456789'))).not.toThrow()
      const read = collector.readFrom(0)
      expect(read.spillPath).toBeUndefined()
      expect(read.text).toBe('6789')
    } finally {
      rmSync(dir, { force: true })
    }
  })
})
