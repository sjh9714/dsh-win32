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
 * Run after `npm run build`: node scripts/pwsh-sandbox-probe.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
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

function run(argv, timeoutMs = 60_000) {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
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

  for (const [label, exe] of [['pwsh', 'pwsh.exe'], ['powershell51', 'powershell.exe']]) {
    const where = run(['where', exe])
    const path = where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : ''
    if (path === '') {
      emit({ field: 'shell', shell: label, present: 'no' })
      continue
    }
    const version = run([path, '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'])
    emit({ field: 'shell', shell: label, present: 'yes', path, version: version.stdout, versionExit: version.status })
  }

  // SecurityCenter2 lists every registered AV product, Defender included.
  // displayName is what tells an injecting product apart from Defender.
  const av = run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
    'try { (Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object -ExpandProperty displayName) -join "|" } catch { "QUERY_FAILED: " + $_.Exception.Message }'])
  emit({ field: 'antivirus', products: av.stdout === '' ? '(none reported)' : av.stdout, exit: av.status })
}

/** Git Bash, the shell this chain is already known to kill at cygheap init. */
function findGitBash() {
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base === undefined) continue
    const candidate = join(base, 'Git', 'usr', 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
  }
  return ''
}

const root = mkdtempSync(join(process.cwd(), '.pwsh-probe-ws-'))

const ctx = new Context()
await ctx.plugin(LocalSandboxProvider)
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })

let failures = 0
try {
  describeHost()

  // Two positive controls, because "pwsh started" and "the token was never
  // applied" look identical without them. Both run through the same confine()
  // call in the same job as the pwsh cells.
  //
  // Control A, the write fence. Under workspace-write a write outside the
  // workspace root has to be refused. If it succeeds, nothing below is a
  // measurement of a restricted token.
  {
    const outside = join(tmpdir(), `probe-outside-${process.pid}.txt`)
    for (const mode of ['danger-full-access', 'workspace-write']) {
      const argv = ['cmd', '/c', `echo probe> "${outside}"`]
      const confined = mode === 'danger-full-access'
        ? argv
        : ctx.sandbox.confine(argv, { mode, workspaceRoot: root }).argv
      const outcome = run(confined)
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
        const confined = mode === 'danger-full-access'
          ? argv
          : ctx.sandbox.confine(argv, { mode, workspaceRoot: root }).argv
        const outcome = run(confined)
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

  for (const [label, exe] of [['pwsh', 'pwsh.exe'], ['powershell51', 'powershell.exe']]) {
    const where = run(['where', exe])
    if (where.status !== 0) {
      emit({ field: 'probe', shell: label, mode: '-', result: 'shell_absent' })
      continue
    }
    const shellPath = where.stdout.split(/\r?\n/)[0].trim()
    // The probe body must not depend on the shell's own semantics beyond
    // exiting: the question is whether the image starts at all.
    const argv = [shellPath, '-NoProfile', '-NonInteractive', '-Command', 'exit 42']

    for (const mode of ['danger-full-access', 'workspace-write']) {
      // terminal-bash skips the provider entirely for danger-full-access, so
      // the control has to skip it here too or it would not be the control.
      let confined = argv
      let enforcement = 'none (not confined)'
      if (mode !== 'danger-full-access') {
        // No sessionId: the agentless workspace-write path, where the runner
        // makes and removes its own random private temp child per invocation.
        const wrapped = ctx.sandbox.confine(argv, { mode, workspaceRoot: root })
        confined = wrapped.argv
        enforcement = wrapped.enforcement
      }
      const outcome = run(confined)
      const dllInit = outcome.status === DLL_INIT_FAILED
      emit({
        field: 'probe',
        shell: label,
        mode,
        enforcement,
        exit: outcome.status ?? '(null)',
        exitHex: outcome.status === null || outcome.status === undefined ? '' : '0x' + (outcome.status >>> 0).toString(16),
        dllInitFailed: dllInit ? 'yes' : 'no',
        launched: outcome.status === 42 ? 'yes' : 'no',
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
