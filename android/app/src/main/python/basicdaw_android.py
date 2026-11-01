"""Android entry point: runs BasicDAW's server (server.py, the same one the desktop apps use) inside the app.

MainActivity calls start() and shows http://127.0.0.1:<port>/ in a WebView. The Gradle build copies server.py
and web/ (plus ffmpeg.wasm for the MP3 / OGG / FLAC... exports) next to this file.
"""

import os
import threading

_port = None


def start(context, port: int) -> int:
    """Start the server once per process (the activity can be recreated) and return its port."""
    global _port
    if _port:
        return _port
    home = os.environ["HOME"]  # the app's private storage
    os.environ.setdefault("BASICDAW_PROJECTS_DIR", os.path.join(home, "projects"))
    os.environ.setdefault("BASICDAW_CACHE_DIR", os.path.join(home, "instruments"))

    import server  # after the environment: it reads the folders on import
    from java import jclass

    downloads = jclass("com.basicdaw.app.Downloads")
    # A WebView can't save blob downloads: the page sends exports to the server, which puts them in Download/.
    server.EXPORT_SINK = lambda name, mime, data: downloads.save(context, name, mime, data)
    server.APP = server.App()
    try:
        httpd = server.Server(("127.0.0.1", port), server.Handler)
    except OSError:  # taken: any free port works, preferences start fresh
        httpd = server.Server(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.5}, name="http", daemon=True).start()
    _port = httpd.server_address[1]
    print(f"BasicDAW server on port {_port}, projects in {server.PROJECTS_DIR}")
    return _port
