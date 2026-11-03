# Windows entry point: find Node, build if needed, and invoke the run CLI.
# Usage:  .\autorio.ps1 start smoke   (or: autorio.cmd start smoke)
$ErrorActionPreference = "Stop"

$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $root

$candidates = @(
  $env:NODE_BIN,
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source),
  "$env:ProgramFiles\nodejs\node.exe",
  "${env:ProgramFiles(x86)}\nodejs\node.exe",
  "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
  "$env:APPDATA\npm\node.exe"
)
$node = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $node) {
  Write-Error "Install Node.js 20+ or set NODE_BIN to its executable path."
  exit 1
}
$env:PATH = (Split-Path -Parent $node) + ";" + $env:PATH

$compiler = Join-Path $root "node_modules\typescript\bin\tsc"
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
  Write-Error "Install development dependencies with 'npm ci', then run autorio again."
  exit 1
}

$entry = Join-Path $root "dist\run-cli.js"
$sources = @(Get-ChildItem -LiteralPath (Join-Path $root "src") -Filter *.ts -File) + @(Get-Item -LiteralPath (Join-Path $root "tsconfig.json"))
$rebuild = -not (Test-Path -LiteralPath $entry -PathType Leaf)
if (-not $rebuild) {
  $entryTime = (Get-Item -LiteralPath $entry).LastWriteTimeUtc
  $rebuild = [bool]($sources | Where-Object { $_.LastWriteTimeUtc -gt $entryTime } | Select-Object -First 1)
}
if ($rebuild) {
  & $node $compiler
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $node $entry @args
exit $LASTEXITCODE
