"""Local HTTP server: serves the web app and the JSON API used by the phone and the MSFS panel."""
from __future__ import annotations

import gzip
import hashlib
import ipaddress
import json
import logging
import mimetypes
import re
import socket
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .keyhook import KeyCapture
from .radar import Radar
from .session import Session

log = logging.getLogger("clearway.server")


def web_root() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "web"


def lan_ip() -> str:
    """Best guess of this PC's address on the home network (no traffic is sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


ASSET_RE = re.compile(r'\b(src|href)="((?!https?:|//)[^"?#]+\.(?:js|css))"')
_web_version = ""


def web_version() -> str:
    """Short hash of the web app's scripts and styles (changes whenever one of them does)."""
    global _web_version
    if not _web_version:
        h = hashlib.sha1()
        for f in sorted(web_root().rglob("*")):
            if f.is_file() and f.suffix in (".js", ".css"):
                h.update(f.name.encode()); h.update(f.read_bytes())
        _web_version = h.hexdigest()[:10]
    return _web_version


def pc_name_url(port: int) -> str:
    """http://<pc-name>.local:<port>: the address that survives the PC getting a new IP (the phone finds the PC
    by name on the Wi-Fi, through mDNS). Empty when the PC's name can't be used that way."""
    name = socket.gethostname().split(".")[0].lower()
    if not name or len(name) > 63 or not all(c.isalnum() or c == "-" for c in name) or name.startswith("-"):
        return ""
    return f"http://{name}.local:{port}"


