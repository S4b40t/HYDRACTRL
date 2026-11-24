#Requires -Version 7.4
param(
  [string]$SdkDir,
  [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$DesktopDir = Split-Path $PSScriptRoot
$Repo = Split-Path $DesktopDir
$Stage = Join-Path $DesktopDir '.link-experiment-staging'
$SdkRevision = '5ba907ae027a8c2ec8824463e37296dcefc5e9be'
$AsioRevision = '8806a6803cde7054c3049d3666d3ec36786568c5'

if (!$IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'The Portable release build requires Windows x64 with Visual Studio 2022.'
}
if (!$SkipZip -and (git -C $Repo status --porcelain --untracked-files=no)) {
  throw 'Commit the exact app source before assembling a ZIP with corresponding source.'
}

New-Item -ItemType Directory -Path $Stage -Force | Out-Null
if (!$SdkDir) {
  $SdkDir = Join-Path $Stage 'ableton-link'
  if (!(Test-Path (Join-Path $SdkDir '.git'))) {
    git clone --recurse-submodules --branch Link-4.1.1 https://github.com/Ableton/link.git $SdkDir
  }
}
$SdkDir = (Resolve-Path $SdkDir).Path
$AsioDir = Join-Path $SdkDir 'modules/asio-standalone'
if ((git -C $SdkDir rev-parse HEAD) -ne $SdkRevision -or (git -C $AsioDir rev-parse HEAD) -ne $AsioRevision) {
  throw 'The Ableton Link and standalone Asio revisions must match the pinned commits.'
}
if ((git -C $SdkDir status --porcelain) -or (git -C $AsioDir status --porcelain)) {
  throw 'Use clean Link and Asio source checkouts.'
}

$NativeDir = Join-Path $Stage 'native'
cmake -S (Join-Path $DesktopDir 'link-prototype') -B $NativeDir -G 'Visual Studio 17 2022' -A x64 "-DABLETON_LINK_DIR=$SdkDir" '-DHYDRACTRL_LINK_TEST_PEER=ON'
cmake --build $NativeDir --config Release --parallel
$Resources = Join-Path $Stage 'resources'
$LinkDir = Join-Path $Resources 'link'
New-Item -ItemType Directory -Path $LinkDir -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $Resources 'link-experiment') -Force | Out-Null
Copy-Item (Join-Path $NativeDir 'Release/hydractrl-link.exe') $LinkDir -Force

Push-Location $DesktopDir
try {
  $Version = (Get-Content package.json -Raw | ConvertFrom-Json).version.Split('-')[0] + '-link.2'
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  bunx electron-builder --config electron-builder.link.yml --win --x64 --dir --publish never "-c.extraMetadata.version=$Version"
} finally { Pop-Location }

$App = Join-Path $Stage 'app/win-unpacked'
if (!(Test-Path (Join-Path $App 'HYDRACTRL Link Experimental.exe')) -or
    !(Test-Path (Join-Path $App 'resources/link/hydractrl-link.exe')) -or
    !(Test-Path (Join-Path $App 'resources/link-experiment'))) {
  throw 'The unpacked app is missing its executable, Link helper, or isolated profile marker.'
}
if ($SkipZip) { return }

$Revision = git -C $Repo rev-parse HEAD
$Name = "HYDRACTRL-$Version-win-x64-Portable-$($Revision.Substring(0, 8))"
$Output = Join-Path $DesktopDir "dist/$Name"
if ((Test-Path $Output) -or (Test-Path "$Output.zip")) {
  throw "Output already exists at $Output. Move the previous build before creating another."
}
$Peer = Join-Path $Output 'Link Test Peer'
$Notices = Join-Path $Output 'Licenses'
$Source = Join-Path $Output 'Source'
New-Item -ItemType Directory -Path $Peer,$Notices,$Source | Out-Null
Copy-Item $App (Join-Path $Output 'HYDRACTRL') -Recurse
Copy-Item (Join-Path $NativeDir 'Release/LinkTestPeer.exe') $Peer
Copy-Item (Join-Path $Repo 'docs/LINK_WINDOWS_TEST.md') (Join-Path $Output 'START HERE.txt')
Copy-Item (Join-Path $Repo 'docs/ABLETON_LINK_PHASE_2.md') $Source
Copy-Item (Join-Path $Repo 'LICENSE') (Join-Path $Notices 'HYDRACTRL-AGPL-3.0.txt')
Copy-Item (Join-Path $DesktopDir 'link-prototype/GPL-3.0.txt') (Join-Path $Notices 'GPL-3.0.txt')
Copy-Item (Join-Path $SdkDir 'LICENSE.md') (Join-Path $Notices 'Ableton-Link-LICENSE.md')
Copy-Item (Join-Path $AsioDir 'LICENSE_1_0.txt') (Join-Path $Notices 'Asio-BSL-1.0.txt')
node (Join-Path $PSScriptRoot 'link-portable-notices.mjs') $Output
git -C $Repo archive --format=zip "--output=$(Join-Path $Source 'HYDRACTRL-source.zip')" $Revision
git -C $SdkDir archive --format=zip "--output=$(Join-Path $Source 'Ableton-Link-source.zip')" $SdkRevision
git -C $AsioDir archive --format=zip "--output=$(Join-Path $Source 'Asio-source.zip')" $AsioRevision
$BunVersion = bun --version
Invoke-WebRequest "https://raw.githubusercontent.com/oven-sh/bun/bun-v$BunVersion/LICENSE.md" -OutFile (Join-Path $Notices 'Bun-LICENSE.md')
@"
HYDRACTRL $Revision  https://github.com/S4b40t/HYDRACTRL/tree/$Revision
Ableton Link $SdkRevision  https://github.com/Ableton/link/tree/$SdkRevision
Asio $AsioRevision  https://github.com/chriskohlhoff/asio/tree/$AsioRevision
Bun $BunVersion  https://github.com/oven-sh/bun/tree/bun-v$BunVersion
Electron 45.0.0  https://github.com/electron/electron/tree/v45.0.0
See ABLETON_LINK_PHASE_2.md for build and redistribution details.
"@ | Set-Content (Join-Path $Source 'Build versions.txt')
[System.IO.Compression.ZipFile]::CreateFromDirectory($Output, "$Output.zip")
Write-Host "Local validation ZIP: $Output.zip"
