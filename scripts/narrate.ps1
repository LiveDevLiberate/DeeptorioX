# Narrate an autorio agent's reasoning with Windows TTS (System.Speech).
#
#   .\scripts\narrate.ps1 -ListVoices
#   .\scripts\narrate.ps1 -RunId 2026-11-02_17-06-40_PST-e48c5498
#   .\scripts\narrate.ps1 -IncludeMessages -Voice "Microsoft Guy Online (Natural)"
#   .\scripts\narrate.ps1 -Digest                    # low-noise condensed digest stream
#   .\scripts\narrate.ps1 -Digest -MinChars 8        # short CJK digest lines
#   .\scripts\narrate.ps1 -Digest -Dedupe:$false     # speak repeated digest lines too
#
# By default it follows the newest run's thoughts.log and starts at the current
# end, so only new reasoning is spoken. Ctrl-C stops narration; the game keeps
# running. Use -DryRun to print without speaking.
#
# -Digest reads thoughts.digest.log (one condensed line per reasoning chunk)
# instead of the raw thoughts.log; it is ignored with -IncludeMessages.
# -Dedupe (on by default) skips a line identical to the previously spoken line.
# Disable it with -Dedupe:$false inside PowerShell, or -NoDedupe from cmd/CI.
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$RunId,
  [string]$RunDir,
  [string]$Voice,
  [int]$Rate = 0,
  [int]$MinChars = 24,
  [int]$MaxChars = 420,
  [switch]$IncludeMessages,
  [switch]$MessagesOnly,
  [switch]$Digest,
  [switch]$Dedupe = $true,
  [switch]$NoDedupe,
  [switch]$FromStart,
  [switch]$ListVoices,
  [switch]$DryRun,
  [switch]$Once
)

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))

if ($ListVoices) {
  $synth.GetInstalledVoices() | ForEach-Object {
    [pscustomobject]@{
      Name = $_.VoiceInfo.Name
      Culture = $_.VoiceInfo.Culture
      Gender = $_.VoiceInfo.Gender
      Enabled = $_.Enabled
    }
  } | Format-Table -AutoSize
  exit 0
}
if ($Voice) { $synth.SelectVoice($Voice) }
if ($MessagesOnly) { $IncludeMessages = $true }

if (-not $RunDir) {
  if ($RunId) {
    $RunDir = Join-Path $Root ".autorio\runs\$RunId"
  } else {
    $runsRoot = Join-Path $Root ".autorio\runs"
    if (-not (Test-Path -LiteralPath $runsRoot)) { Write-Error "No runs found under $runsRoot"; exit 1 }
    $RunDir = Get-ChildItem -LiteralPath $runsRoot -Directory |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
}
if (-not (Test-Path -LiteralPath $RunDir)) { Write-Error "Run directory not found: $RunDir"; exit 1 }

$source = if ($IncludeMessages) {
  Join-Path $RunDir "agent.events.jsonl"
} elseif ($Digest) {
  Join-Path $RunDir "thoughts.digest.log"
} else {
  Join-Path $RunDir "thoughts.log"
}
$runFile = Join-Path $RunDir "run.json"
Write-Host "Narrating $source"
Write-Host "Voice: $($synth.Voice.VoiceInfo.Name) · rate=$Rate · Ctrl-C to stop"
if ($Digest -and -not $IncludeMessages) {
  Write-Host "Digest mode: condensed one-line thoughts (use -MinChars 8 for short CJK lines)."
}
if ($DryRun) { Write-Host "Dry run: text is printed, not spoken." }

function Clean-Text([string]$text) {
  $text = $text -replace '(?s)```.*?```', ' '
  $text = $text -replace '`[^`]*`', ' '
  $text = $text -replace 'https?://\S+', ' '
  $text = $text -replace '\s+', ' '
  return $text.Trim()
}

function Should-Speak([string]$text) {
  if ($text.Length -lt $MinChars) { return $false }
  if ($text -match '^(?:\{|\[|/sc\b)') { return $false }
  if ($text -match '^(?:cd |python3? |Get-ChildItem|ls |cat )') { return $false }
  return $true
}

# Wait for the file, then start at its current end unless -FromStart was given.
while (-not (Test-Path -LiteralPath $source)) { Start-Sleep -Milliseconds 300 }
$offset = if ($FromStart) { 0 } else { (Get-Item -LiteralPath $source).Length }
$remainder = ""
$lastSpoken = ""

while ($true) {
  if (Test-Path -LiteralPath $source) {
    $length = (Get-Item -LiteralPath $source).Length
    if ($length -gt $offset) {
      $stream = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      try {
        [void]$stream.Seek($offset, [IO.SeekOrigin]::Begin)
        $count = [int]($stream.Length - $offset)
        $buffer = New-Object byte[] $count
        $read = $stream.Read($buffer, 0, $count)
      } finally { $stream.Dispose() }
      $offset += $read
      $chunk = $remainder + [Text.Encoding]::UTF8.GetString($buffer, 0, $read)
      $lines = $chunk -split "`n"
      if ($chunk.EndsWith("`n")) { $remainder = "" }
      else { $remainder = $lines[-1]; if ($lines.Count -gt 1) { $lines = $lines[0..($lines.Count - 2)] } else { $lines = @() } }

      foreach ($line in $lines) {
        $text = $line.Trim()
        if (-not $text) { continue }
        if ($IncludeMessages) {
          try { $event = $text | ConvertFrom-Json } catch { continue }
          if ($event.type -ne "item.completed" -or -not $event.item) { continue }
          if ($event.item.type -ne "reasoning" -and $event.item.type -ne "agent_message") { continue }
          if ($MessagesOnly -and $event.item.type -ne "agent_message") { continue }
          $text = [string]$event.item.text
        }
        $text = Clean-Text $text
        if (-not (Should-Speak $text)) { continue }
        if ($text.Length -gt $MaxChars) {
          $text = $text.Substring(0, $MaxChars)
          $cut = $text.LastIndexOf(" ")
          if ($cut -gt 0) { $text = $text.Substring(0, $cut) }
        }
        if ($Dedupe -and -not $NoDedupe -and $text -eq $lastSpoken) { continue }
        $lastSpoken = $text
        if ($DryRun) { Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] $text" }
        else { $synth.Speak($text) }
        try { Set-Content -LiteralPath (Join-Path $RunDir "narration.txt") -Value $text -Encoding UTF8 } catch { }
      }
    }
  }
  if ($Once) { break }
  Start-Sleep -Milliseconds 250
}
