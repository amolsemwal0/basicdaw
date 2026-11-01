#!/usr/bin/env python3
"""BasicDAW server.

* serves the web app from ./web
* stores projects on disk (./projects/<id>/project.json + audio/)
* downloads the online instrument libraries once and caches them in ./cache
* bridges MIDI (ALSA on Linux, Windows MIDI: Midinous' ports, hardware, other apps) to the browser
* converts Midinous documents to notes and DAW tracks to Midinous documents, using the
  engine from MidinousMCP when it is installed
* encodes exports with ffmpeg (FLAC, MP3, OGG, Opus, M4A)

The Windows and Android apps (windows/, android/) run this same server.
"""

from __future__ import annotations

import argparse
import datetime as dt
import heapq
import json
import os
import queue
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
from collections import deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

FROZEN = getattr(sys, "frozen", False)  # running as the packaged desktop app (PyInstaller)
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
WEB_DIR = ROOT / "web"


def user_data_dir() -> Path:
    """Where the packaged app keeps projects and the instrument cache (its own files are read-only)."""
    if sys.platform == "win32":
        base, name, old = Path(os.environ.get("APPDATA") or Path.home() / "AppData/Roaming"), "BasicDAW", "Nebula DAW"
    elif sys.platform == "darwin":
        base, name, old = Path.home() / "Library/Application Support", "BasicDAW", "Nebula DAW"
    else:
        base, name, old = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share"), "basicdaw", "nebula-daw"
    if not (base / name).exists() and (base / old).is_dir():  # the app used to be called Nebula DAW
        try:
            (base / old).rename(base / name)
        except OSError:
            return base / old
    return base / name


DATA_DIR = user_data_dir() if FROZEN else ROOT
PROJECTS_DIR = Path(os.environ.get("BASICDAW_PROJECTS_DIR", DATA_DIR / "projects")).expanduser()
TRASH_DIR = PROJECTS_DIR / ".trash"
CACHE_DIR = Path(os.environ.get("BASICDAW_CACHE_DIR", DATA_DIR / "cache")).expanduser()
MIDINOUS_MCP_SRC = Path(os.environ.get("MIDINOUS_MCP_SRC",
                                       Path.home() / "Software/MCP/MidinousMCP/src")).expanduser()
MIDINOUS_USER_DIR = Path(os.environ.get("MIDINOUS_USER_DIR",
                                        Path.home() / ".local/share/Midinous")).expanduser() / "user"

# Online instrument libraries. Only these hosts are ever contacted.
REMOTES = {
    "gleitz": "https://gleitz.github.io/midi-js-soundfonts/",      # 128 GM instruments, 3 soundfonts
    "surikov": "https://surikov.github.io/webaudiofontdata/sound/",  # GM drum kits
    "tonejs": "https://tonejs.github.io/audio/drum-samples/",        # drum machines
}
REMOTE_PATH = re.compile(r"^[A-Za-z0-9_\-.]+(?:/[A-Za-z0-9_\-.]+)*$")
PROJECT_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
AUDIO_NAME = re.compile(r"^[A-Za-z0-9_\-. ()\[\]]{1,140}$")
MAX_JSON = 64 * 1024 * 1024
MAX_UPLOAD = 1024 * 1024 * 1024
WINDOWS = sys.platform == "win32"
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if WINDOWS else {}  # no console flash from a GUI app

# Where exports go when the page can't download files itself: fn(name, mime, data) -> where it was saved.
# The Android app sets this (a WebView can't save blob downloads); /api/health tells the page.
EXPORT_SINK = None

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
    ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".mid": "audio/midi",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac",
    ".m4a": "audio/mp4", ".webm": "audio/webm", ".opus": "audio/ogg", ".wasm": "application/wasm",
}


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


# ---------------------------------------------------------------------------- projects

