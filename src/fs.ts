/**
 * dsh-win32/fs: legacy-encoding-aware filesystem provider.
 *
 * Stock fs-local decodes strictly as UTF-8 and fails loud (`FS_NOT_TEXT`) on
 * GBK/CP936 and UTF-16LE files, so agents cannot open files in Chinese-locale
 * legacy projects at all. This provider sniffs the head bytes first: clean
 * UTF-8 delegates to the stock implementation untouched; UTF-16 BOMs and
 * GBK-decodable content are decoded transparently on READ paths.
 *
 * Writes stay UTF-8 (stock behavior). Editing a legacy file therefore saves
 * it back as UTF-8 — documented, deliberate: round-tripping legacy encodings
 * would mean reimplementing the atomic-write and Windows-DACL machinery.
 *
 * Mounted per-preset inside the `isolate: fs` group, the sanctioned
 * replacement seam (precedent: @deepseek-ai/dsh-fs-sandbox).
 */

import iconv from 'iconv-lite'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'

interface FsTargetLike {
  displayPath: string
  targetKey: string
}

const SNIFF_BYTES = 65536
const LEGACY_MAX_BYTES = 8_000_000

export type SniffVerdict = 'utf8' | 'utf16le' | 'utf16be' | 'gbk' | 'unknown'

function utf8Clean(bytes: Uint8Array): boolean {
  // A sniff window may cut a multi-byte sequence at its end; trim up to 3
  // trailing continuation-or-lead bytes before the fatal check.
  let end = bytes.length
  for (let i = 0; i < 3 && end > 0; i++) {
    const byte = bytes[end - 1]!
    if (byte < 0x80) break
    end -= 1
    if (byte >= 0xc0) break
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))
    return true
  } catch {
    return false
  }
}

/** Classify head bytes. Pure, exported for tests. */
export function sniff(bytes: Uint8Array): SniffVerdict {
  if (bytes.length === 0) return 'utf8'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf16be'
  const window = bytes.subarray(0, Math.min(bytes.length, 4096))
  // NUL bytes are valid UTF-8 (U+0000) but never sane text: check first,
  // otherwise BOM-less UTF-16LE ASCII sails through the UTF-8 gate.
  const hasNul = window.includes(0)
  if (!hasNul) {
    if (utf8Clean(bytes)) return 'utf8'
    // GBK candidate: decode must not produce replacement characters. A sniff
    // window may cut a two-byte GBK sequence at its end, so a failed full
    // decode gets one retry with the last byte dropped.
    const gbkClean = (end: number) => end > 0 && !iconv.decode(Buffer.from(window.subarray(0, end)), 'gbk').includes('�')
    if (gbkClean(window.length) || gbkClean(window.length - 1)) return 'gbk'
    return 'unknown'
  }
  // BOM-less UTF-16LE: ASCII text shows as `X 0x00` pairs — count NULs in odd positions.
  let oddNulls = 0
  for (let i = 1; i < window.length; i += 2) if (window[i] === 0) oddNulls += 1
  if (window.length >= 8 && oddNulls / (window.length / 2) > 0.4) return 'utf16le'
  return 'unknown'
}

/** Decode a whole legacy buffer per verdict. Exported for tests. */
export function decodeLegacy(bytes: Uint8Array, verdict: SniffVerdict): string {
  const buffer = Buffer.from(bytes)
  switch (verdict) {
    case 'utf16le': return iconv.decode(buffer, 'utf16le')
    case 'utf16be': return iconv.decode(buffer, 'utf16-be')
    case 'gbk': return iconv.decode(buffer, 'gbk')
    default: throw new Error(`decodeLegacy: not a legacy verdict: ${verdict}`)
  }
}

export const name = 'fs-win32'

export default class Win32FileSystem extends LocalFileSystem {
  private async legacyText(target: FsTargetLike, signal: AbortSignal | undefined): Promise<string | undefined> {
    const head = await this.readBytes(target as never, signal, SNIFF_BYTES)
    const verdict = sniff(head)
    if (verdict === 'utf8' || verdict === 'unknown') return undefined
    const whole = head.length < SNIFF_BYTES ? head : await this.readBytes(target as never, signal, LEGACY_MAX_BYTES)
    // At the cap the file may be truncated; fall back to stock behavior
    // (its own size/error semantics) rather than return a silent partial.
    if (whole.length >= LEGACY_MAX_BYTES) return undefined
    return decodeLegacy(whole, verdict)
  }

  override async readText(target: FsTargetLike, signal?: AbortSignal): Promise<string> {
    const legacy = await this.legacyText(target, signal).catch(() => undefined)
    if (legacy !== undefined) return legacy
    return super.readText(target as never, signal)
  }

  override async streamText(target: FsTargetLike, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const legacy = await this.legacyText(target, signal).catch(() => undefined)
    if (legacy !== undefined) {
      return (async function* () { yield legacy })()
    }
    return super.streamText(target as never, signal)
  }
}
