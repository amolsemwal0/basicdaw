#!/usr/bin/env python3
"""BasicDAW as a desktop app.

The server from server.py runs inside this process and the UI is shown in its own window
(Qt WebEngine, i.e. Chromium) instead of a browser tab. ./desktop.sh runs it from source,
./build.sh packages it as a standalone executable.

    basicdaw [--port N]     open the window (a second launch raises the running one)
    basicdaw --browser ...  run only the server and use a browser, like ./run.sh
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
from pathlib import Path

import server

APP_ID = "basicdaw"
DEFAULT_PORT = 8790  # fixed so the page's origin (and its saved preferences) stays the same
CLOSE_TAG = "basicdaw-desktop:close:"
# Ask the page's own "Save changes?" dialog; the answer comes back as a console message.
ASK_CLOSE_JS = f"""(() => {{
  const ask = window.basicdaw && window.basicdaw.confirmLeave;
  if (typeof ask !== 'function') return false;
  ask().then((ok) => console.info('{CLOSE_TAG}' + (ok ? 'yes' : 'no')),
             () => console.info('{CLOSE_TAG}error'));
  return true;
}})()"""


def start_server(port: int) -> str:
    """Start the HTTP server on a background thread and return its URL."""
    server.APP = server.App()
    try:
        httpd = server.Server(("127.0.0.1", port), server.Handler)
    except OSError:  # taken (e.g. by ./run.sh --port): any free port works, preferences start fresh
        httpd = server.Server(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.5},
                     name="http", daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    midi = server.APP.midi.status()
    print("\n  ✦ BasicDAW (desktop)")
    print(f"    server    {url}")
    print(f"    projects  {server.PROJECTS_DIR}")
    print(f"    cache     {server.CACHE_DIR}")
    print(f"    MIDI      {'bridge ready' if midi['available'] else midi['error']}")
    print(f"    Midinous  {'engine loaded' if server.APP.midinous.engine else server.APP.midinous.error}\n")
    return url


def use_ca_bundle() -> None:
    """The packaged Python looks for CA certificates where it was built; point it at certifi when
    this system keeps them elsewhere, so instrument downloads over HTTPS work."""
    import ssl
    paths = ssl.get_default_verify_paths()
    if os.environ.get("SSL_CERT_FILE") or (paths.cafile and os.path.isfile(paths.cafile)):
        return
    try:
        import certifi
        os.environ["SSL_CERT_FILE"] = certifi.where()
    except ImportError:
        pass


def restore_library_path() -> None:
    """The packaged app's LD_LIBRARY_PATH points at its bundled libraries; programs it starts
    (xdg-open, the browser - on KDE these are Qt programs too) need the system's own."""
    if "LD_LIBRARY_PATH_ORIG" in os.environ:
        os.environ["LD_LIBRARY_PATH"] = os.environ.pop("LD_LIBRARY_PATH_ORIG")
    elif server.FROZEN:
        os.environ.pop("LD_LIBRARY_PATH", None)


