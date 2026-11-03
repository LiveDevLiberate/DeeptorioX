# Capture the visible Factorio game window to a PNG for the manager's
# POST /api/agent/observe/visual endpoint.
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File scripts/capture-window.ps1 -Out C:\Temp\factorio.png [-Title Factorio] [-Focus]
#
# The script only reads the desktop. It does not click, type, move, or (by
# default) focus anything, so capturing cannot steal keyboard focus from native
# control or from the operator. -Focus is opt-in and is used only when the game
# window is covered by another window: it brings the game to the front once,
# waits briefly, then captures the real screen pixels.
#
# Exit codes:
#   0  PNG written (JSON summary on stdout)
#   1  usage error or unexpected failure
#   2  no visible Factorio game window found
#   3  game window is minimized or too small to capture
#   4  game window is covered and could not be captured without focusing it
#   5  PNG could not be written
#
# Capture requires an unlocked, interactive desktop session with the game window
# visible. Per-monitor DPI awareness is requested best-effort, so GetWindowRect
# and CopyFromScreen use the same physical pixel space.
param(
  [string]$Out,
  [string]$Title = "Factorio",
  [switch]$Focus
)

$ErrorActionPreference = "Stop"

trap {
  [Console]::Error.WriteLine("capture_failed: " + $_.Exception.Message)
  exit 1
}

function Fail([string]$Message, [int]$Code) {
  [Console]::Error.WriteLine($Message)
  exit $Code
}

function Copy-CaptureScreen {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [int]$X,
    [int]$Y,
    [int]$Width,
    [int]$Height
  )
  $graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
  try {
    $graphics.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size -ArgumentList @($Width, $Height)))
  } finally {
    $graphics.Dispose()
  }
}

# A captured surface can be entirely black when the desktop is locked or a
# PrintWindow render is unsupported (hardware-accelerated windows). Sample a
# grid instead of every pixel; the game HUD always keeps some samples lit.
function Test-BlankBitmap {
  param([System.Drawing.Bitmap]$Bitmap)
  $stepX = [Math]::Max(1, [int]($Bitmap.Width / 24))
  $stepY = [Math]::Max(1, [int]($Bitmap.Height / 24))
  $samples = 0
  $dark = 0
  for ($x = [int]($stepX / 2); $x -lt $Bitmap.Width; $x += $stepX) {
    for ($y = [int]($stepY / 2); $y -lt $Bitmap.Height; $y += $stepY) {
      $pixel = $Bitmap.GetPixel($x, $y)
      $samples++
      if ($pixel.R -lt 6 -and $pixel.G -lt 6 -and $pixel.B -lt 6) { $dark++ }
    }
  }
  if ($samples -eq 0) { return $true }
  return ($dark -ge [int]($samples * 0.98))
}

if ([string]::IsNullOrWhiteSpace($Out)) { Fail "missing_out: -Out <path> is required" 1 }
if ([string]::IsNullOrWhiteSpace($Title)) { $Title = "Factorio" } else { $Title = $Title.Trim() }

Add-Type -AssemblyName System.Drawing
if (-not ("AutorioWindow" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AutorioWindow
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string className, string windowName);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);

    public static bool EnableDpiAwareness()
    {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4 (Windows 10 1703+).
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch { }
        try { return SetProcessDPIAware(); } catch { return false; }
    }

    public static string TitleOf(IntPtr hWnd)
    {
        StringBuilder text = new StringBuilder(512);
        GetWindowText(hWnd, text, text.Capacity);
        return text.ToString();
    }

    public static uint ProcessIdOf(IntPtr hWnd)
    {
        uint processId;
        GetWindowThreadProcessId(hWnd, out processId);
        return processId;
    }

    public static IntPtr FindVisibleByExactTitle(string title)
    {
        IntPtr handle = FindWindow(null, title);
        if (handle != IntPtr.Zero && IsWindowVisible(handle)) return handle;
        return IntPtr.Zero;
    }

    public static IntPtr[] FindVisibleByTitle(string substring)
    {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            string title = TitleOf(hWnd);
            if (title.Length > 0 && title.IndexOf(substring, StringComparison.OrdinalIgnoreCase) >= 0) found.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }

    // DWM's extended frame bounds are the visible window frame (GetWindowRect
    // includes invisible resize borders); fall back to GetWindowRect on failure.
    public static RECT VisibleBounds(IntPtr hWnd)
    {
        RECT bounds;
        if (DwmGetWindowAttribute(hWnd, 9, out bounds, Marshal.SizeOf(typeof(RECT))) == 0 &&
            bounds.Right > bounds.Left && bounds.Bottom > bounds.Top)
        {
            return bounds;
        }
        RECT fallback;
        GetWindowRect(hWnd, out fallback);
        return fallback;
    }

    // Sample a grid inside the window: another top-level window at any sample
    // means its pixels are on top, so CopyFromScreen would capture the wrong app.
    public static bool IsUnobstructed(IntPtr hWnd, RECT bounds)
    {
        IntPtr root = GetAncestor(hWnd, 2);
        for (int x = 1; x <= 9; x += 2)
        {
            for (int y = 1; y <= 9; y += 2)
            {
                POINT point;
                point.X = bounds.Left + (bounds.Right - bounds.Left) * x / 10;
                point.Y = bounds.Top + (bounds.Bottom - bounds.Top) * y / 10;
                IntPtr hit = WindowFromPoint(point);
                if (hit != IntPtr.Zero && GetAncestor(hit, 2) != root) return false;
            }
        }
        return true;
    }
}
'@
}