class Handler(BaseHTTPRequestHandler):
    server_version = "Clearway"
    # HTTP/1.1 keeps a phone's (or the panel's) connection open between its updates instead of opening a new one
    # every 1.5 s: with the PC's .local name each new connection can cost a name lookup. Idle connections close
    # after `timeout` seconds. Every response sends Content-Length.
    protocol_version = "HTTP/1.1"
    timeout = 30
    session: Session = None  # set by make_server
    keys: KeyCapture = None
    radar: Radar = None

    def handle(self):
        # Safari first tries https:// for a name like desktop-xxx.local. Clearway only speaks http, so hang up on a
        # TLS handshake at once (first byte 0x16): Safari then moves on to http straight away instead of waiting.
        try:
            first = self.connection.recv(1, socket.MSG_PEEK)
        except OSError:
            return
        if first == b"\x16":
            log.debug("%s - https attempt refused (Clearway speaks http)", self.client_address[0])
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return
        super().handle()

    # Keep the console clean; errors still go to the log file.
    def log_message(self, fmt, *args):
        log.debug("%s - %s", self.address_string(), fmt % args)

    # ------------------------------------------------------------ helpers
    def _is_local(self) -> bool:
        try:
            return ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            return False

    def _authorized(self, query: dict) -> bool:
        if self._is_local():
            return True
        key = self.headers.get("X-Clearway-Key") or (query.get("k") or [""])[0]
        return key == self.session.cfg.get("pair_key")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Clearway-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _raw(self, status: int, body: bytes, ctype: str, cache: str):
        """Pre-encoded radar data and map tiles (large JSON is gzipped when the client accepts it)."""
        gz = ctype == "application/json" and len(body) > 2048 and "gzip" in (self.headers.get("Accept-Encoding") or "")
        if gz:
            body = gzip.compress(body, 5)
        self.send_response(status)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype == "application/json" else ""))
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(body)))
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        if length > 64_000:
            self.close_connection = True       # the unread rest would spoil the next request on this connection
        raw = self.rfile.read(min(length, 64_000))
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except ValueError:
            return {}

    # ------------------------------------------------------------ verbs
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        if url.path == "/api/hello":
            # the phone app checks whether it can reach this Clearway by the PC's name (and that it's the
            # same one: "paired" only with the right pairing key)
            return self._json({"app": "clearway", "paired": self._authorized(query)})
        if url.path == "/api/state":
            if not self._authorized(query):
                return self._json({"error": "pair"}, 401)
            if (query.get("panel") or ["0"])[0] == "1":
                self.session.panel_seen = time.time()
                self.session.panel_paused = (query.get("paused") or ["0"])[0] == "1"
            since = (query.get("since") or ["0"])[0]
            if since.isdigit() and int(since) == self.session.version:
                return self._json({"version": self.session.version, "unchanged": True,
                                   "panel_active": self.session.panel_active()})
            snap = self.session.snapshot()
            if not self._is_local():
                snap["settings"].pop("port", None)
            return self._json(snap)
        if url.path == "/api/vpilot/outbox":
            if not self._is_local():
                return self._json({"error": "only available on this PC"}, 403)
            q = lambda k: (query.get(k) or [""])[0]  # noqa: E731
            items = self.session.vpilot_poll(q("connected") == "1", q("callsign"), q("cid"), q("observer") == "1")
            return self._json({"ok": True, "items": items})
        if url.path == "/api/selcal/airlines":     # airline names and logos for the SELCAL tab
            from .selcal import AIRLINES
            return self._json({"ok": True, "airlines": AIRLINES})
        if url.path.startswith("/api/radar/"):      # Radar tab (panel) - see radar.py
            if not self._authorized(query):
                return self._json({"error": "pair"}, 401)
            try:
                status, body, ctype, cache = self.radar.handle(url.path[len("/api/radar/"):], query)
            except Exception as exc:
                log.debug("radar request failed: %s", exc)
                return self._json({"error": str(exc)}, 502)
            return self._raw(status, body, ctype, cache)
        if url.path == "/api/keys":                 # MSFS panel: keys typed while it holds the keyboard
            if not self._is_local():
                return self._json({"error": "only available on this PC"}, 403)
            since = (query.get("since") or ["0"])[0]
            return self._json(self.keys.poll(int(since) if since.isdigit() else 0))
        if url.path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        return self._static(url.path)

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        body = self._read_body()               # always read first: the connection stays open for the next request
        if not url.path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        if not self._authorized(query):
            return self._json({"error": "pair"}, 401)
        action = url.path[len("/api/"):]
        s = self.session
        if (action.startswith("vpilot/") or action.startswith("keys/")) and not self._is_local():
            return self._json({"error": "only available on this PC"}, 403)
        if action == "keys/capture":
            active = self.keys.set_capture(bool(body.get("on")))
            return self._json({"ok": True, "active": active, "seq": self.keys.seq})
        try:
            if action == "quick":            # tapped button on a phone notification
                s.reply(int(query["id"][0]), query["r"][0])
            elif action == "connect":
                s.connect()
            elif action == "disconnect":
                s.disconnect()
            elif action == "reply":
                s.reply(int(body["id"]), str(body.get("text", "")))
            elif action == "ack":
                s.ack(int(body["id"]) if body.get("id") is not None else None,
                      chat=str(body["chat"]).upper() if body.get("chat") else None, scope=body.get("scope"))
            elif action == "unack":
                s.unack(int(body["id"]))
            elif action == "logon":
                s.logon(str(body.get("station", "")))
            elif action == "logoff":
                s.logoff()
            elif action == "cpdlc":
                s.send_cpdlc(body.get("station"), str(body.get("text", "")), str(body.get("ra", "Y")).upper())
            elif action == "telex":
                s.send_telex(str(body.get("station", "")), str(body.get("text", "")))
            elif action == "inforeq":
                s.inforeq(str(body.get("what", "")), str(body.get("icao", "")))
            elif action == "clear":
                s.clear_history()
            elif action == "vpilot/event":         # from the vPilot plugin
                s.vpilot_event(body)
            elif action == "vpilot/sent":
                s.vpilot_sent(int(body["id"]), bool(body.get("ok")), str(body.get("error", "")))
            elif action == "text":                 # send a private / frequency message through vPilot
                s.send_text(str(body.get("kind", "pm")), str(body.get("to", "")), str(body.get("text", "")))
            elif action == "vp/command":           # what was typed in a vPilot chat (text or dot command)
                hints = s.vpilot_command(str(body.get("text", "")), str(body.get("chat", "FREQ")))
                return self._json({"ok": True, "version": s.version, **hints})
            elif action == "vp/connect":
                s.vpilot_connect(str(body.get("callsign", "")), str(body.get("type_code", "")), str(body.get("selcal", "")),
                                 bool(body.get("observer")))
            elif action == "vp/disconnect":
                s.vpilot_disconnect()
            elif action == "vp/launch":            # the panel's vPilot start button
                err = s.vpilot_launch()
                if err:
                    return self._json({"ok": False, "error": err}, 409)
            elif action == "vp/close":             # the same button while vPilot is open (after a confirmation)
                err = s.vpilot_close()
                if err:
                    return self._json({"ok": False, "error": err}, 409)
            elif action == "vp/modec":
                s.vpilot_modec(bool(body.get("on", True)))
            elif action == "vp/ident":
                s.vpilot_ident()
            elif action == "vp/atis":
                s.vpilot_atis(str(body.get("callsign", "")), quiet=bool(body.get("quiet")))
            elif action == "vp/clear":
                s.clear_chat(str(body.get("chat", "FREQ")).upper())
            elif action == "com":                  # COM radios from the MSFS panel
                s.panel_seen = time.time()
                s.set_com(body)
            elif action == "selcal/generate":      # SELCAL tab
                return self._json({"ok": True, "current": s.selcal_generate(str(body.get("callsign", ""))), "version": s.version})
            elif action == "selcal/check":
                return self._json({"ok": True, **s.selcal_check(str(body.get("code", "")), bool(body.get("remember", True)),
                                                                str(body.get("exclude", "")))})
            elif action == "selcal/save":
                s.selcal_save(str(body.get("callsign", "")), int(body.get("generated") or 0),
                              body.get("std"), body.get("ext"))
            elif action == "selcal/remove":
                s.selcal_remove(str(body.get("callsign", "")), int(body.get("generated") or 0))
            elif action == "selcal/simbrief":
                user = body.get("user")
                return self._json({"ok": True, "ofp": s.simbrief_fetch(None if user is None else str(user)), "version": s.version})
            elif action == "selcal/use":
                return self._json({"ok": True, "code": s.selcal_use(str(body.get("code", ""))), "version": s.version})
            elif action == "notes":
                s.save_notes(str(body.get("text", "")))
            elif action == "delete":
                s.delete(int(body["id"]))
            elif action == "restore":
                s.restore(int(body["id"]) if body.get("id") is not None else None)
            elif action == "collapse":
                s.collapse(int(body["id"]) if body.get("id") is not None else None, bool(body.get("collapsed", True)))
            elif action == "position":
                s.panel_seen = time.time()
                s.set_panel_position(float(body["lat"]), float(body["lon"]), float(body.get("alt", 0)))
            elif action == "settings":
                data = dict(body)
                if not data.get("hoppie_logon"):
                    data.pop("hoppie_logon", None)   # empty field = keep the saved code
                s.cfg.update(data)
                s._bump()
            elif action == "panel_reset":           # (1.5.0) Settings: put the panel's icon and windows back in view
                s.panel_reset = int(time.time() * 1000)
                s._bump()
            elif action == "pair":
                if not self._is_local():
                    return self._json({"error": "only available on this PC"}, 403)
                return self._json({"ok": True, "key": s.cfg.get("pair_key")})
            elif action == "test-notification":
                s.test_notification()
            elif action == "new-topic":
                s.cfg.regenerate_topic()
                s._bump()
            else:
                return self._json({"error": "unknown action"}, 404)
        except (KeyError, TypeError, ValueError) as exc:
            msg = str(exc) if isinstance(exc, ValueError) else "Bad request."
            return self._json({"ok": False, "error": msg}, 400)
        except Exception as exc:
            log.exception("API error")
            return self._json({"ok": False, "error": f"Internal error: {exc}"}, 500)
        return self._json({"ok": True, "version": s.version})

    def _static(self, path: str):
        root = web_root()
        rel = path.lstrip("/") or "index.html"
        target = (root / rel).resolve()
        if root.resolve() not in target.parents and target != root.resolve():
            return self._json({"error": "not found"}, 404)
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            target = root / "index.html"   # single-page app fallback
        data = target.read_bytes()
        page = target.name == "index.html"
        if page:
            # Scripts and styles get an address that changes with their content (app.js?v=…), so a phone never
            # runs scripts cached from an older Clearway with the new page (iPhones keep them despite no-cache;
            # the old script then fails and pairing never completes).
            data = ASSET_RE.sub(lambda m: f'{m.group(1)}="{m.group(2)}?v={web_version()}"', data.decode("utf-8")).encode("utf-8")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".webmanifest":
            ctype = "application/manifest+json"
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype.endswith("javascript") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store" if page else "no-cache")
        self._cors()
        self.end_headers()
        self.wfile.write(data)


class _Server(ThreadingHTTPServer):
    """The port belongs to one Clearway only. Python's default (SO_REUSEADDR) lets a second program bind the same
    port on Windows, which is how two Clearways could run side by side."""
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_server(session: Session, port: int) -> ThreadingHTTPServer:
    Handler.session = session
    Handler.keys = KeyCapture(enabled=lambda: session.cfg.get("panel_capture_keys"))
    Handler.radar = Radar(session)
    server = _Server(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    return server
