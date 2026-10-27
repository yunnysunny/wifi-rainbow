# 把 cargo tauri build 生成的 wifi-rainbow.exe 打成 MSIX（给微软商店，或本机侧载测试）。
# Tauri 2 只会出 NSIS/MSI，MSIX 由这个脚本用 Windows SDK 的 makeappx 拼出来。
#
# 用法：
#   powershell -NoProfile -File tools/pack-msix.ps1 [-Build]
#       不签名，产物交给 Partner Center，商店会用微软的证书重新签。
#       默认的 Publisher / IdentityName / PublisherDisplayName 已照抄 Partner Center
#       「产品标识」页（whyun.WiFiRainbow），改了会导致上传校验不过。
#   powershell -NoProfile -File tools/pack-msix.ps1 -DevCert
#       本机测试：生成（或复用）一张自签名证书并签名；证书要进 LocalMachine\TrustedPeople，
#       以管理员运行时自动导入，否则脚本会打印一条需要提权执行的导入命令。
#       之后 Add-AppxPackage rust\target\release\bundle\msix\*.msix 侧载。
#       开了开发者模式的话也可以不签名，直接
#       Add-AppxPackage -Register rust\target\release\bundle\msix\stage\AppxManifest.xml
#   powershell -NoProfile -File tools/pack-msix.ps1 -CertPath x.pfx -CertPassword ***
#       用自己的证书签名（证书主题必须和 -Publisher 完全一致）。
#
# 输出：rust/target/release/bundle/msix/WiFi-Rainbow_<版本>_x64.msix
#
# 运行时差异（打包后）：
#   - %LOCALAPPDATA%\WiFiRainbow 会被重定向到包的私有目录
#     （%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\Local\WiFiRainbow），卸载时一起删掉。
#   - 不带 WebView2 安装器：Win11 自带；Win10 需要系统里已有 WebView2 运行时。
#   - 声明了 location 设备能力：Win11 24H2 起读 BSSID 受「位置」隐私开关控制，
#     打包应用要声明它才会出现在设置的应用列表里。
param(
  [switch]$Build,
  [string]$Version,                                   # 默认取 tauri.conf.json 的 version，补成 x.y.z.0
  [string]$IdentityName = 'whyun.WiFiRainbow',          # Partner Center 产品标识（Store ID 9NMSS3WTJRGR）
  [string]$Publisher = 'CN=48325D51-0D86-4D4C-811F-9CFEA8D3F947',
  [string]$PublisherDisplayName = 'whyun',
  [string]$DisplayName = 'WiFi Rainbow',
  [switch]$DevCert,
  [string]$CertPath,
  [string]$CertPassword
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$rust = Join-Path $root 'rust'
$conf = Get-Content (Join-Path $rust 'src-tauri/tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json

if (-not $Version) { $Version = $conf.version }
$parts = @($Version.Split('.'))
while ($parts.Count -lt 4) { $parts += '0' }
# 商店要求第四段是 0（保留给商店用）
if ($parts[3] -ne '0') { throw "MSIX version must end in .0 for the Store: $Version" }
$Version = $parts[0..3] -join '.'

# ---------------------------------------------------------------- 工具
function Find-SdkTool($name) {
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $hit = Get-ChildItem $kits -Directory -Filter '10.*' -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName "x64\$name" } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $hit) { throw "$name not found; install the Windows 10/11 SDK" }
  $hit
}
$makeappx = Find-SdkTool 'makeappx.exe'

# ---------------------------------------------------------------- exe
$exe = Join-Path $rust 'target/release/wifi-rainbow.exe'
if ($Build) {
  Push-Location $rust
  try {
    # 只编 exe，不跑 NSIS
    cargo tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "cargo tauri build failed ($LASTEXITCODE)" }
  } finally { Pop-Location }
}
if (-not (Test-Path $exe)) { throw "missing $exe; run with -Build or cargo tauri build first" }

# ---------------------------------------------------------------- 暂存目录
$stage = Join-Path $rust 'target/release/bundle/msix/stage'
$outDir = Split-Path -Parent $stage
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $stage 'Assets') -Force | Out-Null
Copy-Item $exe $stage
Copy-Item (Join-Path $root 'LICENSE') $stage

# 磁贴/列表图标：从 icon.png 缩放。源图只有 64px，150 那张会略糊，换高清源图后自动变清楚。
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Join-Path $rust 'src-tauri/icons/icon.png'))
function Save-Logo($file, $w, $h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $side = [Math]::Min($w, $h)
  $g.DrawImage($src, [int](($w - $side) / 2), [int](($h - $side) / 2), $side, $side)
  $bmp.Save((Join-Path $stage "Assets\$file"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
try {
  Save-Logo 'StoreLogo.png' 50 50
  Save-Logo 'Square44x44Logo.png' 44 44
  Save-Logo 'Square44x44Logo.targetsize-44_altform-unplated.png' 44 44  # 任务栏上不加底色
  Save-Logo 'Square150x150Logo.png' 150 150
  Save-Logo 'Wide310x150Logo.png' 310 150
} finally { $src.Dispose() }

# ---------------------------------------------------------------- 清单
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap rescap">
  <Identity Name="$(& $esc $IdentityName)" Publisher="$(& $esc $Publisher)" Version="$Version" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>$(& $esc $DisplayName)</DisplayName>
    <PublisherDisplayName>$(& $esc $PublisherDisplayName)</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="zh-CN" />
    <Resource Language="en-US" />
  </Resources>
  <Applications>
    <Application Id="WiFiRainbow" Executable="wifi-rainbow.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="$(& $esc $DisplayName)" Description="$(& $esc 'Wi-Fi 分析工具（Inspector + 信道/干扰）')"
                          BackgroundColor="transparent"
                          Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
    <DeviceCapability Name="location" />
  </Capabilities>
</Package>
"@
[System.IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $manifest, (New-Object System.Text.UTF8Encoding($false)))

# ---------------------------------------------------------------- 打包
$msix = Join-Path $outDir "WiFi-Rainbow_$($parts[0..2] -join '.')_x64.msix"
if (Test-Path $msix) { Remove-Item $msix -Force }
& $makeappx pack /d $stage /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }

# ---------------------------------------------------------------- 签名（可选）
if ($DevCert) {
  Import-Module Microsoft.PowerShell.Security, PKI  # Cert: 驱动器和 New-SelfSignedCertificate
  $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $Publisher -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
  if (-not $cert) {
    $cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature `
      -FriendlyName 'WiFi Rainbow MSIX dev' -CertStoreLocation Cert:\CurrentUser\My `
      -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
  }
  # 侧载要求签名证书在 LocalMachine\TrustedPeople 里（CurrentUser 的不算），写它需要管理员
  if (-not (Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object Thumbprint -eq $cert.Thumbprint)) {
    $cer = Join-Path $outDir 'wifi-rainbow-msix-dev.cer'
    Export-Certificate -Cert $cert -FilePath $cer | Out-Null
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($admin) {
      Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
    } else {
      Write-Warning "dev cert not trusted yet; run once in an elevated PowerShell:`n  Import-Certificate -FilePath '$cer' -CertStoreLocation Cert:\LocalMachine\TrustedPeople"
    }
  }
  & (Find-SdkTool 'signtool.exe') sign /fd SHA256 /sha1 $cert.Thumbprint $msix
  if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }
} elseif ($CertPath) {
  $signArgs = @('sign', '/fd', 'SHA256', '/f', $CertPath)
  if ($CertPassword) { $signArgs += @('/p', $CertPassword) }
  & (Find-SdkTool 'signtool.exe') @signArgs $msix
  if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }
}

"packed $msix ($Version)"
