# dsh-win32 one-line installer for Windows.
#   irm https://raw.githubusercontent.com/sjh9714/dsh-win32/master/install.ps1 | iex
# Checks Node, then runs the setup (bundle + preset + desktop shortcut + doctor).
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js 22.19+ is required. Install it first:' -ForegroundColor Yellow
  Write-Host '  winget install OpenJS.NodeJS.LTS'
  exit 1
}
$version = (& node --version).TrimStart('v')
$parts = $version.Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 19)) {
  Write-Host "Node $version found, but DSH needs ^22.19.0 || >=24. Upgrade:" -ForegroundColor Yellow
  Write-Host '  winget install OpenJS.NodeJS.LTS'
  exit 1
}

Write-Host 'Running dsh-win32 setup (bundle + preset + shortcut)...'
npx --yes dsh-win32@latest setup
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'setup failed (see the error above). Please report it: https://github.com/sjh9714/dsh-win32/issues' -ForegroundColor Yellow
  exit 1
}
Write-Host ''
Write-Host 'Done. Start DeepSeek Harness with the desktop shortcut or: npx @deepseek-ai/dsh web'
Write-Host 'https://github.com/sjh9714/dsh-win32  (docs, known Windows traps, and where to report what broke)'
