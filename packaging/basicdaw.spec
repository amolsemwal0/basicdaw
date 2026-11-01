# PyInstaller spec for the BasicDAW desktop app - ../build.sh runs it.
from pathlib import Path

ROOT = Path(SPECPATH).parent

# MidinousMCP is imported from its own folder at run time, so the standard-library modules it
# needs have to be bundled even though BasicDAW itself never imports them.
MIDINOUS_STDLIB = [
    "copy", "dataclasses", "datetime", "heapq", "json", "math", "random", "re", "typing",
    "bisect", "colorsys", "contextlib", "enum", "fnmatch", "fractions", "functools", "glob",
    "hashlib", "itertools", "statistics", "string", "struct", "tempfile", "textwrap", "wave",
]

# Only what Python and the wheels bring is bundled. Libraries from this machine's /usr/lib (graphics,
# audio, X11 / Wayland, fonts, NSS...) come from the host, as for an installed PyQt6: copies would tie
# the app to the build distro's glibc and break GPU drivers and ALSA / PipeWire elsewhere.
SYSTEM_DIRS = ("/usr/", "/lib/", "/lib64/")

a = Analysis(
    [str(ROOT / "desktop.py")],
    pathex=[str(ROOT)],
    datas=[(str(ROOT / "web"), "web")],
    hiddenimports=MIDINOUS_STDLIB,
    # QtWebEngine links Qt Quick, but a widgets window never loads QML; without these excludes the
    # hooks bundle every QML module (Quick 3D, Multimedia, Sensors...) and their libraries.
    excludes=["tkinter", "unittest", "pydoc",
              "PyQt6.QtQml", "PyQt6.QtQuick", "PyQt6.QtQuickWidgets", "PyQt6.QtWebEngineQuick"],
)
a.binaries = [b for b in a.binaries if not b[1].startswith(SYSTEM_DIRS)]
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="basicdaw",
    console=False,
    upx=False,  # UPX breaks the Qt libraries
)
coll = COLLECT(exe, a.binaries, a.datas, name="basicdaw", upx=False)
