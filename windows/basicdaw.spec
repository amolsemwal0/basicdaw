# PyInstaller spec for the Windows app - build-on-linux.sh (Wine) and build.ps1 (on Windows) run it.
import tomllib
from pathlib import Path

from PyInstaller.utils.win32.versioninfo import (FixedFileInfo, StringFileInfo, StringStruct, StringTable,
                                                  VarFileInfo, VarStruct, VSVersionInfo)

HERE = Path(SPECPATH)
ROOT = HERE.parent
VERSION = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["version"]
FFMPEG = HERE / ".tools" / "ffmpeg"  # ffmpeg.exe and its DLLs, fetched by the build scripts

# MidinousMCP is imported from its own folder at run time, so the standard-library modules it
# needs have to be bundled even though BasicDAW itself never imports them (as in packaging/basicdaw.spec).
MIDINOUS_STDLIB = [
    "copy", "dataclasses", "datetime", "heapq", "json", "math", "random", "re", "typing",
    "bisect", "colorsys", "contextlib", "enum", "fnmatch", "fractions", "functools", "glob",
    "hashlib", "itertools", "statistics", "string", "struct", "tempfile", "textwrap", "wave",
]

a = Analysis(
    [str(ROOT / "desktop.py")],
    pathex=[str(ROOT)],
    # ffmpeg goes in as data: it is a program server.py starts, not a library to scan for dependencies.
    datas=[(str(ROOT / "web"), "web"), (str(FFMPEG), "ffmpeg")],
    hiddenimports=MIDINOUS_STDLIB,
    # A widgets window never loads QML; without these the hooks bundle every QML module.
    excludes=["tkinter", "unittest", "pydoc",
              "PyQt6.QtQml", "PyQt6.QtQuick", "PyQt6.QtQuickWidgets", "PyQt6.QtWebEngineQuick"],
)
pyz = PYZ(a.pure)

numbers = (*(int(n) for n in VERSION.split(".")), 0)
strings = {"CompanyName": "BasicDAW", "FileDescription": "BasicDAW", "FileVersion": VERSION,
           "InternalName": "BasicDAW", "OriginalFilename": "BasicDAW.exe", "ProductName": "BasicDAW",
           "ProductVersion": VERSION}
version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=numbers, prodvers=numbers),
    kids=[StringFileInfo([StringTable("040904B0", [StringStruct(k, v) for k, v in strings.items()])]),
          VarFileInfo([VarStruct("Translation", [1033, 1200])])],
)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="BasicDAW",
    console=False,
    icon=str(HERE / "basicdaw.ico"),
    version=version_info,
    upx=False,  # UPX breaks the Qt libraries
)
coll = COLLECT(exe, a.binaries, a.datas, name="BasicDAW", upx=False)
