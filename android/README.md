# BasicDAW for Android

An APK for Android 10+ phones and tablets (64-bit ARM; x86_64 for emulators). The app runs the shared
`server.py` on the device with [Chaquopy](https://chaquo.com/chaquopy/)'s Python and shows the shared `web/`
DAW full screen in a WebView, so it is the same app as on the desktop.

## Install

Copy `dist/BasicDAW-<version>.apk` to the device and open it (allow *Install unknown apps* for the file
manager or browser you open it from), or with USB debugging on: `adb install -r dist/BasicDAW-<version>.apk`.

* Projects and downloaded instruments stay in the app's own storage (removed when the app is uninstalled).
* Exports (WAV, FLAC, MP3, OGG, Opus, M4A, MIDI, project files) are saved to **Download/BasicDAW**.
  There is no ffmpeg program on Android, so the app encodes them itself with ffmpeg.wasm.
* *Import* opens the system file picker; instruments download over the internet the first time they are used.
* The app runs in landscape. On phones the DAW is laid out at tablet width and scaled to fit; it is most
  comfortable on a tablet. Back closes open menus and dialogs; unsaved changes are saved when you leave the app.

## Build (Linux)

```sh
android/build.sh          # -> dist/BasicDAW-<version>.apk (signed release)
android/build.sh --debug  # -> dist/BasicDAW-<version>-debug.apk (inspect the WebView from chrome://inspect)
```

The first build downloads a JDK 21, the Android SDK (command-line tools, platform 35, build tools) and Gradle
into `android/.tools` (about 1.5 GB) unless `JAVA_HOME` / `ANDROID_HOME` already point at them, and asks you
to accept the Android SDK licenses (`--accept-android-licenses` accepts them without the prompt).

It also creates the signing key in **`android/signing/`** - back that folder up: Android only installs an
update over an existing install when it is signed with the same key.

| File | What |
|---|---|
| `app/build.gradle` | the app; copies `../server.py` and `../web` and fetches ffmpeg.wasm (npm) at build time |
| `app/src/main/java/com/basicdaw/app/MainActivity.java` | starts the server, the WebView, file picker, back button, full screen |
| `app/src/main/java/com/basicdaw/app/Downloads.java` | saves exports to Download/BasicDAW |
| `app/src/main/python/basicdaw_android.py` | starts `server.py` with the app's folders |

## Not on Android

MIDI devices (no python-rtmidi on Android) and the Midinous link. The on-screen piano roll, the
instruments and every export format work.