def log_to_file() -> None:
    """A Windows GUI build has no console (stdout / stderr are None): keep the messages in a log file."""
    if sys.stdout and sys.stderr:
        return
    path = server.user_data_dir() / "basicdaw.log"
    path.parent.mkdir(parents=True, exist_ok=True)
    big = path.is_file() and path.stat().st_size > 1 << 20
    log = open(path, "w" if big else "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or log
    sys.stderr = sys.stderr or log


def run_window(port: int, qt_args: list[str]) -> int:
    from PyQt6.QtCore import QSettings, QStandardPaths, Qt, QTimer, QUrl, pyqtSignal
    from PyQt6.QtGui import QColor, QDesktopServices, QIcon, QKeySequence, QShortcut
    from PyQt6.QtNetwork import QLocalServer, QLocalSocket
    from PyQt6.QtWebEngineCore import (QWebEngineDownloadRequest, QWebEnginePage, QWebEngineProfile,
                                       QWebEngineSettings)
    from PyQt6.QtWebEngineWidgets import QWebEngineView
    from PyQt6.QtWidgets import QApplication, QFileDialog, QMainWindow, QMessageBox

    class Page(QWebEnginePage):
        close_answer = pyqtSignal(str)

        def __init__(self, profile, origin: QUrl, parent):
            super().__init__(profile, parent)
            self.origin = origin

        def _ours(self, url: QUrl) -> bool:
            return url.host() == self.origin.host() and url.port() == self.origin.port()

        def acceptNavigationRequest(self, url, nav_type, is_main_frame):
            # Links to other sites open in the system browser instead of replacing the app.
            if is_main_frame and url.scheme() in ("http", "https") and not self._ours(url):
                QDesktopServices.openUrl(url)
                return False
            return super().acceptNavigationRequest(url, nav_type, is_main_frame)

        def createWindow(self, _type):
            popup = QWebEnginePage(self.profile(), self)

            def opened(url: QUrl):
                if not url.isEmpty():
                    QDesktopServices.openUrl(url)
                    popup.deleteLater()
            popup.urlChanged.connect(opened)
            return popup

        def javaScriptConsoleMessage(self, level, message, line, source):
            if message.startswith(CLOSE_TAG):
                self.close_answer.emit(message[len(CLOSE_TAG):])
            elif level == QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel:
                print(f"[page] {message} ({source}:{line})", file=sys.stderr)

    class Window(QMainWindow):
        def __init__(self, url: str, icon: QIcon):
            super().__init__()
            self.settings = QSettings()
            self.may_close = False
            self.asking = False
            self.setWindowTitle("BasicDAW")
            self.setWindowIcon(icon)
            self.setMinimumSize(900, 560)
            if not self.restoreGeometry(self.settings.value("geometry", b"")):
                self.resize(1440, 900)

            profile = QWebEngineProfile(APP_ID, self)
            profile.setPersistentStoragePath(str(server.user_data_dir() / "webengine"))
            profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.MemoryHttpCache)  # instruments are cached by the server
            profile.downloadRequested.connect(self.on_download)
            s = profile.settings()
            s.setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False)
            s.setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanAccessClipboard, True)

            self.page = Page(profile, QUrl(url), self)
            self.page.setBackgroundColor(QColor("#06070d"))
            self.page.titleChanged.connect(lambda t: self.setWindowTitle(t or "BasicDAW"))
            self.page.close_answer.connect(self.on_close_answer)
            self.page.renderProcessTerminated.connect(self.on_crash)
            self.view = QWebEngineView(self)
            self.view.setPage(self.page)
            self.view.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
            self.view.customContextMenuRequested.connect(self.on_context_menu)
            self.setCentralWidget(self.view)
            self.view.load(QUrl(url))

            QShortcut(QKeySequence("F11"), self, self.toggle_fullscreen)
            QShortcut(QKeySequence("Ctrl+Q"), self, self.close)

        def toggle_fullscreen(self):
            if self.isFullScreen():
                self.showNormal()
            else:
                self.showFullScreen()

        def on_context_menu(self, pos):
            # The app draws its own menus; keep the standard one only for copy / paste in text fields.
            req = self.view.lastContextMenuRequest()
            if req and req.isContentEditable():
                self.view.createStandardContextMenu().popup(self.view.mapToGlobal(pos))

        def on_download(self, req: QWebEngineDownloadRequest):
            """Exports (WAV, MIDI, project file) are blob downloads: ask where to save them."""
            folder = self.settings.value("exportDir") or QStandardPaths.writableLocation(
                QStandardPaths.StandardLocation.MusicLocation) or str(Path.home())
            name = req.downloadFileName()
            ext = Path(name).suffix
            filters = f"{ext[1:].upper()} file (*{ext});;All files (*)" if ext else "All files (*)"
            path, _ = QFileDialog.getSaveFileName(self, "Export", str(Path(folder) / name), filters)
            if not path:
                req.cancel()
                return
            target = Path(path)
            self.settings.setValue("exportDir", str(target.parent))
            req.setDownloadDirectory(str(target.parent))
            req.setDownloadFileName(target.name)
            req.accept()

        def on_crash(self, status, code):
            if status != QWebEnginePage.RenderProcessTerminationStatus.NormalTerminationStatus:
                print(f"[desktop] page process ended ({status.name}, {code}) - reloading", file=sys.stderr)
                QTimer.singleShot(500, self.view.reload)

        def closeEvent(self, event):
            if self.may_close:
                self.settings.setValue("geometry", self.saveGeometry())
                event.accept()
                return
            event.ignore()
            if not self.asking:
                self.asking = True
                self.page.runJavaScript(ASK_CLOSE_JS, self.on_asked)

        def on_asked(self, asked):
            if not asked:  # page not loaded (or broken): there is nothing to save
                self.close_now()

        def on_close_answer(self, answer: str):
            self.asking = False
            if answer == "yes":
                self.close_now()
            elif answer == "error":
                ok = QMessageBox.question(self, "Close BasicDAW?",
                                          "BasicDAW could not check for unsaved changes. Close anyway?")
                if ok == QMessageBox.StandardButton.Yes:
                    self.close_now()

        def close_now(self):
            self.may_close = True
            self.close()

        def bring_to_front(self):
            if self.isMinimized():
                self.showNormal()
            self.raise_()
            self.activateWindow()

    if sys.platform == "win32":  # its own task bar button and icon, not python's
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("BasicDAW.App")
    if sys.platform.startswith("linux") and not os.environ.get("QT_QPA_PLATFORMTHEME"):
        # The bundled Qt has no KDE / GNOME theme plugin; the portal gives the desktop's own file dialogs.
        os.environ["QT_QPA_PLATFORMTHEME"] = "xdgdesktopportal"
    app = QApplication([sys.argv[0], *qt_args])
    app.setOrganizationName("BasicDAW")
    app.setApplicationName("BasicDAW")
    if not QSettings().allKeys():  # window size and export folder from when the app was called Nebula DAW
        old = QSettings("Nebula", "Nebula DAW")
        for key in old.allKeys():
            QSettings().setValue(key, old.value(key))
    app.setDesktopFileName(APP_ID)  # Wayland app id -> the launcher's icon in the task bar
    icon = QIcon(str(server.WEB_DIR / "img" / "logo.svg"))
    app.setWindowIcon(icon)

    # One window per user: a second launch just raises the first.
    instance = f"{APP_ID}-{os.getuid() if hasattr(os, 'getuid') else os.getlogin()}"
    probe = QLocalSocket()
    probe.connectToServer(instance)
    if probe.waitForConnected(300):
        probe.write(b"raise")
        probe.waitForBytesWritten(300)
        print("BasicDAW is already running - raised its window.")
        return 0
    QLocalServer.removeServer(instance)
    single = QLocalServer()
    single.listen(instance)

    use_ca_bundle()
    window = Window(start_server(port), icon)
    single.newConnection.connect(lambda: (single.nextPendingConnection(), window.bring_to_front()))
    window.show()
    return app.exec()


def main() -> None:
    log_to_file()
    restore_library_path()
    if "--browser" in sys.argv[1:]:
        sys.argv.remove("--browser")
        use_ca_bundle()
        return server.main()
    ap = argparse.ArgumentParser(description="BasicDAW desktop app", epilog="--browser: run the server only "
                                 "and open the DAW in a browser (takes ./run.sh's options)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("BASICDAW_DESKTOP_PORT", DEFAULT_PORT)),
                    help=f"local server port (default {DEFAULT_PORT})")
    args, qt_args = ap.parse_known_args()
    if sys.stdout:  # None in a Windows GUI build
        sys.stdout.reconfigure(line_buffering=True)
    sys.exit(run_window(args.port, qt_args))


if __name__ == "__main__":
    main()
