# BasicDAW

A digital audio workstation with online instruments and a live link to
[Midinous](https://midinous.com). It runs as a desktop app or in your browser.

* **Tracks per instrument** - 128 General MIDI instruments in three soundfonts (FluidR3, Musyng Kite,
  FatBoy), 16 drum kits, 14 built-in synths that work offline, and audio tracks.
* **Piano roll** - draw notes and drag their length, select / move / resize / duplicate, velocity lane,
  snap and triplet grids, scale highlighting, ghost notes, quantize, undo / redo.
* **Looping tracks** - the loop button on a track repeats its notes until the song ends, e.g. a
  one-bar drum beat under a longer piano part.
* **Drag & drop** - drop a `.mid` song, audio file (`.wav .mp3 .ogg .flac .m4a`), BasicDAW project or
  Midinous document anywhere on the window.
* **Projects** - create, open, save, save as, rename, duplicate and delete from the Projects menu.
  Deleted projects go to `projects/.trash`.
* **Midinous** - hear and record Midinous live, sync transport either way, import its documents
  and MIDI exports, and send a project back to Midinous as a document.
* **Export** (Ctrl+E) - mixdown as WAV (16 / 24-bit, 32-bit float), FLAC, MP3, OGG Vorbis, Opus or M4A (AAC),
  standard MIDI file, project file. WAV is written in the browser; the other formats use the system's `ffmpeg`
  (set `BASICDAW_FFMPEG` to use another binary).

## Start

```fish
basicdaw          # the installed desktop app (or "BasicDAW" in the app menu)

cd ~/GameDev/Music/Projects/basicdaw
./desktop.sh        # desktop app, from source
./run.sh            # in the browser: opens http://localhost:8765
```

`run.sh` uses `uv` to install `python-rtmidi` (the ALSA MIDI bridge) into `.venv` on the first run.
Options: `./run.sh --port 9000`, `./run.sh --no-browser`.

Instruments are downloaded the first time they are used and cached in `cache/`, so they work offline
afterwards. Projects live in `projects/<id>/project.json` (audio files in `projects/<id>/audio/`).

## Desktop app

The desktop app is the same DAW in its own window: the server runs inside the app and the UI is
shown with Qt WebEngine (Chromium), so it behaves exactly as in Chrome. Exports open a save dialog,
closing the window asks to save unsaved changes, `F11` toggles full screen, `Ctrl+Q` quits, and
starting it a second time brings the open window to the front.

```fish
./build.sh              # -> dist/BasicDAW-x86_64.AppImage (one file) and dist/basicdaw/ (folder)
packaging/install.sh    # app menu entry + ~/.local/bin/basicdaw (--uninstall removes them)
```

The AppImage needs no Python or browser on the target machine. It runs on Linux with glibc 2.34
or newer (Ubuntu 22.04+, Debian 12+, Fedora 35+, Arch) and uses the system's graphics, audio and
NSS libraries, as any Qt WebEngine app does (tested on Arch and Ubuntu 22.04). In an X11 session
(not Wayland) Qt 6 also needs the xcb-util libraries - on Ubuntu / Debian:
`sudo apt install libxcb-cursor0 libxcb-icccm4 libxcb-keysyms1 libxcb-render-util0 libxkbcommon-x11-0`.
`build.sh` uses uv's own Python 3.12, PyInstaller and
[appimagetool](https://github.com/AppImage/appimagetool) (downloaded into `build/tools` once).
For macOS, run `uv run --group desktop --group build pyinstaller packaging/basicdaw.spec` on a Mac.
The icon (a disc with BASICDAW around it) is drawn in `packaging/basicdaw-icon.svg`;
`packaging/make-icons.sh` (Inkscape + ffmpeg) renders the logo, the Linux, Windows and Android icons from it.

The packaged app keeps projects and downloaded instruments in `~/.local/share/basicdaw`
(`install.sh` copies this folder's `projects/` and `cache/` there the first time). Run from source,
it uses this folder like `./run.sh`. `basicdaw --browser` runs only the server and opens your
browser instead of the window.

## Windows and Android

Each has its own folder with its build scripts, platform code and finished installer; both run this
same `server.py` and `web/`, so features stay in step:

* [`windows/`](windows/README.md) - `Setup.exe` installer (and a portable zip) of the desktop app, with
  ffmpeg bundled. Built on Windows (`build.ps1`) or on Linux with Wine (`build-on-linux.sh`).
* [`android/`](android/README.md) - an APK for phones and tablets (Android 10+): the server runs on the
  device and the DAW is shown full screen; exports are encoded in the app and saved to `Download/BasicDAW`.

## Using it

| Action | How |
|---|---|
| Play / pause, stop, back to start | `Space`, `Enter`, `Home` |
| Draw / select / erase tool | `1` `2` `3` (or `D` `V` `E`) |
| Draw a note | click in the piano roll; drag right while clicking to set the length |
| Delete a note | right-click it, double-click it, or select and press `Delete` |
| Move without snapping | hold `Alt` while dragging |
| Copy a note while moving | `Ctrl`+drag |
| Copy / paste / duplicate | `Ctrl+C` / `Ctrl+V` (at the playhead) / `Ctrl+D` |
| Transpose / nudge | arrow keys (`Shift` = octave) |
| Zoom | `Ctrl`+wheel, `+` / `-`; `Alt`+wheel changes row height |
| Loop region | drag on the arranger ruler; `L` toggles the loop |
| Loop a track | the loop button in its header (or Track tab): its bars repeat until the last non-looping track ends; recording on it adds to the loop |
| Record | arm tracks, press `R`, then `Space` |
| Computer keyboard piano | `K` to turn on, `Esc` to turn off; `A W S E D F T G Y H U J K`, `Z`/`X` octave |
| Projects | `Ctrl+O` browse, `Ctrl+S` save, `Ctrl+Shift+S` save as |
| Mute / solo selected track, metronome | `M`, `S`, `C` |

Drag a sound from the **Sounds** tab onto the arranger to make a new track with it, or click it to
change the selected track's sound.

## Midinous

BasicDAW listens to Midinous' virtual ALSA ports (`Midinous Port`, `Midinous Clock Port`) as soon as
Midinous is running. In the **Midinous** tab:

* **Where Midinous notes go** - *one track per channel* creates (or reuses) a track for every
  Midinous channel, choosing its sound from the instruments MidinousMCP assigned; *armed / selected
  track* plays everything on the armed track.
* **Transport sync** - *BasicDAW leads* sends Start / Stop and MIDI clock to Midinous (set the
  document's clock source to External); *Midinous leads* starts, stops and records BasicDAW when
  Midinous does and follows its tempo.
* **Import** - documents, presets and autosaves are played by the Midinous engine from
  MidinousMCP for the number of seconds you choose; MIDI exports are imported directly.
* **Send to Midinous** - writes the project as a Midinous document in
  `~/.local/share/Midinous/user/save` (open it in Midinous with `Ctrl+O`). Each track gets its own
  MIDI channel and is linked to it, so Midinous can play straight back into the same tracks.

Document import/export needs MidinousMCP at `~/Software/MCP/MidinousMCP` (override with
`MIDINOUS_MCP_SRC`). Live MIDI works without it.

Other apps can also connect to the virtual ports `BasicDAW In` and `BasicDAW Out`, and every
track can send its notes to any MIDI output (Track tab → Routing).

## Environment variables

| Variable | Default |
|---|---|
| `BASICDAW_PORT` | `8765` |
| `BASICDAW_DESKTOP_PORT` | `8790` (the desktop app's local server) |
| `BASICDAW_PROJECTS_DIR` | `./projects` (packaged app: `~/.local/share/basicdaw/projects`) |
| `BASICDAW_CACHE_DIR` | `./cache` (packaged app: `~/.local/share/basicdaw/cache`) |
| `MIDINOUS_MCP_SRC` | `~/Software/MCP/MidinousMCP/src` |
| `MIDINOUS_USER_DIR` | `~/.local/share/Midinous` |

## Instrument sources

* General MIDI soundfonts: [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts)
* GM drum kits: [surikov/webaudiofontdata](https://github.com/surikov/webaudiofontdata)
* Drum machines: [Tone.js audio samples](https://github.com/Tonejs/audio)
