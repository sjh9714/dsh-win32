import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import { decodeLegacy, sniff } from './fs.ts'

const GBK_TEXT = '你好，世界。这是一个 GBK 编码的旧项目文件。'
const gbk = () => new Uint8Array(iconv.encode(GBK_TEXT, 'gbk'))
const utf16le = (bom: boolean) => {
  const body = Buffer.from('konnichiwa 世界', 'utf16le')
  return new Uint8Array(bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body)
}

describe('sniff', () => {
  it('passes clean UTF-8 through untouched', () => {
    expect(sniff(new TextEncoder().encode('plain ascii'))).toBe('utf8')
    expect(sniff(new TextEncoder().encode('한글 UTF-8 中文'))).toBe('utf8')
    expect(sniff(new Uint8Array(0))).toBe('utf8')
  })

  it('tolerates a multi-byte sequence cut at the sniff boundary', () => {
    const bytes = new TextEncoder().encode('가나다라')
    expect(sniff(bytes.subarray(0, bytes.length - 1))).toBe('utf8')
  })

  it('detects UTF-16LE with and without BOM', () => {
    expect(sniff(utf16le(true))).toBe('utf16le')
    expect(sniff(utf16le(false))).toBe('utf16le')
  })

  it('detects GBK', () => {
    expect(sniff(gbk())).toBe('gbk')
  })
})

describe('decodeLegacy', () => {
  it('round-trips GBK content', () => {
    expect(decodeLegacy(gbk(), 'gbk')).toBe(GBK_TEXT)
  })

  it('round-trips UTF-16LE content', () => {
    expect(decodeLegacy(new Uint8Array(Buffer.from('legacy 世界', 'utf16le')), 'utf16le')).toBe('legacy 世界')
  })
})
