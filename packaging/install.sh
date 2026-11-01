#!/usr/bin/env bash
# Install the AppImage from ./build.sh for this user: "BasicDAW" in the app menu and a `basicdaw`
# command. The first time, projects and downloaded instruments from this folder are copied to the
# app's data folder (~/.local/share/basicdaw).
#   packaging/install.sh               install or update
#   packaging/install.sh --uninstall   remove the app (projects and instruments are kept)
set -euo pipefail
cd "$(dirname "$0")/.."
DATA=${XDG_DATA_HOME:-$HOME/.local/share}
BIN=$HOME/.local/bin/basicdaw
DESKTOP=$DATA/applications/basicdaw.desktop
ICON=$DATA/icons/hicolor/512x512/apps/basicdaw.png

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$BIN" "$DESKTOP" "$ICON"
  echo "Removed BasicDAW. Projects and instruments are still in $DATA/basicdaw"
  exit 0
fi

IMG=dist/BasicDAW-$(uname -m).AppImage
[[ -f "$IMG" ]] || { echo "No $IMG - run ./build.sh first" >&2; exit 1; }

# The app used to be called Nebula DAW: replace that install and keep its projects and instruments.
rm -f "$HOME/.local/bin/nebula-daw" "$DATA/applications/nebula-daw.desktop" "$DATA/icons/hicolor/512x512/apps/nebula-daw.png"
if [[ -d "$DATA/nebula-daw" && ! -e "$DATA/basicdaw" ]]; then
  mv "$DATA/nebula-daw" "$DATA/basicdaw"
  echo "Moved $DATA/nebula-daw (projects, instruments) to $DATA/basicdaw"
fi
[[ -d "$DATA/Nebula" ]] && find "$DATA/Nebula" -depth -type d -empty -delete  # Qt's empty profile folders
install -Dm755 "$IMG" "$BIN"
install -Dm644 packaging/basicdaw.png "$ICON"
mkdir -p "$(dirname "$DESKTOP")"
sed "s|^Exec=.*|Exec=$BIN|" packaging/basicdaw.desktop >"$DESKTOP"
update-desktop-database -q "$DATA/applications" 2>/dev/null || true

for d in projects cache; do
  if [[ -d "$d" && ! -e "$DATA/basicdaw/$d" ]]; then
    mkdir -p "$DATA/basicdaw"
    cp -a "$d" "$DATA/basicdaw/$d"
    echo "Copied ./$d to $DATA/basicdaw/$d"
  fi
done
echo "Installed $BIN - start it from the app menu (BasicDAW) or with: basicdaw"
