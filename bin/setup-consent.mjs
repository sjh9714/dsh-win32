import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const WIN = process.platform === 'win32'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const REPO = 'https://github.com/sjh9714/dsh-win32'

const CI_SETUP_ENV = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'TF_BUILD',
]

function tryExec(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

function environmentFlagIsActive(env, name) {
  const value = env[name]
  if (value === undefined) return false
  const normalized = value.trim()
  return normalized !== '' && !/^(?:0|false|no|off)$/i.test(normalized)
}

export function isCISetupEnvironment(env = process.env) {
  return CI_SETUP_ENV.some((name) => environmentFlagIsActive(env, name))
}

function recordSetupStar(home) {
  const marker = join(home, '.dsh-win32-star-prompted')
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(marker, `${new Date().toISOString()} yes\n`, { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

function writeLine(output, message) {
  output.write(`${message}\n`)
}

function applySetupStar({
  home = DSH_HOME,
  win = WIN,
  output = process.stdout,
  probe = tryExec,
  execute = execFileSync,
} = {}) {
  const marker = join(home, '.dsh-win32-star-prompted')
  if (existsSync(marker)) {
    writeLine(output, 'STAR_CONFIRMATION_ALREADY_RECORDED: already recorded; no action was taken')
    return 0
  }
  if (!recordSetupStar(home)) {
    if (existsSync(marker)) {
      writeLine(output, 'STAR_CONFIRMATION_ALREADY_RECORDED: already recorded; no action was taken')
      return 0
    }
    writeLine(output, 'STAR_CONFIRMATION_FAILED: could not record the answer; no GitHub account change was made')
    return 1
  }
  const githubCli = win ? 'gh.exe' : 'gh'
  const canStar = probe(githubCli, ['auth', 'status', '--hostname', 'github.com']) !== undefined
  if (canStar) {
    try {
      execute(githubCli, ['api', '--hostname', 'github.com', '--method', 'PUT', 'user/starred/sjh9714/dsh-win32'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      writeLine(output, 'STAR_CONFIRMATION_APPLIED: Starred dsh-win32 with your authenticated GitHub account')
      return 0
    } catch {
      writeLine(output, 'STAR_CONFIRMATION_RECORDED: Yes, but GitHub did not accept the Star request')
    }
  } else {
    writeLine(output, 'STAR_CONFIRMATION_RECORDED: Yes; no authenticated GitHub CLI account was found')
  }

  writeLine(output, `Repository: ${REPO}`)
  if (!win) return 1
  try {
    execute('rundll32.exe', ['url.dll,FileProtocolHandler', REPO], { windowsHide: true })
    writeLine(output, 'Opened GitHub in your default browser; the final Star click is yours.')
  } catch {
    writeLine(output, `Could not open the browser; visit ${REPO}`)
  }
  return 1
}

export function offerSetupStar({
  env = process.env,
  output = process.stdout,
  ...options
} = {}) {
  if (isCISetupEnvironment(env)) {
    writeLine(output, 'STAR_CONFIRMATION_SKIPPED: CI environment; no marker or GitHub account change was made')
    return 0
  }
  return applySetupStar({ output, ...options })
}