class ProjectStore:
    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.Lock()
        root.mkdir(parents=True, exist_ok=True)

    def _dir(self, pid: str) -> Path:
        if not PROJECT_ID.fullmatch(pid or ""):
            raise ApiError(400, f"Bad project id {pid!r}")
        return self.root / pid

    def _existing(self, pid: str) -> Path:
        d = self._dir(pid)
        if not (d / "project.json").is_file():
            raise ApiError(404, f"Project {pid!r} not found")
        return d

    @staticmethod
    def _slug(name: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "project"

    @staticmethod
    def summarize(project: dict, pid: str) -> dict:
        tracks = project.get("tracks") or []
        notes = 0
        end = 0.0
        for t in tracks:
            for n in t.get("notes") or []:
                notes += 1
                end = max(end, float(n.get("start", 0)) + float(n.get("duration", 0)))
        return {
            "id": pid, "name": project.get("name") or pid,
            "created": project.get("created"), "modified": project.get("modified"),
            "bpm": project.get("bpm", 120), "tracks": len(tracks), "notes": notes,
            "lengthBeats": round(end, 3),
            "trackInfo": [{"name": t.get("name"), "color": t.get("color"), "type": t.get("type")}
                          for t in tracks[:12]],
            "thumbnail": project.get("thumbnail"),
        }

    def list(self) -> list[dict]:
        out = []
        self.root.mkdir(parents=True, exist_ok=True)
        for d in self.root.iterdir():
            if not d.is_dir() or d.name.startswith(".") or not PROJECT_ID.fullmatch(d.name):
                continue
            meta = d / "meta.json"
            try:
                if meta.is_file():
                    out.append(json.loads(meta.read_text("utf-8")))
                elif (d / "project.json").is_file():
                    summary = self.summarize(json.loads((d / "project.json").read_text("utf-8")), d.name)
                    write_atomic(meta, json.dumps(summary).encode())
                    out.append(summary)
            except (OSError, ValueError):
                continue
        out.sort(key=lambda s: s.get("modified") or "", reverse=True)
        return out

    def get(self, pid: str) -> dict:
        return json.loads((self._existing(pid) / "project.json").read_text("utf-8"))

    def _write(self, pid: str, project: dict) -> dict:
        d = self._dir(pid)
        project["id"] = pid
        write_atomic(d / "project.json", json.dumps(project, separators=(",", ":")).encode())
        summary = self.summarize(project, pid)
        write_atomic(d / "meta.json", json.dumps(summary).encode())
        return summary

    def create(self, name: str, project: dict | None) -> dict:
        name = (name or "Untitled").strip()[:120] or "Untitled"
        with self.lock:
            pid = f"{self._slug(name)}-{secrets.token_hex(3)}"
            while (self.root / pid).exists():
                pid = f"{self._slug(name)}-{secrets.token_hex(3)}"
            project = dict(project or {})
            project["name"] = name
            project["created"] = project["modified"] = now_iso()
            (self.root / pid / "audio").mkdir(parents=True, exist_ok=True)
            summary = self._write(pid, project)
        return {"id": pid, "project": project, "summary": summary}

    def save(self, pid: str, project: dict) -> dict:
        if not isinstance(project, dict) or not isinstance(project.get("tracks", []), list):
            raise ApiError(400, "Project must be an object with a tracks list")
        with self.lock:
            d = self._dir(pid)
            old_created = None
            if (d / "project.json").is_file():
                try:
                    old_created = json.loads((d / "project.json").read_text("utf-8")).get("created")
                except ValueError:
                    pass
            project["created"] = project.get("created") or old_created or now_iso()
            project["modified"] = now_iso()
            return self._write(pid, project)

    def rename(self, pid: str, name: str) -> dict:
        name = (name or "").strip()[:120]
        if not name:
            raise ApiError(400, "Name must not be empty")
        project = self.get(pid)
        project["name"] = name
        return self.save(pid, project)

    def duplicate(self, pid: str, name: str | None) -> dict:
        src = self._existing(pid)
        project = self.get(pid)
        name = (name or f"{project.get('name', 'Project')} copy").strip()[:120]
        with self.lock:
            new_id = f"{self._slug(name)}-{secrets.token_hex(3)}"
            shutil.copytree(src, self.root / new_id)
        project.update(name=name, created=now_iso())
        summary = self.save(new_id, project)
        return {"id": new_id, "summary": summary}

    def delete(self, pid: str) -> dict:
        src = self._existing(pid)
        TRASH_DIR.mkdir(parents=True, exist_ok=True)
        dest = TRASH_DIR / f"{pid}-{dt.datetime.now():%Y%m%d-%H%M%S}"
        with self.lock:
            src.rename(dest)
        return {"deleted": pid, "trash": str(dest)}

    def audio_path(self, pid: str, name: str) -> Path:
        if not AUDIO_NAME.fullmatch(name or "") or name.startswith("."):
            raise ApiError(400, f"Bad audio file name {name!r}")
        return self._existing(pid) / "audio" / name

    def save_audio(self, pid: str, name: str, stream, length: int) -> dict:
        name = re.sub(r"[^A-Za-z0-9_\-. ()\[\]]", "_", name)[-140:].lstrip(".") or "audio"
        target = self.audio_path(pid, name)
        if target.exists() and target.stat().st_size != length:
            stem, dot, ext = name.rpartition(".")
            stem = stem if dot else name
            name = f"{stem}-{secrets.token_hex(2)}{dot}{ext if dot else ''}"
            target = self.audio_path(pid, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}.part")
        remaining = length
        with open(tmp, "wb") as f:
            while remaining > 0:
                chunk = stream.read(min(1 << 20, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        if remaining:
            tmp.unlink(missing_ok=True)
            raise ApiError(400, "Upload was cut short")
        tmp.replace(target)
        return {"file": name, "size": length}


# ---------------------------------------------------------------------------- remote instrument cache

class RemoteCache:
    def __init__(self, root: Path):
        self.root = root
        self.locks: dict[str, threading.Lock] = {}
        self.guard = threading.Lock()

    def fetch(self, src: str, path: str) -> Path:
        base = REMOTES.get(src)
        if base is None or not REMOTE_PATH.fullmatch(path) or any(s.startswith(".") for s in path.split("/")):
            raise ApiError(400, f"Not an allowed instrument path: {src}/{path}")
        target = self.root / src / path
        if target.is_file():
            return target
        key = f"{src}/{path}"
        with self.guard:
            lock = self.locks.setdefault(key, threading.Lock())
        with lock:
            if target.is_file():
                return target
            url = base + path
            req = urllib.request.Request(url, headers={"User-Agent": "BasicDAW/1.0"})
            try:
                with urllib.request.urlopen(req, timeout=90) as resp:
                    data = resp.read()
            except urllib.error.HTTPError as exc:
                raise ApiError(404 if exc.code == 404 else 502, f"{url}: HTTP {exc.code}") from None
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                raise ApiError(502, f"Could not download {url} ({exc}). Are you online?") from None
            write_atomic(target, data)
            return target

    def listing(self) -> dict:
        files = []
        total = 0
        if self.root.is_dir():
            for p in self.root.rglob("*"):
                if p.is_file() and not p.name.startswith("."):
                    files.append(p.relative_to(self.root).as_posix())
                    total += p.stat().st_size
        return {"files": files, "bytes": total}

    def clear(self) -> dict:
        info = self.listing()
        if self.root.is_dir():
            shutil.rmtree(self.root)
        self.root.mkdir(parents=True, exist_ok=True)
        return {"removed": len(info["files"]), "bytes": info["bytes"]}


# ---------------------------------------------------------------------------- MIDI bridge

PORT_SUFFIX = re.compile(r"\s+\d+:\d+$")


def clean_port(name: str) -> str:
    return PORT_SUFFIX.sub("", name)


class MidiBridge:
    """MIDI <-> browser (ALSA on Linux, WinMM on Windows). Incoming messages are pushed to Server-Sent-Event
    subscribers; outgoing messages can be timestamped so the browser's look-ahead scheduler stays tight."""

    VIRTUAL_IN = "BasicDAW In"
    VIRTUAL_OUT = "BasicDAW Out"

    def __init__(self):
        self.rt = None
        self.error = None
        self.lock = threading.RLock()        # ports
        self.out_lock = threading.Lock()     # sending
        self.sub_lock = threading.Lock()     # subscribers
        self.subscribers: list[queue.Queue] = []
        self.inputs: dict[str, object] = {}
        self.outputs: dict[str, object] = {}
        self.wanted: set[str] | None = None  # None = automatic (Midinous ports)
        self.ports = {"inputs": [], "outputs": []}
        self.used_outputs: set[str] = set()
        self.ticks: dict[str, deque] = {}
        self.tick_count: dict[str, int] = {}
        self._last_open: set[str] = set()
        self.sched: list = []
        self.sched_cv = threading.Condition()
        self.seq = 0
        self.clock_cv = threading.Condition()
        self.clock_running = False
        self.clock_bpm = 120.0
        self.clock_targets: list[str] = []
        try:
            import rtmidi
            self.rt = rtmidi
            self.probe_in = rtmidi.MidiIn(name="BasicDAW probe")
            self.probe_out = rtmidi.MidiOut(name="BasicDAW probe")
        except ImportError:
            self.rt = None
            self.error = ("MIDI devices are not supported in the Android app" if sys.platform == "android" else
                          "python-rtmidi is not installed - start the server with ./run.sh (uv) to enable MIDI")
        except Exception as exc:  # no ALSA sequencer etc.
            self.rt = None
            self.error = f"MIDI unavailable: {exc}"
        self.virtual_in = self.virtual_out = None
        if self.rt:
            try:
                vin = self.rt.MidiIn(name="BasicDAW")
                vin.ignore_types(sysex=True, timing=False, active_sense=True)
                vin.set_callback(self._on_message, self.VIRTUAL_IN)
                vin.open_virtual_port(self.VIRTUAL_IN)
                vout = self.rt.MidiOut(name="BasicDAW")
                vout.open_virtual_port(self.VIRTUAL_OUT)
                self.virtual_in, self.virtual_out = vin, vout
            except Exception:  # Windows' MIDI API has no virtual ports: hardware / loopMIDI ports still work
                pass
        if self.rt:
            for target in (self._watch, self._scheduler, self._clock_loop):
                threading.Thread(target=target, daemon=True).start()

    # -- subscribers
    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=4000)
        with self.sub_lock:
            self.subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.sub_lock:
            if q in self.subscribers:
                self.subscribers.remove(q)

    def publish(self, event: dict) -> None:
        line = json.dumps(event)
        with self.sub_lock:
            subs = list(self.subscribers)
        for q in subs:
            try:
                q.put_nowait(line)
            except queue.Full:
                pass

    # -- ports
    def _wants(self, name: str) -> bool:
        if self.wanted is None:
            return "Midinous" in name and "Thru" not in name
        return name in self.wanted

    def _list(self, probe) -> list[tuple[int, str]]:
        out = []
        seen: dict[str, int] = {}
        for i, raw in enumerate(probe.get_ports()):
            name = clean_port(raw)
            if name.startswith("BasicDAW"):
                continue
            seen[name] = seen.get(name, 0) + 1
            if seen[name] > 1:
                name = f"{name} #{seen[name]}"
            out.append((i, name))
        return out

    def refresh(self) -> None:
        if not self.rt:
            return
        with self.lock:
            ins = self._list(self.probe_in)
            outs = self._list(self.probe_out)
            in_names = [n for _, n in ins]
            out_names = [n for _, n in outs]
            for name in list(self.inputs):
                if name not in in_names or not self._wants(name):
                    dev = self.inputs.pop(name)
                    try:
                        dev.close_port()
                    except Exception:
                        pass
            for name in list(self.outputs):
                if name not in out_names:
                    dev = self.outputs.pop(name)
                    try:
                        dev.close_port()
                    except Exception:
                        pass
            for idx, name in ins:
                if name not in self.inputs and self._wants(name):
                    try:
                        dev = self.rt.MidiIn(name="BasicDAW In")
                        dev.ignore_types(sysex=True, timing=False, active_sense=True)
                        dev.set_callback(self._on_message, name)
                        dev.open_port(idx, name="from " + name[:40])
                        self.inputs[name] = dev
                    except Exception as exc:
                        print(f"[midi] could not open input {name}: {exc}")
            ports = {"inputs": in_names, "outputs": out_names}
            changed = ports != self.ports or set(self.inputs) != self._last_open
            self.ports = ports
            self._last_open = set(self.inputs)
        if changed:
            self.publish({"type": "ports", **self.status()})

    def set_wanted(self, wanted: list[str] | None) -> dict:
        with self.lock:
            self.wanted = None if wanted is None else set(wanted)
        self.refresh()
        return self.status()

    def _watch(self) -> None:
        while True:
            try:
                self.refresh()
            except Exception as exc:
                print(f"[midi] port refresh failed: {exc}")
            time.sleep(1.5)

    def status(self) -> dict:
        with self.lock:
            return {
                "available": self.rt is not None, "error": self.error,
                "inputs": list(self.ports["inputs"]),
                "outputs": list(self.ports["outputs"]) + ([self.VIRTUAL_OUT] if self.virtual_out else []),
                "open": sorted(self.inputs), "auto": self.wanted is None,
                "wanted": None if self.wanted is None else sorted(self.wanted),
                "virtualIn": self.VIRTUAL_IN if self.virtual_in else None,
                "virtualOut": self.VIRTUAL_OUT if self.virtual_out else None,
                "midinousRunning": any("Midinous Port" in p for p in self.ports["inputs"]),
                "clock": {"running": self.clock_running, "bpm": self.clock_bpm, "targets": self.clock_targets},
            }

    # -- input
    def _on_message(self, event, port) -> None:
        msg, _delta = event
        if not msg:
            return
        status = msg[0]
        if status == 0xF8:
            # 24 clocks per quarter note: report the tempo once per beat
            dq = self.ticks.setdefault(port, deque(maxlen=49))
            dq.append(time.perf_counter())
            self.tick_count[port] = self.tick_count.get(port, 0) + 1
            if self.tick_count[port] % 24 == 0 and len(dq) >= 25:
                per_tick = (dq[-1] - dq[0]) / (len(dq) - 1)
                if per_tick > 0:
                    self.publish({"type": "clock", "port": port, "bpm": round(60.0 / (per_tick * 24), 2)})
            return
        if status in (0xFA, 0xFC):
            self.ticks.pop(port, None)
            self.tick_count[port] = 0
        if status in (0xFE, 0xF1):
            return
        self.publish({"type": "midi", "port": port, "data": list(msg), "t": time.time()})

    # -- output
    def _get_output(self, port: str):
        if port == self.VIRTUAL_OUT and self.virtual_out:
            return self.virtual_out
        with self.lock:
            dev = self.outputs.get(port)
            if dev is not None:
                return dev
            for idx, name in self._list(self.probe_out):
                if name == port:
                    dev = self.rt.MidiOut(name="BasicDAW Out")
                    dev.open_port(idx, name="to " + name[:40])
                    self.outputs[port] = dev
                    return dev
        raise ApiError(404, f"MIDI output {port!r} not found")

    def _send_now(self, port: str, data: list[int]) -> None:
        dev = self._get_output(port)
        with self.out_lock:
            dev.send_message(data)
        self.used_outputs.add(port)

    def send(self, port: str, events: list[dict]) -> int:
        if not self.rt:
            raise ApiError(503, self.error or "MIDI unavailable")
        self._get_output(port)  # fail early on unknown ports
        now = time.perf_counter()
        n = 0
        with self.sched_cv:
            for ev in events:
                data = [int(b) & 0xFF for b in ev.get("data", [])][:3]
                if not data:
                    continue
                delay = float(ev.get("delay", 0) or 0)
                self.seq += 1
                heapq.heappush(self.sched, (now + max(0.0, delay), self.seq, port, data))
                n += 1
            self.sched_cv.notify()
        return n

    def flush(self) -> dict:
        with self.sched_cv:
            dropped = len(self.sched)
            self.sched.clear()
        for port in list(self.used_outputs):
            for ch in range(16):
                try:
                    self._send_now(port, [0xB0 | ch, 123, 0])
                    self._send_now(port, [0xB0 | ch, 64, 0])
                except Exception:
                    pass
        return {"dropped": dropped}

    def _scheduler(self) -> None:
        while True:
            with self.sched_cv:
                while not self.sched:
                    self.sched_cv.wait()
                t, _, port, data = self.sched[0]
                wait = t - time.perf_counter()
                if wait > 0.0005:
                    self.sched_cv.wait(timeout=min(wait, 0.05))
                    continue
                heapq.heappop(self.sched)
            try:
                self._send_now(port, data)
            except Exception as exc:
                print(f"[midi] send to {port} failed: {exc}")

    # -- clock / transport (e.g. Midinous with clock source External)
    def clock(self, action: str, bpm: float | None, ports: list[str], send_clock: bool = True) -> dict:
        if not self.rt:
            raise ApiError(503, self.error or "MIDI unavailable")
        if bpm:
            self.clock_bpm = max(20.0, min(400.0, float(bpm)))
        if action == "start":
            for p in ports:
                self._send_now(p, [0xFA])
            with self.clock_cv:
                self.clock_targets = list(ports) if send_clock else []
                self.clock_running = bool(self.clock_targets)
                self.clock_cv.notify_all()
        elif action == "stop":
            with self.clock_cv:
                targets = set(self.clock_targets) | set(ports)
                self.clock_running = False
                self.clock_targets = []
            for p in targets:
                try:
                    self._send_now(p, [0xFC])
                except ApiError:
                    pass
        elif action != "tempo":
            raise ApiError(400, f"Unknown clock action {action!r}")
        return self.status()["clock"]

    def _clock_loop(self) -> None:
        next_t = None
        while True:
            with self.clock_cv:
                while not self.clock_running:
                    self.clock_cv.wait()
                    next_t = None
                targets = list(self.clock_targets)
                interval = 60.0 / self.clock_bpm / 24.0
            now = time.perf_counter()
            if next_t is None:
                next_t = now
            if now < next_t:
                time.sleep(min(next_t - now, 0.004))
                continue
            for p in targets:
                try:
                    self._send_now(p, [0xF8])
                except Exception:
                    pass
            next_t += interval
            if now - next_t > 0.1:
                next_t = now


# ---------------------------------------------------------------------------- Midinous

class Midinous:
    """File-level integration with Midinous (uses MidinousMCP's engine when available)."""

    def __init__(self, bridge: MidiBridge):
        self.bridge = bridge
        self.error = None
        self.engine = self.model = self.compose = self.paths = None
        if MIDINOUS_MCP_SRC.is_dir():
            if str(MIDINOUS_MCP_SRC) not in sys.path:
                sys.path.append(str(MIDINOUS_MCP_SRC))
            try:
                from midinous_mcp import compose, engine, model, paths  # stdlib-only modules
                self.engine, self.model, self.compose, self.paths = engine, model, compose, paths
            except Exception as exc:
                self.error = f"Could not load the Midinous engine: {type(exc).__name__}: {exc}"
        else:
            self.error = f"MidinousMCP not found at {MIDINOUS_MCP_SRC} (set MIDINOUS_MCP_SRC)"
        self.instrument_table = self._read_instrument_table()

    @property
    def save_dir(self) -> Path:
        return self.paths.SAVE_DIR if self.paths else MIDINOUS_USER_DIR / "save"

    @property
    def midi_dirs(self) -> list[Path]:
        dirs = [self.paths.MIDI_DIR if self.paths else MIDINOUS_USER_DIR / "save_MIDI"]
        if self.paths and self.paths.EXPORT_DIR not in dirs:
            dirs.append(self.paths.EXPORT_DIR)
        return dirs

    @property
    def preset_dir(self) -> Path | None:
        return self.paths.PRESET_DIR if self.paths else None

    def _read_instrument_table(self) -> dict:
        """Midinous internal-synth preset -> GM program, read from MidinousMCP's synth.py source
        (importing it would need numpy)."""
        src = MIDINOUS_MCP_SRC / "midinous_mcp" / "synth.py"
        table = {}
        try:
            text = src.read_text("utf-8")
            pat = r'"(\w+)":\s*\{"category":\s*"(\w+)",\s*"gm":\s*(\d+)(?:,\s*"drum_note":\s*(\d+))?'
            for key, cat, gm, drum in re.findall(pat, text):
                table[key] = {"category": cat, "gm": int(gm), "drumNote": int(drum) if drum else None}
        except OSError:
            pass
        return table

    def channel_instruments(self) -> dict:
        state_file = self.paths.STATE_FILE if self.paths else MIDINOUS_MCP_SRC.parent / "data" / "state.json"
        try:
            chans = json.loads(Path(state_file).read_text("utf-8")).get("channel_instruments") or {}
        except (OSError, ValueError):
            chans = {}
        out = {}
        for ch, key in chans.items():
            info = self.instrument_table.get(key, {})
            out[str(ch)] = {"instrument": key, **info}
        return out

    def status(self) -> dict:
        return {
            "engine": self.engine is not None, "error": self.error,
            "userDir": str(MIDINOUS_USER_DIR), "userDirExists": MIDINOUS_USER_DIR.is_dir(),
            "saveDir": str(self.save_dir), "running": self.bridge.status()["midinousRunning"],
            "presets": bool(self.preset_dir and self.preset_dir.is_dir()),
            "channels": self.channel_instruments(),
        }

    @staticmethod
    def _files(d: Path | None, pattern: str, source: str) -> list[dict]:
        if not d or not d.is_dir():
            return []
        out = []
        for p in d.glob(pattern):
            if p.is_file():
                st = p.stat()
                out.append({"name": p.name, "source": source, "size": st.st_size,
                            "modified": dt.datetime.fromtimestamp(st.st_mtime).astimezone().isoformat(timespec="seconds"),
                            "autosave": p.name.startswith("autosave_")})
        out.sort(key=lambda f: f["modified"], reverse=True)
        return out

    def files(self) -> dict:
        midi = []
        for i, d in enumerate(self.midi_dirs):
            midi += self._files(d, "*.mid", "export" if i else "midi")
        midi.sort(key=lambda f: f["modified"], reverse=True)
        return {
            "documents": self._files(self.save_dir, "*.json", "user"),
            "presets": self._files(self.preset_dir, "*.json", "preset"),
            "midi": midi,
        }

    def _resolve(self, name: str, source: str) -> Path:
        if "/" in name or "\\" in name or name.startswith("."):
            raise ApiError(400, "Bad file name")
        base = {"user": self.save_dir, "preset": self.preset_dir}
        if source in ("midi", "export"):
            d = self.midi_dirs[0 if source == "midi" else -1]
        else:
            d = base.get(source)
        if d is None:
            raise ApiError(400, f"Unknown source {source!r}")
        p = d / name
        if not p.is_file():
            raise ApiError(404, f"{name} not found in {d}")
        return p

    def midi_file(self, name: str, source: str) -> Path:
        return self._resolve(name, source)

    def _need_engine(self):
        if not self.engine:
            raise ApiError(503, self.error or "Midinous engine unavailable")

    def render(self, payload: dict) -> dict:
        self._need_engine()
        seconds = max(1.0, min(600.0, float(payload.get("seconds") or 30)))
        seed = payload.get("seed")
        seed = int(seed) if seed not in (None, "") else None
        if isinstance(payload.get("document"), dict):
            name = str(payload.get("name") or "Midinous document")
            doc = self.model.Document.from_json(payload["document"], name)
        else:
            path = self._resolve(str(payload.get("name", "")), str(payload.get("source", "user")))
            doc = self.model.Document.load(path)
            name = path.stem
        res = self.engine.simulate(doc, max_seconds=seconds, seed=seed)
        notes = []
        end_ms = res.end_ms
        for n in res.note_list():
            dur = n["dur_ms"] if n["dur_ms"] is not None else max(50.0, end_ms - n["t_ms"])
            notes.append({"t": n["t_ms"], "d": dur, "ch": n["ch"], "note": n["note"], "vel": n["vel"]})
        return {"name": name, "tempo": doc.tempo, "notes": notes, "endMs": end_ms,
                "stopReason": res.stop_reason, "warnings": res.warnings[:20],
                "channels": self.channel_instruments()}

    def export(self, payload: dict) -> dict:
        self._need_engine()
        model, compose, paths = self.model, self.compose, self.paths
        try:
            name = paths.sanitize_document_name(str(payload.get("name") or "BasicDAW export"))
        except ValueError as exc:
            raise ApiError(400, str(exc)) from None
        target = self.save_dir / f"{name}.json"
        if target.exists() and not payload.get("overwrite"):
            raise ApiError(409, f"A Midinous document called '{name}' already exists")
        bpm = float(payload.get("bpm") or 120)
        loop = bool(payload.get("loop", True))
        total = float(payload.get("lengthBeats") or 0)
        tracks = payload.get("tracks") or []
        if not tracks:
            raise ApiError(400, "Nothing to export")
        doc = model.Document(name)
        doc.set_performance(tempo=bpm, beat_division=4, clock_source=str(payload.get("clockSource") or "Internal"))
        bd = doc.beat_division
        warnings = []
        lanes = 0
        row = 0.0
        for t in tracks:
            channel = max(1, min(16, int(t.get("channel") or 1)))
            notes = sorted(((float(n["start"]), int(n["pitch"]), float(n["duration"]), int(n.get("velocity", 100)))
                            for n in t.get("notes") or [] if 0 <= int(n["pitch"]) <= 127),
                           key=lambda n: (round(n[0], 4), n[1]))
            if not notes:
                continue
            end = max(n[0] + n[2] for n in notes)
            length = max(total, end, 1.0)
            # chords: the k-th note of each onset goes to lane k (Midinous lanes are monophonic)
            voices: list[list] = []
            onset, k = None, 0
            for s, p, d, v in notes:
                key = round(s, 4)
                k = k + 1 if key == onset else 0
                onset = key
                while len(voices) <= k:
                    voices.append([])
                voices[k].append((s, p, d, max(1, min(127, v)), 100))
            color = t.get("color")
            try:
                model.parse_color(color)
            except (ValueError, TypeError):
                color = None
            for vi, events in enumerate(voices):
                lane_row = compose.next_free_row(doc, row, -1, length * bd + 1, step=1.0)
                label = (t.get("name") or f"Track {channel}")[:40]
                compose.build_lane(doc, events, length, channel, lane_row, 0.0, loop=loop,
                                   label=label if vi == 0 else f"{label} v{vi + 1}", color=color)
                lanes += 1
                row = lane_row + 1
            row += 1
            longest = max(n[2] for n in notes) * 60.0 / bpm
            if longest > 2.9:
                warnings.append(f"{t.get('name')}: longest note is {longest:.1f}s - Midinous' internal synth "
                                "cuts voices at ~2.97s (fine when Midinous plays into BasicDAW or other MIDI gear)")
        if not lanes:
            raise ApiError(400, "The selected tracks have no notes")
        try:
            backup = doc.save(target, backup=True)
        except ValueError as exc:
            raise ApiError(400, str(exc)) from None
        return {"saved": str(target), "name": name, "points": len(doc.points), "lanes": lanes,
                "backup": str(backup) if backup else None, "warnings": warnings}


# ---------------------------------------------------------------------------- export encoder (ffmpeg)

# The browser renders the mixdown and writes WAV itself; every other format goes through ffmpeg.
ENCODE_FORMATS = {  # format: (MIME type, ffmpeg encoders it needs)
    "flac": ("audio/flac", ["flac"]),
    "mp3": ("audio/mpeg", ["libmp3lame"]),
    "ogg": ("audio/ogg", ["libvorbis"]),
    "opus": ("audio/ogg", ["libopus"]),
    "m4a": ("audio/mp4", ["aac"]),
}


def find_ffmpeg() -> str | None:
    """BASICDAW_FFMPEG, then the copy bundled with the Windows app, then PATH."""
    bundled = ROOT / "ffmpeg" / ("ffmpeg.exe" if WINDOWS else "ffmpeg")
    return os.environ.get("BASICDAW_FFMPEG") or (str(bundled) if bundled.is_file() else shutil.which("ffmpeg"))


class Encoder:
    """Encodes the mixdown WAV the browser renders to FLAC or compressed audio."""

    def __init__(self):
        self.ffmpeg = find_ffmpeg()
        self.caps: dict | None = None
        self.jobs: dict[str, float] = {}  # job id -> progress 0..1, for the client's progress toast

    def status(self) -> dict:
        if not (self.caps and self.caps["available"]):  # look again until ffmpeg turns up
            self.caps = self._probe()
        return self.caps

    def _probe(self) -> dict:
        self.ffmpeg = find_ffmpeg()
        if not self.ffmpeg:
            return {"available": False, "formats": [], "error": "ffmpeg is not installed"}

        def names(flag: str) -> set[str]:
            out = subprocess.run([self.ffmpeg, "-hide_banner", flag], capture_output=True, text=True,
                                 timeout=15, **NO_WINDOW).stdout
            return {p[1] for p in (line.split() for line in out.splitlines())
                    if len(p) > 2 and re.fullmatch(r"[A-Z.|]{2,6}", p[0])}

        try:
            version = subprocess.run([self.ffmpeg, "-version"], capture_output=True, text=True,
                                     timeout=15, **NO_WINDOW).stdout.split("\n", 1)[0]
            encoders = names("-encoders")
        except (OSError, subprocess.SubprocessError) as exc:
            return {"available": False, "formats": [], "error": f"ffmpeg did not run: {exc}"}
        formats = [f for f, (_, need) in ENCODE_FORMATS.items() if all(e in encoders for e in need)]
        return {"available": True, "version": version, "formats": formats,
                "error": None if formats else "ffmpeg has none of the encoders BasicDAW uses"}

    @staticmethod
    def _copy(stream, path: Path, length: int) -> None:
        remaining = length
        with open(path, "wb") as f:
            while remaining > 0:
                chunk = stream.read(min(1 << 20, remaining))
                if not chunk:
                    raise ApiError(400, "Upload was cut short")
                f.write(chunk)
                remaining -= len(chunk)

    def encode(self, fmt: str, opts: dict, stream, length: int) -> bytes:
        caps = self.status()
        if fmt not in ENCODE_FORMATS:
            raise ApiError(400, f"Unknown export format {fmt!r}")
        if fmt not in caps["formats"]:
            raise ApiError(501, caps["error"] or f"This ffmpeg cannot write {fmt.upper()}")
        duration = float(opts.get("duration") or 0)  # for the progress fraction
        job = opts.get("job") or secrets.token_hex(4)
        with tempfile.TemporaryDirectory(prefix="basicdaw-export-") as tmp:
            wav, out = Path(tmp) / "mix.wav", Path(tmp) / f"out.{fmt}"
            self._copy(stream, wav, length)
            self.jobs[job] = 0.0
            try:
                self._run(self._args(fmt, opts, wav, out), duration, job)
            finally:
                self.jobs.pop(job, None)
            return out.read_bytes()

    def _args(self, fmt: str, opts: dict, wav: Path, out: Path) -> list[str]:
        def pick(key: str, allowed, default: str) -> str:
            v = str(opts.get(key) or default)
            if v not in allowed:
                raise ApiError(400, f"Bad {key} {v!r} for {fmt.upper()}")
            return v

        def tag(key: str) -> str:
            return re.sub(r"[\x00-\x1f\x7f]", " ", str(opts.get(key) or "")).strip()[:200]

        args = [self.ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
                "-progress", "pipe:1", "-y", "-i", str(wav)]
        for key in ("title", "artist"):
            if tag(key):
                args += ["-metadata", f"{key}={tag(key)}"]
        args += ["-metadata", "comment=Made with BasicDAW"]

        if fmt == "flac":
            bits = pick("bits", {"16", "24"}, "24")
            args += ["-c:a", "flac", "-compression_level", "8"]
            args += ["-sample_fmt", "s16"] if bits == "16" else ["-sample_fmt", "s32", "-bits_per_raw_sample", "24"]
        elif fmt == "mp3":
            args += ["-c:a", "libmp3lame", "-b:a", pick("bitrate", {"128", "192", "256", "320"}, "320") + "k",
                     "-id3v2_version", "3"]
        elif fmt == "ogg":
            args += ["-c:a", "libvorbis", "-q:a", pick("quality", {"4", "6", "8", "10"}, "8")]
        elif fmt == "opus":
            args += ["-c:a", "libopus", "-b:a", pick("bitrate", {"96", "128", "160", "192", "256"}, "192") + "k"]
        elif fmt == "m4a":
            args += ["-c:a", "aac", "-b:a", pick("bitrate", {"128", "192", "256", "320"}, "256") + "k",
                     "-movflags", "+faststart"]
        return args + [str(out)]

    def _run(self, args: list[str], duration: float, job: str) -> None:
        with tempfile.TemporaryFile() as err:
            proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=err, text=True,
                                    **NO_WINDOW)
            for line in proc.stdout:
                key, _, val = line.strip().partition("=")
                if key == "out_time_us" and val.isdigit() and duration > 0:
                    self.jobs[job] = min(1.0, int(val) / 1e6 / duration)
            if proc.wait() != 0:
                err.seek(0)
                tail = err.read().decode(errors="replace").strip().splitlines()[-3:]
                raise ApiError(500, f"ffmpeg failed: {' / '.join(tail) or f'exit code {proc.returncode}'}")


# ---------------------------------------------------------------------------- HTTP

class App:
    def __init__(self):
        self.projects = ProjectStore(PROJECTS_DIR)
        self.cache = RemoteCache(CACHE_DIR)
        self.midi = MidiBridge()
        self.midinous = Midinous(self.midi)
        self.encoder = Encoder()


APP: App | None = None


class Handler(BaseHTTPRequestHandler):
    server_version = "BasicDAW/1.0"
    protocol_version = "HTTP/1.1"

    # -- helpers
    def log_message(self, fmt, *args):  # quiet; errors are printed by _fail
        pass

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, status: int = 200) -> None:
        self._send(status, json.dumps(obj).encode(), "application/json", {"Cache-Control": "no-store"})

    def _file(self, path: Path, ctype: str | None = None, cache: str = "no-cache") -> None:
        ctype = ctype or STATIC_TYPES.get(path.suffix.lower(), "application/octet-stream")
        data = path.read_bytes()
        self._send(200, data, ctype, {"Cache-Control": cache})

    def _body(self, limit: int = MAX_JSON) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise ApiError(413, "Request too large")
        return self.rfile.read(length) if length else b""

    def _read_json(self):
        raw = self._body()
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError:
            raise ApiError(400, "Invalid JSON") from None

    def _fail(self, exc: Exception) -> None:
        if isinstance(exc, ApiError):
            status, msg = exc.status, str(exc)
            if status >= 500:
                print(f"[api] {self.command} {self.path}: {msg}")
        else:
            status, msg = 500, f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
        try:
            self._json({"error": msg}, status)
        except OSError:
            pass

    # -- verbs
    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        url = urlparse(self.path)
        path = unquote(url.path)
        query = {k: v[-1] for k, v in parse_qs(url.query).items()}
        try:
            if path.startswith("/api/"):
                self._api(method, path[5:].strip("/").split("/"), query)
            elif path.startswith("/remote/") and method == "GET":
                src, _, rest = path[len("/remote/"):].partition("/")
                f = APP.cache.fetch(src, rest)
                self._file(f, cache="public, max-age=31536000, immutable")
            elif method == "GET":
                self._static(path)
            else:
                raise ApiError(405, "Method not allowed")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001 - every error becomes a JSON reply
            self._fail(exc)

    def _static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        target = (WEB_DIR / rel).resolve()
        if WEB_DIR.resolve() not in target.parents and target != WEB_DIR.resolve():
            raise ApiError(404, "Not found")
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            raise ApiError(404, "Not found")
        self._file(target)

    def _api(self, method: str, parts: list[str], query: dict) -> None:
        a = APP
        head = parts[0] if parts else ""
        n = len(parts)

        if head == "health":
            return self._json({"ok": True, "version": 1, "saveExports": EXPORT_SINK is not None})

        if head == "exports" and n == 1 and method == "POST" and EXPORT_SINK:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_UPLOAD:
                raise ApiError(413, "The file is empty or too large")
            name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", query.get("name", "")).strip(". ")[:140] or "export"
            data = self.rfile.read(length)
            return self._json({"saved": EXPORT_SINK(name, query.get("type") or "application/octet-stream", data)})

        if head == "projects":
            if n == 1 and method == "GET":
                return self._json({"projects": a.projects.list()})
            if n == 1 and method == "POST":
                body = self._read_json()
                return self._json(a.projects.create(body.get("name"), body.get("project")), 201)
            pid = parts[1] if n > 1 else ""
            if n == 2:
                if method == "GET":
                    return self._json(a.projects.get(pid))
                if method == "PUT":
                    return self._json(a.projects.save(pid, self._read_json()))
                if method == "DELETE":
                    return self._json(a.projects.delete(pid))
            if n == 3 and method == "POST" and parts[2] == "duplicate":
                return self._json(a.projects.duplicate(pid, self._read_json().get("name")), 201)
            if n == 3 and method == "POST" and parts[2] == "rename":
                return self._json(a.projects.rename(pid, self._read_json().get("name")))
            if n == 4 and parts[2] == "audio":
                if method == "GET":
                    f = a.projects.audio_path(pid, parts[3])
                    if not f.is_file():
                        raise ApiError(404, "Audio file not found")
                    return self._file(f, cache="private, max-age=3600")
                if method == "PUT":
                    length = int(self.headers.get("Content-Length") or 0)
                    if length <= 0 or length > MAX_UPLOAD:
                        raise ApiError(413, "Audio file is empty or too large")
                    return self._json(a.projects.save_audio(pid, parts[3], self.rfile, length), 201)

        if head == "cache":
            if method == "GET":
                return self._json(a.cache.listing())
            if method == "DELETE":
                return self._json(a.cache.clear())

        if head == "midi":
            sub = parts[1] if n > 1 else ""
            if sub == "status" and method == "GET":
                return self._json(a.midi.status())
            if sub == "stream" and method == "GET":
                return self._stream()
            if sub == "inputs" and method == "POST":
                body = self._read_json()
                wanted = body.get("wanted")
                return self._json(a.midi.set_wanted(None if wanted is None else [str(w) for w in wanted]))
            if sub == "send" and method == "POST":
                body = self._read_json()
                return self._json({"queued": a.midi.send(str(body.get("port")), body.get("events") or [])})
            if sub == "flush" and method == "POST":
                return self._json(a.midi.flush())
            if sub == "clock" and method == "POST":
                body = self._read_json()
                return self._json(a.midi.clock(str(body.get("action")), body.get("bpm"),
                                               [str(p) for p in body.get("ports") or []],
                                               bool(body.get("clock", True))))

        if head == "midinous":
            sub = parts[1] if n > 1 else ""
            if sub == "status" and method == "GET":
                return self._json(a.midinous.status())
            if sub == "files" and method == "GET":
                return self._json(a.midinous.files())
            if sub == "midi" and method == "GET":
                f = a.midinous.midi_file(query.get("name", ""), query.get("source", "midi"))
                return self._file(f, "audio/midi")
            if sub == "render" and method == "POST":
                return self._json(a.midinous.render(self._read_json()))
            if sub == "export" and method == "POST":
                return self._json(a.midinous.export(self._read_json()))

        if head == "export":
            sub = parts[1] if n > 1 else ""
            if sub == "formats" and method == "GET":
                return self._json(a.encoder.status())
            if sub == "progress" and method == "GET":
                return self._json({"progress": a.encoder.jobs.get(query.get("job", ""))})
            if sub == "encode" and method == "POST":
                self.close_connection = True  # an early error leaves the body unread
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > MAX_UPLOAD:
                    raise ApiError(413, "The mixdown is empty or too large")
                fmt = query.get("format", "")
                data = a.encoder.encode(fmt, query, self.rfile, length)
                return self._send(200, data, ENCODE_FORMATS[fmt][0], {"Cache-Control": "no-store"})

        raise ApiError(404, f"No API route {method} /api/{'/'.join(parts)}")

    def _stream(self) -> None:
        """Server-Sent Events: MIDI input, port changes, clock tempo."""
        q = APP.midi.subscribe()
        self.close_connection = True
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(f"data: {json.dumps({'type': 'ports', **APP.midi.status()})}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    line = q.get(timeout=15)
                    chunk = [line]
                    while len(chunk) < 64:
                        try:
                            chunk.append(q.get_nowait())
                        except queue.Empty:
                            break
                    self.wfile.write("".join(f"data: {c}\n\n" for c in chunk).encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            APP.midi.unsubscribe(q)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    global APP
    ap = argparse.ArgumentParser(description="BasicDAW")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("BASICDAW_PORT", 8765)))
    ap.add_argument("--no-browser", action="store_true", help="don't open the browser")
    args = ap.parse_args()
    if sys.stdout:  # None in a Windows GUI build
        sys.stdout.reconfigure(line_buffering=True)

    APP = App()
    try:
        httpd = Server((args.host, args.port), Handler)
    except OSError as exc:
        sys.exit(f"Could not listen on {args.host}:{args.port} ({exc}). Try --port <other>.")
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}/"
    midi = APP.midi.status()
    print("\n  ✦ BasicDAW")
    print(f"    open      {url}")
    print(f"    projects  {PROJECTS_DIR}")
    print(f"    cache     {CACHE_DIR}")
    ports = f" ({midi['virtualIn']} / {midi['virtualOut']})" if midi["virtualIn"] else ""
    print(f"    MIDI      {'bridge ready' + ports if midi['available'] else midi['error']}")
    print(f"    Midinous  {'engine loaded' if APP.midinous.engine else APP.midinous.error}\n")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\n  bye ✦")


if __name__ == "__main__":
    main()
