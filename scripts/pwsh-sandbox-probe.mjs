/**
 * Does PowerShell launch under the workspace-write restricted token, on a
 * machine with no injection-type AV?
 *
 * anywhere-labs/deepseek-harness-desktop#203 split its `0xC0000142` reports
 * into two branches: the restricted token against the pwsh/.NET startup chain
 * on its own, and the extra triggering that 火绒 / 360 / enterprise EDR add by
 * injecting DLLs. Separating them needs a measurement from a machine with no
 * injecting AV. A GitHub windows-latest runner is exactly that machine.
 *
 * This probes process START only, which is what `0xC0000142`
 * (STATUS_DLL_INIT_FAILED, exit code 3221225794) is about. It deliberately
 * does not go through the PTY or terminal-bash: a shell that never initializes
 * its DLLs never reaches them, and adding those layers would only widen the
 * set of things that could explain a failure.
 *
 * SMOKE_CHAIN=node|electron|electron-spawn-node picks which process creates the
 * restricted token. `electron-spawn-node` is the fix Albertchamberlain proposed
 * in #203, an Electron parent that hands the runner to a separate Node runtime
 * instead of loading it in process, so this cell verifies a repair rather than
 * only locating a fault.
 * `electron` reproduces the desktop app's launch chain, where the runner is an
 * `ELECTRON_RUN_AS_NODE` child rather than a plain Node process. That is the
 * one structural difference between the packaged desktop app and the CLI, and
 * #203 asked for exactly this comparison.
 *
 * Run after `npm run build`: node scripts/pwsh-sandbox-probe.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Context } from '@deepseek-ai/cordis'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'

/** STATUS_DLL_INIT_FAILED, the code the tracking issue is named after. */
const DLL_INIT_FAILED = 0xc0000142 // 3221225794 unsigned

/** One line of `key=value` so the report is greppable and diffable. */
function emit(fields) {
  console.log(Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(' '))
}

function run(argv, timeoutMs = 60_000, extraEnv = undefined) {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
  })
  return {
    status: result.status,
    signal: result.signal,
    error: result.error === undefined ? '' : String(result.error.message),
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

/**
 * Identify the host the way #203 asked reporters to: build, shell paths and
 * versions, and whether anything other than Defender is registered. The AV
 * query is what separates this branch from the injection one, so a failure to
 * answer it has to be visible rather than silently empty.
 */
function describeHost() {
  emit({ field: 'os', platform: process.platform, osRelease: release() })
  const ver = run(['cmd', '/c', 'ver'])
  emit({ field: 'windows_build', ver: ver.stdout.replace(/\s+/g, ' ') })

  for (const [label, shellPath] of WINDOWS_SHELLS) {
    if (!existsSync(shellPath)) {
      emit({ field: 'shell', shell: label, present: 'no' })
      continue
    }
    const version = run([shellPath, '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'])
    emit({ field: 'shell', shell: label, present: 'yes', path: shellPath, version: version.stdout, versionExit: version.status })
  }

  // SecurityCenter2 lists every registered AV product, Defender included.
  // displayName is what tells an injecting product apart from Defender.
  const av = run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
    'try { (Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object -ExpandProperty displayName) -join "|" } catch { "QUERY_FAILED: " + $_.Exception.Message }'])
  emit({ field: 'antivirus', products: av.stdout === '' ? '(none reported)' : av.stdout, exit: av.status })
}

