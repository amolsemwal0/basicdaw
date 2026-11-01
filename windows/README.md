# BasicDAW for Windows

The desktop app (the shared `server.py` + `web/` in its own Qt WebEngine window, `desktop.py`) packaged for
Windows 10 / 11 (64-bit), with ffmpeg bundled so every export format works out of the box.

## Install

Run `dist/BasicDAW-<version>-Setup.exe`. It installs for your user without admin rights (or for all users
in Program Files, if you choose that), adds BasicDAW to the Start menu (optionally the desktop) and an
uninstaller. Windows SmartScreen may warn because the installer isn't code-signed: *More info -> Run anyway*.

No installer wanted? Unzip `dist/BasicDAW-<version>-windows.zip` anywhere and run `BasicDAW.exe`.

Projects and downloaded instruments are kept in `%APPDATA%\BasicDAW`, so updating or uninstalling the app
keeps them. The app's log is `%APPDATA%\BasicDAW\basicdaw.log`.

## Build

| On | Run | Needs |
|---|---|---|
| Linux | `windows/build-on-linux.sh` | Wine, curl, unzip, 7z |
| Windows | `powershell -ExecutionPolicy Bypass -File windows\build.ps1` | Python 3.12 (`py` launcher), [Inno Setup 6](https://jrsoftware.org/isinfo.php) for the installer |

Both make `dist/BasicDAW/` (the app folder), the portable zip and the installer. Everything they download -
a Windows Python (from NuGet, under Wine), PyQt6, PyInstaller, ffmpeg (BtbN's LGPL build), Inno Setup - stays
in `windows/.tools` (about 1.5 GB; delete it to start clean). The version comes from `../pyproject.toml`.

| File | What |
|---|---|
| `basicdaw.spec` | PyInstaller: `desktop.py` + `web/` + ffmpeg -> `dist/BasicDAW/BasicDAW.exe` |
| `installer.iss` | Inno Setup script for the installer |
| `requirements.txt` | what the build installs into its Python |
| `basicdaw.ico` | the app icon |

## Differences from Linux

* **MIDI**: hardware ports and other apps' ports work. Windows has no virtual MIDI ports, so to connect
  another app (e.g. Midinous) create a loopback port with [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html).
* **Midinous documents** (import / Send to Midinous) need MidinousMCP, which is set up on Linux only.
