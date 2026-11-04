# Live selftest for a self-hosted Windows Factorio runner - CI use only.
#
# Assumptions (documented for whoever owns the runner):
#   * Windows self-hosted runner labelled [self-hosted, windows, factorio].
#   * Steam is running and signed in to an account that owns Factorio 2.1+.
#   * Factorio is installed where src/runtime.ts detects it (or FACTORIO_BIN
#     points at factorio.exe).
#   * Node.js 24 is on PATH, and `npm ci` + `npm run build` already ran.
#   * A baseline save is preseeded under <data-dir>/saves/<Save> (default
#     .autorio/saves/clear-test.zip; <data-dir> is .autorio unless
#     AUTORIO_DATA_DIR overrides it).
#   * No other autorio manager is listening on the test port (AUTORIO_PORT or
#     3000); this script refuses to reuse a leftover manager.
#
# Flow: start the compiled manager detached (logs .autorio/ci-manager-*.log) ->
# wait for GET /api/server/status -> POST /api/server/start with -Save -> wait
# for RCON -> unpause via POST /api/rcon/command -> `npm run selftest` (live
# read-only API check) -> always stop the manager via /api/manager/stop.
#
# Parameters:
#   -Save               save file name under <data-dir>/saves (default clear-test.zip)
#   -Port               manager API port (default AUTORIO_PORT or 3000)
#   -StartupTimeoutSec  manager HTTP readiness timeout (default 120)
#   -HostTimeoutSec     time allowed for the game to load the save (default 300)
#   -RconTimeoutSec     time allowed for RCON to connect (default 120)
#   -ShutdownTimeoutSec time allowed for the manager to stop (default 30)
#
# Exit codes: 0 when the selftest passes; the selftest exit status when it runs
# and fails; 1 when setup fails (manager, save, RCON) before the selftest.
param(
  [string]$Save = "clear-test.zip",
  [int]$Port = 0,
  [int]$StartupTimeoutSec = 120,
  [int]$HostTimeoutSec = 300,
  [int]$RconTimeoutSec = 120,
  [int]$ShutdownTimeoutSec = 30
)

$ErrorActionPreference = "Stop"

$script:root = Split-Path -Parent $PSScriptRoot
if (-not $script:root) { throw "cannot determine the repository root from $PSScriptRoot" }
Set-Location -LiteralPath $script:root

if ($Port -le 0) {
  $Port = if ($env:AUTORIO_PORT) { [int]$env:AUTORIO_PORT } else { 3000 }
}
$script:base = "http://127.0.0.1:$Port"

$dataDir = if ($env:AUTORIO_DATA_DIR) { $env:AUTORIO_DATA_DIR } else { Join-Path $script:root ".autorio" }
if (-not [System.IO.Path]::IsPathRooted($dataDir)) { $dataDir = Join-Path $script:root $dataDir }
$script:dataDir = [System.IO.Path]::GetFullPath($dataDir)
$script:stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$script:managerProcess = $null
$script:managerStarted = $false
$script:outLog = $null
$script:errLog = $null

function Write-Step {
  param([string]$Message)
  Write-Host "[ci-live-selftest] $Message"
}

function Test-ManagerReachable {
  try {
    Invoke-RestMethod -Method Get -Uri "$script:base/api/server/status" -TimeoutSec 3 -UseBasicParsing | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Invoke-ApiJson {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body = $null,
    [int]$TimeoutSec = 30
  )
  $parameters = @{
    Method = $Method
    Uri = "$script:base$Path"
    TimeoutSec = $TimeoutSec
    UseBasicParsing = $true
  }
  if ($null -ne $Body) {
    $parameters["ContentType"] = "application/json"
    $parameters["Body"] = (ConvertTo-Json -InputObject $Body -Compress)
  }
  try {
    return Invoke-RestMethod @parameters
  } catch {
    $detail = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $detail = "$detail - $($_.ErrorDetails.Message)"
    }
    throw "$Method $Path failed: $detail"
  }
}

