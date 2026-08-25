#!/usr/bin/env node

// Hidden child boundary for `dsh-win32 verify`. The parent replaces HOME,
// DSH_HOME, config roots, temp roots, and secret-bearing environment entries
// before this module imports any official DSH component.
import { runVerifyWorker } from '../lib/verify.js'

const report = await runVerifyWorker()
process.stdout.write(`${JSON.stringify(report)}\n`)
process.exitCode = report.ok ? 0 : 1
