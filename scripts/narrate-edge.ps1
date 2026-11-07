# edge-tts narration for autorio: every goal/decision and every STATE plan change.
#   .\scripts\narrate-edge.ps1 -RunId <id>
#   .\scripts\narrate-edge.ps1 -RunId <id> -DryRun
#   .\scripts\narrate-edge.ps1 -RunId <id> -NoPlay
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)
$root = Split-Path -Parent $PSScriptRoot
& python (Join-Path $PSScriptRoot "narrate-edge.py") @Args
