#!/usr/bin/env bash
# Package BasicDAW as a standalone desktop app (no browser, no Python needed on the target system).
#   ./build.sh                 dist/basicdaw/ (app folder) + dist/BasicDAW-<arch>.AppImage (one file)
#   ./build.sh --no-appimage   only the app folder
#   packaging/install.sh       add the AppImage to your app menu and PATH
set -euo pipefail
cd "$(dirname "$0")"
command -v uv >/dev/null 2>&1 || { echo "build.sh needs uv (https://docs.astral.sh/uv/)" >&2; exit 1; }

# uv's own Python (not the system one) keeps the result portable to older distros;
# 3.12 because python-rtmidi ships binary wheels up to 3.12.
export UV_PROJECT_ENVIRONMENT=build/venv
uv sync --quiet --managed-python --python 3.12 --group desktop --group build
build/venv/bin/pyinstaller --noconfirm --clean --log-level WARN \
  --distpath dist --workpath build/pyinstaller packaging/basicdaw.spec
echo "app folder: dist/basicdaw/ (run dist/basicdaw/basicdaw)"

[[ "${1:-}" == "--no-appimage" || "$(uname -s)" != Linux ]] && exit 0

ARCH=$(uname -m)
APPDIR=build/AppDir
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/lib" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/512x512/apps"
cp -a dist/basicdaw "$APPDIR/usr/lib/basicdaw"
cp packaging/AppRun "$APPDIR/AppRun"
cp packaging/basicdaw.desktop "$APPDIR/" && cp packaging/basicdaw.desktop "$APPDIR/usr/share/applications/"
cp packaging/basicdaw.png "$APPDIR/" && cp packaging/basicdaw.png "$APPDIR/usr/share/icons/hicolor/512x512/apps/"
ln -s basicdaw.png "$APPDIR/.DirIcon"

TOOL=build/tools/appimagetool-$ARCH.AppImage
if [[ ! -x "$TOOL" ]]; then
  mkdir -p build/tools
  curl -fL --progress-bar -o "$TOOL" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$ARCH.AppImage"
  chmod +x "$TOOL"
fi
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=$ARCH "$TOOL" --no-appstream "$APPDIR" "dist/BasicDAW-$ARCH.AppImage" \
  >build/appimagetool.log 2>&1 || { cat build/appimagetool.log >&2; exit 1; }
echo "AppImage:   dist/BasicDAW-$ARCH.AppImage"
