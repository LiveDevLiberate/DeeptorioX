# edge-tts narration for autorio: one decision every 5 minutes plus STATE updates.
#   .\scripts\narrate-edge.ps1 -RunId <id>
#   .\scripts\narrate-edge.ps1 -RunId <id> -DryRun
#   .\scripts\narrate-edge.ps1 -RunId <id> -NoPlay
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)
$root = Split-Path -Parent $PSScriptRoot
& python (Join-Path $PSScriptRoot "narrate-edge.py") @Args