function Start-Manager {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $nodeCommand -or -not $nodeCommand.Source) { throw "node not found on PATH" }
  $entry = Join-Path $script:root "dist\server.js"
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "missing $entry - run 'npm run build' before the live selftest"
  }
  New-Item -ItemType Directory -Force -Path $script:dataDir | Out-Null
  $script:outLog = Join-Path $script:dataDir "ci-manager-$script:stamp.out.log"
  $script:errLog = Join-Path $script:dataDir "ci-manager-$script:stamp.err.log"
  $argument = if ($entry -match "\s") { '"' + $entry + '"' } else { $entry }
  Write-Step "starting manager ($($nodeCommand.Source)) - logs: $script:outLog"
  return Start-Process -FilePath $nodeCommand.Source -ArgumentList $argument -WorkingDirectory $script:root `
    -RedirectStandardOutput $script:outLog -RedirectStandardError $script:errLog -WindowStyle Hidden -PassThru
}

function Wait-ForManager {
  Write-Step "waiting for $script:base/api/server/status (up to $StartupTimeoutSec s)"
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ($script:managerProcess) {
      $script:managerProcess.Refresh()
      if ($script:managerProcess.HasExited) {
        throw "manager exited during startup with code $($script:managerProcess.ExitCode); see $script:errLog"
      }
    }
    if (Test-ManagerReachable) {
      Write-Step "manager ready"
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "manager did not answer within $StartupTimeoutSec s; see $script:errLog"
}

function Wait-ForRcon {
  Write-Step "waiting for RCON to connect (up to $RconTimeoutSec s)"
  $deadline = (Get-Date).AddSeconds($RconTimeoutSec)
  $status = $null
  while ((Get-Date) -lt $deadline) {
    $status = Invoke-ApiJson -Method Get -Path "/api/server/status"
    if ($status.rcon -and $status.rcon.connected) {
      Write-Step "RCON connected"
      return
    }
    Start-Sleep -Seconds 1
  }
  $note = if ($status -and $status.rcon) { "$($status.rcon.note) / $($status.rcon.lastError)" } else { "no status" }
  throw "RCON did not connect within $RconTimeoutSec s ($note) - is the game fully loaded?"
}

function Stop-Manager {
  if (-not $script:managerStarted) { return }
  Write-Step "stopping manager"
  # Best effort: stop the hosted game first, then the manager. The manager's
  # shutdown also stops the game, so failures here are not fatal.
  try { Invoke-ApiJson -Method Post -Path "/api/server/stop" -TimeoutSec 15 | Out-Null } catch { }
  try { Invoke-ApiJson -Method Post -Path "/api/manager/stop" -TimeoutSec 15 | Out-Null } catch { }
  $deadline = (Get-Date).AddSeconds($ShutdownTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if ($script:managerProcess) {
      $script:managerProcess.Refresh()
      if ($script:managerProcess.HasExited) { break }
    }
    if (-not (Test-ManagerReachable)) { break }
  }
  if ($script:managerProcess) {
    $script:managerProcess.Refresh()
    if (-not $script:managerProcess.HasExited) {
      Write-Step "manager did not exit after /api/manager/stop - forcing process stop"
      Stop-Process -Id $script:managerProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Step "manager stopped"
}

$selftestExit = 1
$setupFailed = $false

try {
  if ($Save -notmatch "^[A-Za-z0-9._ -]+\.zip$") {
    throw "-Save expects a plain .zip file name under .autorio/saves (got '$Save')"
  }
  $savePath = Join-Path (Join-Path $script:dataDir "saves") $Save
  if (-not (Test-Path -LiteralPath $savePath -PathType Leaf)) {
    throw "save not found: $savePath (preseed a baseline save under <data-dir>/saves before running the live selftest)"
  }

  $npmCommand = Get-Command npm -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $npmCommand -or -not $npmCommand.Source) { throw "npm not found on PATH" }
  $npm = $npmCommand.Source

  if (Test-ManagerReachable) {
    throw "a manager is already running at $script:base - stop it before running the live selftest"
  }

  $script:managerProcess = Start-Manager
  $script:managerStarted = $true
  Wait-ForManager

  Write-Step "hosting save $Save (up to $HostTimeoutSec s)"
  Invoke-ApiJson -Method Post -Path "/api/server/start" -Body @{ save = $Save } -TimeoutSec $HostTimeoutSec | Out-Null
  Wait-ForRcon

  # A hosted save starts paused; unpause so the read-only selftest sees a live game.
  Write-Step "unpausing the game via RCON"
  $unpause = Invoke-ApiJson -Method Post -Path "/api/rcon/command" -Body @{ command = "/sc game.tick_paused=false" }
  if ($null -ne $unpause -and $unpause.ok -eq $false) {
    throw "unpause RCON command was rejected: $($unpause.error)"
  }

  Write-Step "running 'npm run selftest'"
  & $npm run selftest
  $selftestExit = $LASTEXITCODE
  if ($selftestExit -ne 0) {
    Write-Host "[ci-live-selftest] selftest FAILED (exit code $selftestExit)"
  } else {
    Write-Host "[ci-live-selftest] selftest PASSED"
  }
} catch {
  $setupFailed = $true
  Write-Host "[ci-live-selftest] ERROR: $($_.Exception.Message)"
} finally {
  Stop-Manager
}

if ($setupFailed) { exit 1 }
exit $selftestExit
