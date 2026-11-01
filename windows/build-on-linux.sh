#!/usr/bin/env bash
# Build the Windows app on Linux with Wine: Windows Python + PyInstaller, ffmpeg, then an Inno Setup installer.
#   windows/build-on-linux.sh   ->  windows/dist/BasicDAW-<version>-Setup.exe   (the installer)
#                                   windows/dist/BasicDAW-<version>-windows.zip  (portable, unzip and run)
# Everything it downloads (Wine prefix, Python, ffmpeg, Inno Setup) stays in windows/.tools.
# On Windows itself, use build.ps1 instead.
set -euo pipefail
cd "$(dirname "$0")"
command -v wine >/dev/null 2>&1 || { echo "build-on-linux.sh needs Wine" >&2; exit 1; }

PY_VERSION=3.12.10   # python-rtmidi has Windows wheels up to 3.12
INNO_URL=https://github.com/jrsoftware/issrc/releases/download/is-6_7_4/innosetup-6.7.4.exe
FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' ../pyproject.toml)

TOOLS=$PWD/.tools
export WINEPREFIX=$TOOLS/wine WINEARCH=win64 WINEDEBUG=-all WINEDLLOVERRIDES="mscoree,mshtml="
mkdir -p "$TOOLS"
fetch() { [[ -f "$2" ]] || { echo "downloading $(basename "$2")"; curl -fL --progress-bar -o "$2.part" "$1" && mv "$2.part" "$2"; }; }

if [[ ! -d "$WINEPREFIX/drive_c" ]]; then
  echo "creating the Wine prefix"
  wineboot --init >/dev/null 2>&1
  wineserver -w
fi

# Python from NuGet: a plain zip of a full Windows Python, no installer needed.
PY=$TOOLS/python/tools/python.exe
if [[ ! -f "$PY" ]]; then
  fetch "https://www.nuget.org/api/v2/package/python/$PY_VERSION" "$TOOLS/python.nupkg"
  unzip -q -o "$TOOLS/python.nupkg" -d "$TOOLS/python"
fi
wine "$PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
echo "installing PyQt6, PyInstaller... into the Windows Python"
wine "$PY" -m pip install --quiet --disable-pip-version-check -r requirements.txt

# ffmpeg.exe and its DLLs (for FLAC / MP3 / OGG / Opus / M4A exports)
if [[ ! -f "$TOOLS/ffmpeg/ffmpeg.exe" ]]; then
  fetch "$FFMPEG_URL" "$TOOLS/ffmpeg.zip"
  rm -rf "$TOOLS/ffmpeg-unpacked" "$TOOLS/ffmpeg"
  unzip -q "$TOOLS/ffmpeg.zip" -d "$TOOLS/ffmpeg-unpacked"
  mkdir -p "$TOOLS/ffmpeg"
  cp "$TOOLS"/ffmpeg-unpacked/*/bin/ffmpeg.exe "$TOOLS"/ffmpeg-unpacked/*/bin/*.dll "$TOOLS/ffmpeg/"
  cp "$TOOLS"/ffmpeg-unpacked/*/LICENSE.txt "$TOOLS/ffmpeg/LICENSE.txt" 2>/dev/null || true
  rm -rf "$TOOLS/ffmpeg-unpacked"
fi

echo "building the app folder (PyInstaller)"
wine "$PY" -m PyInstaller --noconfirm --clean --log-level WARN \
  --distpath dist --workpath "$TOOLS/pyinstaller" basicdaw.spec

ISCC=$WINEPREFIX/drive_c/InnoSetup/ISCC.exe
if [[ ! -f "$ISCC" ]]; then
  fetch "$INNO_URL" "$TOOLS/innosetup.exe"
  wine "$TOOLS/innosetup.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER '/DIR=C:\InnoSetup' >/dev/null 2>&1
  wineserver -w
fi
echo "building the installer (Inno Setup)"
wine "$ISCC" /Q "/DAppVersion=$VERSION" installer.iss

rm -f "dist/BasicDAW-$VERSION-windows.zip"
(cd dist && 7z a -tzip -mx=7 -bso0 -bsp0 "BasicDAW-$VERSION-windows.zip" BasicDAW)
echo "installer: windows/dist/BasicDAW-$VERSION-Setup.exe"
echo "portable:  windows/dist/BasicDAW-$VERSION-windows.zip"
