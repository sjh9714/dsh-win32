import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))
const metadata = JSON.stringify({ version: '0.2.0-rc.2', dependencies: {
  '@deepseek-ai/dsh-tool-pwsh-persistent': '^0.2.0-rc.2',
  '@deepseek-ai/dsh-pwsh-local': '^0.2.0-rc.2',
  '@deepseek-ai/dsh-pwsh-sandbox': '^0.2.0-rc.2',
} })

// Characterize the real CLI's discovery, not Windows alias activation. Only
// the external where.exe boundary is faked; default-path file checks are real.
function discover(where: string | null, installedDefault = false, legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pwsh-discovery-'))
  const defaultPath = join(root, 'PowerShell', '7', 'pwsh.exe')
  const home = join(root, 'isolated-home')
  if (installedDefault) {
    mkdirSync(dirname(defaultPath), { recursive: true })
    writeFileSync(defaultPath, '')
  }
  const before = readdirSync(root, { recursive: true })
  try {
    const source = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const calls = [];
      childProcess.execFileSync = (file, args) => {
        calls.push({ file, args });
        if (file === 'where.exe' && args.length === 1 && args[0] === 'pwsh') {
          const result = ${JSON.stringify(where)};
          if (result !== null) return result;
        }
        throw new Error('external command blocked by test');
      };
      syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.argv = [process.execPath, ${JSON.stringify(cli)}, 'doctor', '--json',
        ...${JSON.stringify(legacy ? ['--legacy'] : [])}];
      await import(${JSON.stringify(new URL('../bin/cli.mjs', import.meta.url).href)});
      console.error(JSON.stringify(calls));
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR,
        ProgramFiles: root, 'ProgramFiles(x86)': root, LOCALAPPDATA: root,
        DSH_HOME: home, DSH_WINDOWS_DSH_META: metadata, CI: 'true' },
    })
    expect(result.error).toBeUndefined()
    const envelope = JSON.parse(result.stdout)
    expect(result.status).toBe(envelope.exitCode)
    expect(existsSync(home)).toBe(false)
    expect(readdirSync(root, { recursive: true })).toEqual(before)
    const calls = JSON.parse(result.stderr.trim()) as { file: string, args: string[] }[]
    // Doctor must remain read-only: no launch of pwsh, package installer, or
    // GitHub client even when discovery fails. Legacy also checks Git/pnpm.
    expect(calls.every(call => call.file === 'where.exe')).toBe(true)
    const powershellCalls = calls.filter(call => call.args[0] === 'pwsh')
    return { check: envelope.checks.find((c: any) => c.name === 'powershell'), powershellCalls, defaultPath }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('PowerShell discovery in doctor', () => {
  it('prefers the existing default path without consulting PATH', () => {
    const result = discover('C:\\Users\\example\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe', true)
    expect(result.check.status).toBe('pass')
    expect(result.check.detail).toBe(result.defaultPath)
    expect(result.powershellCalls).toEqual([])
  })

  it.each([
    'C:\\Tools\\PowerShell\\pwsh.exe',
    'C:\\Users\\example\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe',
  ])('reports a where.exe result without launching it: %s', (path) => {
    const result = discover(`${path}\r\nC:\\another\\pwsh.exe\r\n`)
    expect(result.check.status).toBe('pass')
    expect(result.check.detail).toBe(path)
    expect(result.powershellCalls).toEqual([{ file: 'where.exe', args: ['pwsh'] }])
  })

  it.each([null, '', '\r\n'])('warns when neither default path nor where.exe locates PowerShell: %s', (where) => {
    const result = discover(where)
    expect(result.check.status).toBe('warn')
    expect(result.check.fix).toBeTruthy()
  })

  it('uses the same PATH discovery for legacy diagnostics', () => {
    const path = 'C:\\Users\\example\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
    const result = discover(path, false, true)
    expect(result.check.status).toBe('pass')
    expect(result.check.detail).toBe(path)
  })
})
