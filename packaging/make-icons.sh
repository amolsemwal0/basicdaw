#!/usr/bin/env bash
# Render every icon file from packaging/basicdaw-icon.svg (edit that one, in Inkscape or by hand; its text
# uses Noto Sans Black). Needs Inkscape and ffmpeg.
#   web/img/logo.svg                         the app's logo and favicon (text turned into outlines)
#   packaging/basicdaw.png                   Linux app icon (512 px)
#   windows/basicdaw.ico                     Windows exe / installer icon (16-256 px)
#   android/app/src/main/res/mipmap-*/       Android adaptive icon foreground (dark background in colors.xml)
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

inkscape packaging/basicdaw-icon.svg --export-text-to-path --export-plain-svg --export-filename=web/img/logo.svg 2>/dev/null
render() { inkscape web/img/logo.svg --export-type=png --export-width="$1" --export-filename="$2" 2>/dev/null; }

render 512 packaging/basicdaw.png

ICO_SIZES=(16 24 32 48 64 128 256)
for n in "${ICO_SIZES[@]}"; do render "$n" "$TMP/$n.png"; done
python3 - "$TMP" windows/basicdaw.ico "${ICO_SIZES[@]}" <<'PY'
import struct, sys
from pathlib import Path
src, out, sizes = Path(sys.argv[1]), Path(sys.argv[2]), [int(n) for n in sys.argv[3:]]
pngs = [(src / f"{n}.png").read_bytes() for n in sizes]
entries, offset = b"", 6 + 16 * len(sizes)
for n, data in zip(sizes, pngs):  # PNG-compressed entries, as Windows Vista and later read them
    entries += struct.pack("<BBBBHHII", n % 256, n % 256, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
out.write_bytes(struct.pack("<HHH", 0, 1, len(sizes)) + entries + b"".join(pngs))
PY

# Adaptive icon: 108 dp canvas, the disc inside the 66 dp safe zone that every launcher mask keeps.
for d in mdpi:108 hdpi:162 xhdpi:216 xxhdpi:324 xxxhdpi:432; do
  size=${d##*:}
  disc=$(( size * 64 / 100 ))
  render "$disc" "$TMP/disc.png"
  ffmpeg -hide_banner -v error -y -i "$TMP/disc.png" \
    -vf "format=rgba,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=black@0" \
    "android/app/src/main/res/mipmap-${d%%:*}/ic_launcher_foreground.png"
done
echo "icons rendered from packaging/basicdaw-icon.svg"
