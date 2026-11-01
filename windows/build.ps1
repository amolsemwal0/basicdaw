# Build the Windows app on Windows: PyInstaller app folder, ffmpeg, then an Inno Setup installer.
#   powershell -ExecutionPolicy Bypass -File windows\build.ps1
#     -> windows\dist\BasicDAW-<version>-Setup.exe   (the installer; needs Inno Setup 6, e.g. winget install JRSoftware.InnoSetup)
#     -> windows\dist\BasicDAW-<version>-windows.zip  (portable, unzip and run)
# Needs Python 3.12 (the py launcher) - python-rtmidi has Windows wheels up to 3.12. Downloads stay in windows\.tools.
# On Linux, use build-on-linux.sh (Wine) instead.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$FfmpegUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip'
$Version = (Select-String -Path ..\pyproject.toml -Pattern '^version = "(.*)"').Matches[0].Groups[1].Value
$Tools = Join-Path $PSScriptRoot '.tools'
New-Item -ItemType Directory -Force $Tools | Out-Null

$Venv = Join-Path $Tools 'venv'
if (-not (Test-Path "$Venv\Scripts\python.exe")) {
  Write-Host 'creating the build environment (Python 3.12)'
  py -3.12 -m venv $Venv
}
$Py = "$Venv\Scripts\python.exe"
& $Py -m pip install --quiet --disable-pip-version-check -r requirements.txt

$Ffmpeg = Join-Path $Tools 'ffmpeg'
if (-not (Test-Path "$Ffmpeg\ffmpeg.exe")) {
  Write-Host 'downloading ffmpeg'
  $Zip = Join-Path $Tools 'ffmpeg.zip'
  Invoke-WebRequest $FfmpegUrl -OutFile $Zip
  $Unpacked = Join-Path $Tools 'ffmpeg-unpacked'
  Expand-Archive $Zip $Unpacked -Force
  New-Item -ItemType Directory -Force $Ffmpeg | Out-Null
  $Bin = Get-ChildItem $Unpacked -Directory | Select-Object -First 1
  Copy-Item "$($Bin.FullName)\bin\ffmpeg.exe", "$($Bin.FullName)\bin\*.dll" $Ffmpeg
  Copy-Item "$($Bin.FullName)\LICENSE.txt" $Ffmpeg -ErrorAction SilentlyContinue
  Remove-Item $Unpacked -Recurse -Force
}

Write-Host 'building the app folder (PyInstaller)'
& $Py -m PyInstaller --noconfirm --clean --log-level WARN --distpath dist --workpath "$Tools\pyinstaller" basicdaw.spec
if ($LASTEXITCODE) { throw 'PyInstaller failed' }

$Zip = "dist\BasicDAW-$Version-windows.zip"
Remove-Item $Zip -ErrorAction SilentlyContinue
Compress-Archive dist\BasicDAW $Zip
Write-Host "portable:  windows\$Zip"

$Iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
          "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($Iscc) {
  & $Iscc /Q "/DAppVersion=$Version" installer.iss
  if ($LASTEXITCODE) { throw 'Inno Setup failed' }
  Write-Host "installer: windows\dist\BasicDAW-$Version-Setup.exe"
} else {
  Write-Host 'Inno Setup 6 not found - install it (winget install JRSoftware.InnoSetup) to build the installer'
}