[void][AutorioWindow]::EnableDpiAwareness()

$exact = [AutorioWindow]::FindVisibleByExactTitle($Title)
if ($exact -ne [IntPtr]::Zero) {
  $candidates = @($exact)
} else {
  $candidates = @([AutorioWindow]::FindVisibleByTitle($Title))
}
if ($candidates.Count -eq 0) {
  Fail ("game_window_not_found: no visible window titled like '{0}'. Start the graphical Factorio game and keep its window visible; this script never launches or focuses it." -f $Title) 2
}

$game = [IntPtr]::Zero
$bestArea = -1
$minimized = $false
$seen = New-Object System.Collections.Generic.List[string]
foreach ($candidate in $candidates) {
  $windowTitle = [AutorioWindow]::TitleOf($candidate)
  $bounds = [AutorioWindow]::VisibleBounds($candidate)
  $candidateWidth = $bounds.Right - $bounds.Left
  $candidateHeight = $bounds.Bottom - $bounds.Top
  $ownerPid = [AutorioWindow]::ProcessIdOf($candidate)
  $processName = ""
  try { $processName = (Get-Process -Id $ownerPid -ErrorAction Stop).ProcessName } catch { $processName = "" }
  $seen.Add(("{0} (pid {1} {2}, {3}x{4})" -f $windowTitle, $ownerPid, $processName, $candidateWidth, $candidateHeight))
  # "Factorio" is also a Steam store/library page title; only the game process
  # owns the renderable window we want.
  if ($processName -notlike "factorio*") { continue }
  if ([AutorioWindow]::IsIconic($candidate)) { $minimized = $true; continue }
  $area = $candidateWidth * $candidateHeight
  if ($area -gt $bestArea) { $game = $candidate; $bestArea = $area }
}

if ($game -eq [IntPtr]::Zero) {
  if ($minimized) {
    Fail "game_window_minimized: the Factorio window is minimized; restore it (capture never un-minimizes or focuses the game)" 3
  }
  Fail ("game_window_not_found: windows matched '{0}' but none belong to factorio.exe: {1}" -f $Title, ($seen -join "; ")) 2
}

$bounds = [AutorioWindow]::VisibleBounds($game)
$width = $bounds.Right - $bounds.Left
$height = $bounds.Bottom - $bounds.Top
if ($width -lt 64 -or $height -lt 64) {
  Fail ("game_window_too_small: {0}x{1} at {2},{3}" -f $width, $height, $bounds.Left, $bounds.Top) 3
}
$windowTitle = [AutorioWindow]::TitleOf($game)

$bitmap = New-Object System.Drawing.Bitmap -ArgumentList @($width, $height)
$method = ""

# Prefer real screen pixels when nothing covers the window.
if ([AutorioWindow]::IsUnobstructed($game, $bounds)) {
  Copy-CaptureScreen -Bitmap $bitmap -X $bounds.Left -Y $bounds.Top -Width $width -Height $height
  if (-not (Test-BlankBitmap $bitmap)) { $method = "screen" }
}

# Covered windows: ask the window to render itself into our bitmap. This uses no
# input focus and typically works for DWM-composited games.
if (-not $method) {
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  try {
    $printed = [AutorioWindow]::PrintWindow($game, $hdc, 2)   # PW_RENDERFULLCONTENT
    if (-not $printed) { $printed = [AutorioWindow]::PrintWindow($game, $hdc, 0) }
  } finally {
    $graphics.ReleaseHdc($hdc)
    $graphics.Dispose()
  }
  if ($printed -and -not (Test-BlankBitmap $bitmap)) { $method = "printwindow" }
}

# Opt-in last resort: focus the game once, wait for the compositor, and capture.
if (-not $method -and $Focus) {
  [void][AutorioWindow]::SetForegroundWindow($game)
  Start-Sleep -Milliseconds 350
  if ([AutorioWindow]::GetForegroundWindow() -eq $game -and [AutorioWindow]::IsUnobstructed($game, $bounds)) {
    Copy-CaptureScreen -Bitmap $bitmap -X $bounds.Left -Y $bounds.Top -Width $width -Height $height
    if (-not (Test-BlankBitmap $bitmap)) { $method = "screen" }
  }
}

if (-not $method) {
  $bitmap.Dispose()
  Fail "game_window_occluded: the Factorio window is covered (or the desktop is locked). Bring it to the front, or pass -Focus so the game is focused once before capture." 4
}

$outPath = [System.IO.Path]::GetFullPath($Out)
$outDirectory = [System.IO.Path]::GetDirectoryName($outPath)
try {
  if ($outDirectory -and -not [System.IO.Directory]::Exists($outDirectory)) {
    [void][System.IO.Directory]::CreateDirectory($outDirectory)
  }
  $bitmap.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
} catch {
  $message = $_.Exception.Message
  $bitmap.Dispose()
  Fail ("capture_write_failed: {0}" -f $message) 5
}
$bitmap.Dispose()

$result = [ordered]@{
  ok = $true
  path = $outPath
  window = $windowTitle
  width = $width
  height = $height
  method = $method
  focused = [bool]$Focus
}
Write-Output ($result | ConvertTo-Json -Compress)
exit 0
