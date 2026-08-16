import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import { Context } from '@deepseek-ai/cordis'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import Win32FileSystem from './fs.ts'
import ConfinedWin32FileSystem from './fs-confined.ts'

interface MountedFs {
  sandboxMode: unknown
  resolve(path: string): Promise<unknown>
  readText(target: unknown): Promise<string>
  writeText(target: unknown, content: string): Promise<unknown>
}

async function mount(backend: unknown, mode: string, workspaceRoot: string): Promise<MountedFs> {
  const ctx = new Context()
  ctx.plugin(SandboxPolicyService as never, { mode, workspaceRoot } as never)
  ctx.plugin(backend as never, { cwd: workspaceRoot } as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return (ctx as never as { fs: MountedFs }).fs
}

const workspace = () => mkdtempSync(join(tmpdir(), 'dsh-win32-ws-'))

/** A path outside every writable root: workspaceRoot, `/tmp`, and tmpdir(). */
function offTempFile(content: string) {
  const dir = mkdtempSync(join(process.cwd(), '.fs-confined-out-'))
  const file = join(dir, 'secret.txt')
  writeFileSync(file, content)
  return { dir, file }
}

describe('the bare backend has no write fence', () => {
  it('reports no sandboxMode, which is what disables the editor policy', async () => {
    const fs = await mount(Win32FileSystem, 'read-only', workspace())
    // tool-str-replace-editor/src/index.ts:69 reads exactly this to decide
    // whether to construct a MutationPolicy at all.
    expect(fs.sandboxMode).toBeUndefined()
  })

  it('writes outside the workspace even under read-only', async () => {
    const fs = await mount(Win32FileSystem, 'read-only', workspace())
    const { dir, file } = offTempFile('ORIGINAL\n')
    try {
      await fs.writeText(await fs.resolve(file), 'OVERWRITTEN\n')
      expect(readFileSync(file, 'utf8')).toBe('OVERWRITTEN\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ConfinedWin32FileSystem', () => {
  it('reports the deployment mode, so the editor builds a real policy', async () => {
    const fs = await mount(ConfinedWin32FileSystem, 'read-only', workspace())
    expect(fs.sandboxMode).toBe('read-only')
  })

  it('denies every write under read-only', async () => {
    const ws = workspace()
    const fs = await mount(ConfinedWin32FileSystem, 'read-only', ws)
    const inside = join(ws, 'inside.txt')
    writeFileSync(inside, 'before\n')

    await expect(fs.writeText(await fs.resolve(inside), 'after\n')).rejects.toThrow(/denied/i)
    expect(readFileSync(inside, 'utf8')).toBe('before\n')
  })

  it('permits workspace writes and denies writes outside every writable root', async () => {
    const ws = workspace()
    const fs = await mount(ConfinedWin32FileSystem, 'workspace-write', ws)
    mkdirSync(join(ws, 'sub'), { recursive: true })
    const inside = join(ws, 'sub', 'ok.txt')
    writeFileSync(inside, 'before\n')

    await fs.writeText(await fs.resolve(inside), 'after\n')
    expect(readFileSync(inside, 'utf8')).toBe('after\n')

    const { dir, file } = offTempFile('ORIGINAL\n')
    try {
      await expect(fs.writeText(await fs.resolve(file), 'nope\n')).rejects.toThrow(/denied/i)
      expect(readFileSync(file, 'utf8')).toBe('ORIGINAL\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a pass-through under danger-full-access, so the Git Bash preset can mount it too', async () => {
    const ws = workspace()
    const fs = await mount(ConfinedWin32FileSystem, 'danger-full-access', ws)
    const { dir, file } = offTempFile('ORIGINAL\n')
    try {
      await fs.writeText(await fs.resolve(file), 'ALLOWED\n')
      expect(readFileSync(file, 'utf8')).toBe('ALLOWED\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still decodes GBK on read, which is the whole point of keeping our backend', async () => {
    const ws = workspace()
    const fs = await mount(ConfinedWin32FileSystem, 'read-only', ws)
    const legacy = join(ws, 'gbk.txt')
    const text = '你好，世界。这是一个 GBK 编码的旧项目文件。'
    writeFileSync(legacy, iconv.encode(text, 'gbk'))

    expect(await fs.readText(await fs.resolve(legacy))).toBe(text)
  })
})