/** Git Bash, the shell this chain is already known to kill at cygheap init. */
function findGitBash() {
  for (const base of ['C:\\Program Files', 'C:\\Program Files (x86)']) {
    const candidate = join(base, 'Git', 'usr', 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
  }
  return ''
}

const root = mkdtempSync(join(process.cwd(), '.pwsh-probe-ws-'))

// This probe intentionally targets clean GitHub-hosted Windows runners. Keep
// executable locations independent of PATH and environment-controlled absolute
// paths so a workflow environment cannot choose what this diagnostic executes.
const WINDOWS_SHELLS = [
  ['pwsh', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
  ['powershell51', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
]

const ctx = new Context()
await ctx.plugin(LocalSandboxProvider)
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })

const CHAIN = process.env.SMOKE_CHAIN ?? 'node'
const SUPPORTED_CHAINS = new Set(['node', 'electron', 'electron-spawn-node', 'electron-spawn-vendored-node'])
if (!SUPPORTED_CHAINS.has(CHAIN)) throw new Error(`unsupported SMOKE_CHAIN ${JSON.stringify(CHAIN)}`)
/**
 * Captured before anything swaps what process.execPath means. The vendored cell
 * uses the fixed path created by the workflow rather than an environment path.
 */
const VENDORED_NODE_PATH = join(process.cwd(), 'vendored', 'node-v20.19.5-win-x64', 'node.exe')
const NODE_PATH = CHAIN === 'electron-spawn-vendored-node' ? VENDORED_NODE_PATH : process.execPath

/**
 * Point the windows-acl rung at an `ELECTRON_RUN_AS_NODE` trampoline instead of
 * `process.execPath`. `internals` is the provider's own test hook and the argv
 * contract is unchanged, so only the process that creates the restricted token
 * differs between the two cells.
 */
function useElectronChain(spawnNode) {
  const require_ = createRequire(import.meta.url)
  const electron = require_('electron')
  if (typeof electron !== 'string') throw new Error('electron did not resolve to a binary path')
  const trampoline = join(root, spawnNode ? 'trampoline-spawn.mjs' : 'trampoline.mjs')
  const common = [
    "import { pathToFileURL, fileURLToPath } from 'node:url'",
    "// The desktop trampoline drops the flag before handing off so the runner's",
    "// own child processes are not themselves Electron-in-node mode.",
    "for (const k of Object.keys(process.env)) if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete process.env[k]",
    "const runner = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))",
  ]
  const body = spawnNode
    ? [
        "// Hand the runner to a separate Node runtime. Under ELECTRON_RUN_AS_NODE",
        "// process.execPath is electron.exe, so the real node comes in by env.",
        "import { spawnSync } from 'node:child_process'",
        "const node = process.env.PROBE_NODE_PATH",
        "if (!node) throw new Error('PROBE_NODE_PATH is required for the spawn-node chain')",
        "const r = spawnSync(node, [runner, ...process.argv.slice(2)], { stdio: 'inherit' })",
        "process.exit(r.status === null ? 1 : r.status)",
      ]
    : [
        "// pathToFileURL, not a bare path: on Windows `import('D:\\...')` reads `D:` as a URL scheme.",
        "await import(pathToFileURL(runner).href)",
      ]
  writeFileSync(trampoline, [...common, ...body, ''].join('\n'), 'utf8')
  ctx.sandbox.internals.windowsAclRunnerArgs = [electron, trampoline]
  return { electron, trampoline }
}

/**
 * The flag only belongs on runs that actually go through the runner. A
 * `danger-full-access` cell never reaches it, so giving it the flag would make
 * the control differ from the thing it is controlling for.
 */
function runThroughChain(argv, confined) {
  if (!confined || CHAIN === 'node') return run(argv)
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  if (CHAIN.startsWith('electron-spawn')) env.PROBE_NODE_PATH = NODE_PATH
  return run(argv, 60_000, env)
}

/** Crashpad noise #203 already ruled out as a root cause, recorded so the ruling stays checkable. */
function crashpad(outcome) {
  return /registration_protocol_win\.cc|crashpad/i.test(outcome.stderr + outcome.stdout) ? 'yes' : 'no'
}

let electronInfo
let failures = 0
try {
  describeHost()
  emit({ field: 'chain', chain: CHAIN })
  if (CHAIN.startsWith('electron')) {
    electronInfo = useElectronChain(CHAIN.startsWith('electron-spawn'))
    const v = run([electronInfo.electron, '--version'])
    emit({ field: 'electron', path: electronInfo.electron, version: v.stdout || v.stderr.slice(0, 80), exit: v.status ?? '(null)' })

    // Discriminator. If Electron-in-node mode cannot run a one-liner on this
    // host, then every cell below fails for that reason and says nothing about
    // the runner, the token, or pwsh. Without this the two look identical.
    const alive = run([electronInfo.electron, '-e', "console.log('alive')"], 60_000, { ELECTRON_RUN_AS_NODE: '1' })
    const nodeVersion = run([NODE_PATH, '-v'])
    emit({ field: 'node_path', path: NODE_PATH, version: nodeVersion.stdout, vendored: CHAIN === 'electron-spawn-vendored-node' ? 'yes' : 'no' })
    // A node that cannot even print its version would make every confined cell
    // below fail for that reason, which reads exactly like a sandbox verdict.
    if (nodeVersion.status !== 0) {
      emit({ field: 'fatal', error: `the node at ${NODE_PATH} is not runnable (exit ${String(nodeVersion.status)})` })
      failures += 1
      throw new Error('unusable node for the spawn chain')
    }
    emit({
      field: 'control_electron_as_node', exit: alive.status ?? '(null)',
      exitHex: alive.status === null || alive.status === undefined ? '' : '0x' + (alive.status >>> 0).toString(16),
      stdout: alive.stdout.slice(0, 80), stderr: alive.stderr.slice(0, 200),
    })

    // And whether the trampoline itself loads the runner at all, unconfined.
    // `--help` exercises argv parsing without creating a token or spawning.
    const tramp = run([electronInfo.electron, electronInfo.trampoline, '--help'], 60_000,
      { ELECTRON_RUN_AS_NODE: '1', PROBE_NODE_PATH: NODE_PATH })
    emit({
      field: 'control_trampoline', exit: tramp.status ?? '(null)',
      exitHex: tramp.status === null || tramp.status === undefined ? '' : '0x' + (tramp.status >>> 0).toString(16),
      stdout: tramp.stdout.slice(0, 150), stderr: tramp.stderr.slice(0, 250),
    })
  }

  // Two positive controls, because "pwsh started" and "the token was never
  // applied" look identical without them. Both run through the same confine()
  // call in the same job as the pwsh cells.
  //
  // Control A, the write fence. Under workspace-write a write outside the
  // workspace root has to be refused. If it succeeds, nothing below is a
  // measurement of a restricted token.
  {
    // Not os.tmpdir(): under workspace-write the runner provisions a private
    // temp child, so a temp path is not reliably "outside". The workspace root
    // is a mkdtemp child of cwd, so cwd itself is outside the grant.
    const outside = join(process.cwd(), `probe-outside-${process.pid}.txt`)
    for (const mode of ['danger-full-access', 'workspace-write']) {
      // `copy /y NUL <file>` creates the file with no shell redirection, which
      // `cmd /c` was mis-parsing when the redirect and the quoted path met.
      const argv = ['cmd', '/c', 'copy', '/y', 'NUL', outside]
      const isConfined = mode !== 'danger-full-access'
      const confined = isConfined ? ctx.sandbox.confine(argv, { mode, workspaceRoot: root }).argv : argv
      const outcome = runThroughChain(confined, isConfined)
      const wrote = existsSync(outside)
      emit({
        field: 'control_write_fence', mode, exit: outcome.status ?? '(null)',
        wroteOutsideWorkspace: wrote ? 'yes' : 'no',
        stderr: outcome.stderr.slice(0, 200),
      })
      rmSync(outside, { force: true })
      // A fence that does not hold makes the pwsh cells unreadable.
      if (mode === 'workspace-write' && wrote) failures += 1
      if (mode === 'danger-full-access' && !wrote) failures += 1
    }
  }

  // Control B, MSYS. Git Bash dies at cygheap init under this exact chain
  // (NtSetInformationToken on TokenDefaultDacl, 0xC0000022) and starts fine
  // unconfined, so it is a live read on whether the token is doing anything.
  {
    const bash = findGitBash()
    if (bash === '') {
      emit({ field: 'control_msys', result: 'git_bash_absent' })
      failures += 1
    } else {
      for (const mode of ['danger-full-access', 'workspace-write']) {
        const argv = [bash, '--noprofile', '--norc', '-c', 'exit 42']
        const isConfined = mode !== 'danger-full-access'
        const confined = isConfined ? ctx.sandbox.confine(argv, { mode, workspaceRoot: root }).argv : argv
        const outcome = runThroughChain(confined, isConfined)
        emit({
          field: 'control_msys', mode, path: bash,
          exit: outcome.status ?? '(null)',
          exitHex: outcome.status === null || outcome.status === undefined ? '' : '0x' + (outcome.status >>> 0).toString(16),
          launched: outcome.status === 42 ? 'yes' : 'no',
          cygheapDenial: /NtSetInformationToken|cygheap/i.test(outcome.stderr + outcome.stdout) ? 'yes' : 'no',
          stderr: (outcome.stderr || outcome.stdout).slice(0, 300),
        })
      }
    }
  }

  for (const [label, shellPath] of WINDOWS_SHELLS) {
    if (!existsSync(shellPath)) {
      emit({ field: 'probe', shell: label, mode: '-', result: 'shell_absent' })
      continue
    }
    // The probe body must not depend on the shell's own semantics beyond
    // exiting: the question is whether the image starts at all.
    const argv = [shellPath, '-NoProfile', '-NonInteractive', '-Command', 'exit 42']

    for (const mode of ['danger-full-access', 'workspace-write']) {
      // terminal-bash skips the provider entirely for danger-full-access, so
      // the control has to skip it here too or it would not be the control.
      let confined = argv
      let enforcement = 'none (not confined)'
      const isConfined = mode !== 'danger-full-access'
      if (isConfined) {
        // No sessionId: the agentless workspace-write path, where the runner
        // makes and removes its own random private temp child per invocation.
        const wrapped = ctx.sandbox.confine(argv, { mode, workspaceRoot: root })
        confined = wrapped.argv
        enforcement = wrapped.enforcement
      }
      const outcome = runThroughChain(confined, isConfined)
      const dllInit = outcome.status === DLL_INIT_FAILED
      emit({
        field: 'probe',
        shell: label,
        mode,
        chain: CHAIN,
        enforcement,
        exit: outcome.status ?? '(null)',
        exitHex: outcome.status === null || outcome.status === undefined ? '' : '0x' + (outcome.status >>> 0).toString(16),
        dllInitFailed: dllInit ? 'yes' : 'no',
        launched: outcome.status === 42 ? 'yes' : 'no',
        crashpadNoise: crashpad(outcome),
        spawnError: outcome.error,
        stderr: outcome.stderr.slice(0, 300),
        runner: confined[0],
      })
      // A control that cannot start the shell means the host is wrong, not the
      // sandbox, and reading the workspace-write cell against it would be
      // meaningless.
      if (mode === 'danger-full-access' && outcome.status !== 42) failures += 1
    }
  }
} catch (error) {
  emit({ field: 'fatal', error: String(error && error.stack || error) })
  failures += 1
} finally {
  await ctx.fiber.dispose().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}

// The workspace-write cell is the finding, whatever it says, so it never fails
// the job. Only a broken control does.
process.exit(failures === 0 ? 0 : 1)
