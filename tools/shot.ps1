# 全屏截图（DPI-aware）。300% 缩放的机器上不设 DPI 感知只会截到左上角一小块。
# 用法：powershell -NoProfile -File tools/shot.ps1 -Out C:\path\shot.png
param([Parameter(Mandatory = $true)][string]$Out)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public class Dpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v);
}
"@
[Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Start-Sleep -Milliseconds 150

$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved $Out ($($b.Width)x$($b.Height))"
