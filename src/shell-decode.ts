/**
 * Legacy-encoding-aware collect readers for foreground shell output.
 *
 * The stock collectors hardcode `toString('utf8')`, so a native tool writing
 * OEM 936 (GBK) or UTF-16LE through the shell pipeline garbles. The runtime
 * cannot intercept the stock collector, but it CAN rewrite a collect-mode
 * spawn to `'pipe'`, consume the raw bytes itself, and serve the
 * `SubprocessOutputReader` contract from a decoded UTF-8 text buffer.
 *
 * Encoding is decided once per stream, at the first non-empty read, from the
 * bytes accumulated so far (reusing the fs sniffer). Mixed-encoding streams
 * are out of scope — real tool output is single-encoding in practice.
 *
 * Contract kept: offsets are byte coordinates into the UTF-8 text this reader
 * serves; overflow keeps the TAIL and flags `lossy`. Spill files are not
 * produced (the `spillPath` field is optional by contract).
 */

import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import type { Readable } from 'node:stream'
import { decodeLegacy, sniff, type SniffVerdict } from './fs.ts'

export interface OutputRead {
  text: string
  nextOffset: number
  lossy: boolean
  spillPath?: string
}

let spillCounter = 0

export class DecodingCollector {
  private chunks: Buffer[] = []
  private rawBytes = 0
  private totalRaw = 0
  private verdict: SniffVerdict | undefined
  /** UTF-8 text bytes discarded from the front of the window (whole-stream coordinates). */
  private slid = 0
  private window = Buffer.alloc(0)
  private spillFd: number | undefined
  private spillFile: string | undefined
  private spillDead = false

  constructor(private readonly maxBytes: number, private readonly spillMaxBytes?: number) {}

  /** Mirror of the stock semantics: raw bytes, created on first overflow, discarded past the cap. */
  private spillWrite(chunk: Buffer, priorChunks: Buffer[]): void {
    if (this.spillMaxBytes === undefined || this.spillDead) return
    if (this.totalRaw > this.spillMaxBytes) {
      this.spillDead = true
      if (this.spillFd !== undefined) {
        try { closeSync(this.spillFd) } catch { /* already closed */ }
        try { unlinkSync(this.spillFile!) } catch { /* already gone */ }
        this.spillFd = undefined
        this.spillFile = undefined
      }
      return
    }
    try {
      if (this.spillFd === undefined) {
        const dir = join(tmpdir(), `dsh-win32-spill-${process.pid}`)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        this.spillFile = join(dir, `stream-${spillCounter++}`)
        this.spillFd = openSync(this.spillFile, 'wx', 0o600)
        for (const prior of priorChunks) writeSync(this.spillFd, prior)
      } else {
        writeSync(this.spillFd, chunk)
      }
    } catch {
      this.spillDead = true
      this.spillFd = undefined
      this.spillFile = undefined
    }
  }

  push(chunk: Buffer): void {
    const overflowing = this.totalRaw + chunk.length > this.maxBytes
    const prior = this.spillFd === undefined && overflowing ? [...this.chunks, chunk] : []
    this.chunks.push(chunk)
    this.rawBytes += chunk.length
    this.totalRaw += chunk.length
    if (overflowing) this.spillWrite(chunk, prior)
    // Raw retention is bounded too: keep double the window for decode context.
    const rawCap = Math.max(this.maxBytes * 2, 65536)
    while (this.rawBytes > rawCap && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.rawBytes -= dropped.length
      // A dropped raw prefix means the decoded window cannot start at 0.
      if (this.verdict === undefined) this.slid = 1 // force lossy-from-zero once decoded
    }
    this.refresh()
  }

  private refresh(): void {
    const raw = Buffer.concat(this.chunks)
    if (this.verdict === undefined || this.verdict === 'unknown') {
      if (raw.length === 0) return
      // 'unknown' stays provisional: a cut multi-byte sequence can look
      // undecodable until the rest of the chunk arrives.
      this.verdict = sniff(raw)
    }
    const decoded = this.verdict === 'utf8' || this.verdict === 'unknown'
      ? raw.toString('utf8')
      : decodeLegacy(raw, this.verdict)
    let text = Buffer.from(decoded, 'utf8')
    if (text.length > this.maxBytes) {
      const overflow = text.length - this.maxBytes
      this.slid += overflow
      text = text.subarray(overflow)
      // Drop already-window-external raw bytes opportunistically for legacy
      // fixed-width encodings; variable-width GBK keeps raw context instead.
      if (this.verdict === 'utf16le' || this.verdict === 'utf16be') {
        // safe: 2-byte units; recompute from tail next time
      }
    }
    this.window = text
  }

  readFrom(fromByte: number): OutputRead {
    const start = this.slid
    const end = this.slid + this.window.length
    if (fromByte >= end) return { text: '', nextOffset: end, lossy: false }
    if (fromByte < start) {
      return { text: this.window.toString('utf8'), nextOffset: end, lossy: true, ...this.spillPathField() }
    }
    return {
      text: this.window.subarray(fromByte - start).toString('utf8'),
      nextOffset: end,
      lossy: false,
      ...this.spillPathField(),
    }
  }

  private spillPathField(): { spillPath?: string } {
    return this.spillFile !== undefined && !this.spillDead ? { spillPath: this.spillFile } : {}
  }
}

/** Attach a collector to a raw stream; resolves when the stream ends. */
export function collectStream(stream: Readable, maxBytes: number, spillMaxBytes?: number): { reader: DecodingCollector, done: Promise<void> } {
  const reader = new DecodingCollector(maxBytes, spillMaxBytes)
  const done = new Promise<void>(resolve => {
    stream.on('data', (chunk: Buffer) => reader.push(chunk))
    stream.on('end', () => resolve())
    stream.on('error', () => resolve())
  })
  return { reader, done }
}
