# 只截 WiFi-Rainbow 主窗口（PrintWindow），不含任务栏和输入法悬浮条。DPI-aware。
# 用法：powershell -NoProfile -File tools/shot-window.ps1 -Out docs/images/x.png [-Scale 0.5] [-Process wifi-rainbow]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [double]$Scale = 1.0,
  [string]$Process = 'wifi-rainbow'
)

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
}
"@
[Win]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

$p = Get-Process $Process -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { throw "no window for process $Process" }
$h = $p.MainWindowHandle
[Win]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 250

# DWMWA_EXTENDED_FRAME_BOUNDS(9)：不含 Win11 的隐形阴影边框
$r = New-Object Win+RECT
$full = New-Object Win+RECT
[Win]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) | Out-Null
[Win]::GetWindowRect($h, [ref]$full) | Out-Null
$w = $full.R - $full.L
$hh = $full.B - $full.T

$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Win]::PrintWindow($h, $hdc, 2) | Out-Null   # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$g.Dispose()

# 裁掉阴影边框
$cx = $r.L - $full.L; $cy = $r.T - $full.T; $cw = $r.R - $r.L; $ch = $r.B - $r.T
$crop = $bmp.Clone((New-Object System.Drawing.Rectangle($cx, $cy, $cw, $ch)), $bmp.PixelFormat)
$bmp.Dispose()

if ($Scale -ne 1.0) {
  $scaled = New-Object System.Drawing.Bitmap([int]($cw * $Scale), [int]($ch * $Scale))
  $g2 = [System.Drawing.Graphics]::FromImage($scaled)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($crop, 0, 0, $scaled.Width, $scaled.Height)
  $g2.Dispose(); $crop.Dispose(); $crop = $scaled
}
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$crop.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"saved $Out ($($crop.Width)x$($crop.Height))"
$crop.Dispose()
