/** One-off evidence, not a product acceptance gate or a full Desktop/Minimal UI test. */
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { release } from 'node:os'

if (process.platform !== 'win32') throw new Error('Windows-only probe')
const root = process.env.PROBE_ROOT
const app = process.env.PROBE_APP
const cargo = process.env.PROBE_CARGO
const electron = process.env.PROBE_ELECTRON
if (![root, app, cargo, electron].every(value => value && existsSync(value))) throw new Error('Missing probe paths')
const results = join(root, 'results')
mkdirSync(results, { recursive: true })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const pwshQuote = value => "'" + value.replaceAll("'", "''") + "'"

if (!process.argv.includes('--worker')) {
  let failures = 0
  for (const lane of ['node', 'desktop']) {
    const home = join(root, lane, 'home')
    const runtimeTemp = join(root, lane, 'temp')
    mkdirSync(home, { recursive: true })
    mkdirSync(runtimeTemp, { recursive: true })
    const env = {
      ...process.env, PROBE_LANE: lane, DSH_HOME: join(home, '.dsh'),
      RUSTC: join(dirname(cargo), 'rustc.exe'),
      USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'), TMP: runtimeTemp, TEMP: runtimeTemp,
    }
    for (const key of Object.keys(env)) {
      if (/^ELECTRON_RUN_AS_NODE$/i.test(key)) delete env[key]
      if (/^(CARGO|RUSTUP)_/.test(key)) delete env[key]
    }
    if (lane === 'desktop') env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(lane === 'desktop' ? electron : process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
      env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.pipe(process.stdout)
    child.stderr.pipe(process.stderr)
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (child.pid && child.exitCode === null) {
          try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch {}
        }
      }, 300_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); resolve(code) })
    })
    if (exit !== 0) failures += 1
    const evidence = join(results, lane + '.json')
    if (existsSync(evidence)) console.log(readFileSync(evidence, 'utf8'))
    else { console.error(`${lane}: no evidence file`); failures += 1 }
  }
  // The disposable runner owns the payload; do not remove a possibly live process's workspace.
  process.exitCode = failures ? 1 : 0
} else {
  const lane = process.env.PROBE_LANE
  for (const key of Object.keys(process.env)) if (/^ELECTRON_RUN_AS_NODE$/i.test(key)) delete process.env[key]
  const workspace = join(root, lane, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const outside = join(root, lane, 'outside.txt')
  const requireApp = createRequire(join(app, 'package.json'))
  const load = name => import(pathToFileURL(requireApp.resolve(name)).href)
  const evidence = {
    lane, windows: release(), node: process.versions.node, electron: process.versions.electron ?? null,
    desktop: JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version,
    boundary: 'Unmodified official installer payload, foreground PowerShell executor and isolated Cargo fetch only. No installer execution, Desktop UI, model, persistent terminal, hook or Blue Minimal TUI acceptance.',
    checks: [],
  }
  const save = () => writeFileSync(join(results, lane + '.json'), JSON.stringify(evidence, null, 2))
  const record = (name, value) => { evidence.checks.push({ name, ...value }); save(); console.log(`${lane}: ${name} ${value.status ?? ''}`) }
  const clean = value => String(value ?? '').replaceAll(root, '<probe-root>').slice(0, 6000)
  let ctx
  try {
    evidence.cargo = execFileSync(cargo, ['-Vv'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim()
    evidence.dsh = JSON.parse(readFileSync(requireApp.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version
    if (evidence.desktop !== '2.0.11' || evidence.dsh !== '0.1.5-rc.2') throw new Error('Unexpected payload version')
    const koffi = requireApp('koffi')
    const getConsole = koffi.load('kernel32.dll').func('void * __stdcall GetConsoleWindow()')
    evidence.consolelessParent = getConsole() === null
    if (lane === 'desktop' && !evidence.consolelessParent) throw new Error('Desktop control is not consoleless')
    const [{ Context }, subprocess, sandbox, policy, shell] = await Promise.all([
      load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-subprocess-local'),
      load('@deepseek-ai/dsh-sandbox-local'), load('@deepseek-ai/dsh-sandbox-policy'),
      lane === 'desktop' ? import(pathToFileURL(join(app, 'lib', 'windows-pwsh-sandbox.js')).href) : load('@deepseek-ai/dsh-pwsh-sandbox'),
    ])
    ctx = new Context()
    const projection = await load('@deepseek-ai/dsh-session-projection')
    await ctx.plugin(projection.default)
    await ctx.plugin(subprocess.default)
    await ctx.plugin(sandbox.default)
    await ctx.plugin(policy.default, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(shell.default, { cwd: workspace, timeoutMs: 60_000, maxTimeoutMs: 120_000 })
    if (!ctx.shell) throw new Error('PowerShell executor did not activate')
    evidence.pwshPath = ctx.shell.pwshPath
    const run = async (command, mode = 'workspace-write', extra = {}) => {
      const result = await ctx.shell.run(ctx.shell.resolve({ command, workdir: workspace, sandboxPolicy: { mode, workspaceRoot: workspace }, ...extra }))
      return { exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted, sandbox: result.sandbox, stdout: clean(result.stdout.text), stderr: clean(result.stderr.text) }
    }
    const control = await run(`[IO.File]::WriteAllText(${pwshQuote(outside)}, 'control'); Write-Output 'CONTROL_OK'`, 'danger-full-access')
    record('unconfined_write_control', { status: control.exitCode === 0 && existsSync(outside) ? 'pass' : 'fail', ...control })
    if (control.exitCode !== 0 || !existsSync(outside)) throw new Error('Unconfined outside-write control failed')
    rmSync(outside)
    const inside = join(workspace, 'inside.txt')
    const confined = await run(`[IO.File]::WriteAllText(${pwshQuote(inside)}, 'inside'); try { [IO.File]::WriteAllText(${pwshQuote(outside)}, 'unexpected'); exit 71 } catch { Write-Output 'OUTSIDE_DENIED'; exit 0 }`)
    const confinedOk = confined.exitCode === 0 && existsSync(inside) && !existsSync(outside) && confined.stdout.includes('OUTSIDE_DENIED')
    record('confined_launch_and_write_fence', { status: confinedOk ? 'pass' : 'fail', ...confined })
    if (!confinedOk) throw new Error('Confined startup/write control failed; Cargo attribution would be invalid')

    for (const mode of ['danger-full-access', 'workspace-write']) {
      const cargoHome = join(workspace, mode === 'workspace-write' ? 'cargo-confined' : 'cargo-control')
      mkdirSync(cargoHome)
      writeFileSync(join(workspace, 'Cargo.toml'), '[package]\nname = "dsh_tls_probe"\nversion = "0.0.0"\nedition = "2021"\n[lib]\npath = "lib.rs"\n[dependencies]\nitoa = "=1.0.15"\n')
      writeFileSync(join(workspace, 'lib.rs'), '// fetch only: no code is built or executed\n')
      const result = await run(`& ${pwshQuote(cargo)} fetch --manifest-path ${pwshQuote(join(workspace, 'Cargo.toml'))}; exit $LASTEXITCODE`, mode, {
        timeoutMs: 90_000,
        env: { CARGO_HOME: cargoHome, CARGO_HTTP_TIMEOUT: '30', CARGO_NET_RETRY: '0', CARGO_TERM_COLOR: 'never' },
      })
      record('cargo_fetch_' + mode, {
        status: result.exitCode === 0 ? 'pass' : 'fail',
        schannelNoCredentials: /8009030e|SEC_E_NO_CREDENTIALS|AcquireCredentialsHandle/i.test(result.stderr), ...result,
      })
      if (mode === 'danger-full-access' && result.exitCode !== 0) throw new Error('Unconfined Cargo control failed; no sandbox attribution')
    }

    const pidFile = join(workspace, 'cancel-pid.txt')
    const controller = new AbortController()
    const pending = run(`[IO.File]::WriteAllText(${pwshQuote(pidFile)}, [string]$PID); Start-Sleep -Seconds 60`, 'workspace-write', { signal: controller.signal, timeoutMs: 90_000 })
      .catch(error => ({ error: clean(error.message) }))
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) await pause(100)
    controller.abort(new Error('probe cancellation'))
    let cancellation
    try { cancellation = await pending } catch (error) { cancellation = { error: clean(error.message) } }
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : null
    let alive = true
    if (Number.isInteger(pid) && pid > 0) {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') { alive = false; break } }
        await pause(100)
      }
    }
    record('cancellation_and_direct_child_exit', { status: alive ? 'fail' : 'pass', childPid: pid, ...cancellation })
  } catch (error) {
    record('probe_error', { status: 'fail', error: clean(error.stack ?? error) })
  } finally {
    if (ctx) {
      try { await ctx.fiber.dispose(); record('context_dispose', { status: 'pass' }) }
      catch (error) { record('context_dispose', { status: 'fail', error: clean(error) }) }
    }
    try {
      const command = `$p = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne ${process.pid} -and $_.CommandLine -and $_.CommandLine.Contains(${pwshQuote(resolve(workspace))}) }); $p | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json -Compress`
      const matches = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 20_000, windowsHide: true }).trim()
      record('workspace_process_inventory', { status: matches === '' ? 'pass' : 'fail', matches: matches || '[]' })
    } catch (error) { record('workspace_process_inventory', { status: 'fail', error: clean(error.message) }) }
    evidence.ok = evidence.checks.length > 0 && evidence.checks.every(check => check.status === 'pass')
    save()
    process.exitCode = evidence.ok ? 0 : 1
  }
}
