"""vPilot bridge: talks to the Clearway plugin running inside vPilot.

The plugin polls ``GET /api/vpilot/outbox`` every second (heartbeat + commands for vPilot)
and posts what happens in vPilot to ``POST /api/vpilot/event``. This mixin keeps the vPilot
state for the Session: network connection, chats, nearby controllers and transponder.
"""
from __future__ import annotations

import logging
import math
import re
import threading
import time

from .textfix import repair

log = logging.getLogger("clearway.vpilot")

VPILOT_TIMEOUT = 8            # seconds without a plugin heartbeat before it counts as gone
LONG_POLL = 4                 # the plugin's outbox request waits up to this long for a command
VP_KINDS = {"pm", "radio", "broadcast", "selcal", "vinfo", "vsys"}
FREQ = "FREQ"                 # chat id of the main frequency chat
# (1.5.0) a controller asking you to call them ("Please contact me on 128.275"): the panel shows its peek by itself
CONTACT_ME = re.compile(r"\bcontact\s+me\b", re.I)

# vPilot dot commands that plugins can't perform (vPilot doesn't expose them)
NOT_AVAILABLE = {
    ".x": "setting the squawk code", ".xpdr": "setting the squawk code", ".xpndr": "setting the squawk code",
    ".sq": "setting the squawk code", ".squawk": "setting the squawk code",
    ".com1": "tuning COM1", ".com2": "tuning COM2", ".com": "choosing the transmit radio",
    ".ctaf": "CTAF lookups", ".towerview": "tower view", ".aircraft": "the aircraft window",
    ".debug": "the debug window", ".reloadrules": "reloading model rules",
    ".ignore": "the ignore list", ".unignore": "the ignore list",
}

HELP = (".chat CALLSIGN · .msg CALLSIGN text · .close · .atis CALLSIGN · .wx/.metar ICAO · "
        ".wallop text · .clear · .copy · .modec · .standby · .ident · .connect · .disconnect")


def distance_nm(lat1, lon1, lat2, lon2) -> float:
    r = 3440.065
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


class VpilotMixin:
    """Mixed into Session. Expects: lock, messages, cfg, _add, _system, _bump, _find, _notify,
    connect, status, callsign, position."""

    def _vp_init(self) -> None:
        self.vpilot_seen = 0.0
        self.vpilot_connected = False
        self.vpilot_observer = False          # connected as an observer (can listen, not transmit)
        self.vpilot_callsign = ""
        self.vp_controllers: list[dict] = []
        self.vp_info: dict[str, dict] = {}       # controller callsign -> {lines, ts} (their controller info)
        self._quiet_info: set[str] = set()       # info requested from the ATC list: show there, not in the chat
        self.vp_modec: bool | None = None       # last Mode C state we set (vPilot can't report it)
        self.outbox: list[dict] = []
        self._next_out = 1
        self._outbox_event = threading.Event()   # wakes a waiting plugin request instantly
        self.com: dict | None = None             # COM radios, read by the MSFS panel
        self.vpilot_running: bool | None = None  # vPilot.exe open on this PC (None = not checked yet)
        self._vp_starting = 0.0                  # vPilot launched from the panel at this time
        self.vpilot_proc_wake = threading.Event()   # asks the process watcher to look again now

    # ------------------------------------------------------------ vPilot program (start button in the panel)
    def set_vpilot_running(self, running: bool) -> None:
        if running != self.vpilot_running:
            with self.lock:
                self.vpilot_running = running
                if running:
                    self._vp_starting = 0.0
                self._bump()

    def vpilot_launch(self) -> str:
        """Start vPilot minimized in the background. Returns '' or a reason it couldn't."""
        from clearway.procs import find_vpilot, launch_background
        if self.vpilot_running:
            return "vPilot is already open"
        if time.time() - self._vp_starting < 30:
            return "vPilot is starting..."
        path = find_vpilot(str(self.cfg.get("vpilot_path") or ""))
        if not path:
            return "vPilot not found on this PC: open it once yourself so Clearway learns where it is"
        try:
            launch_background(path)
        except OSError as exc:
            log.warning("Couldn't start vPilot: %s", exc)
            return "Couldn't start vPilot"
        log.info("vPilot started from the panel: %s", path)
        with self.lock:
            self._vp_starting = time.time()
            self._bump()
        threading.Timer(3, self.vpilot_proc_wake.set).start()   # green as soon as it's up
        return ""

    def vpilot_close(self) -> str:
        """Close vPilot like clicking its X (it disconnects and shuts down normally). Returns '' or a reason."""
        import os
        from clearway.procs import close_windows
        if not self.vpilot_running and not self.vpilot_active():
            return "vPilot isn't open"
        try:
            asked = close_windows(os.environ.get("CLEARWAY_VPILOT_EXE", "vPilot.exe"))
        except OSError as exc:
            log.warning("Couldn't close vPilot: %s", exc)
            asked = 0
        if not asked:
            return "Couldn't close vPilot: close it yourself"
        log.info("vPilot asked to close from the panel")
        for delay in (2, 5):                                      # red as soon as it's gone
            threading.Timer(delay, self.vpilot_proc_wake.set).start()
        return ""

    # ------------------------------------------------------------ plugin side
    def vpilot_active(self) -> bool:
        return time.time() - self.vpilot_seen < VPILOT_TIMEOUT

    def vpilot_poll(self, connected: bool, callsign: str, cid: str, observer: bool = False) -> list[dict]:
        """Heartbeat from the plugin; returns the commands it should run in vPilot.
        When nothing is queued the request waits (up to LONG_POLL seconds), so a command
        typed in Clearway reaches vPilot immediately instead of at the next poll."""
        items = self._vpilot_take(connected, callsign, observer)
        if not items:
            self._outbox_event.wait(LONG_POLL)
            items = self._vpilot_take(connected, callsign, observer)
        return items

    def _vpilot_take(self, connected: bool, callsign: str, observer: bool = False) -> list[dict]:
        was_active = self.vpilot_active()
        with self.lock:
            self.vpilot_seen = time.time()
            callsign = callsign.upper() if connected else ""
            observer = observer and connected
            if (not was_active or connected != self.vpilot_connected or callsign != self.vpilot_callsign
                    or observer != self.vpilot_observer):
                self.vpilot_connected = connected
                self.vpilot_observer = observer
                self.vpilot_callsign = callsign
                self._bump()
            now = time.time()
            self._outbox_event.clear()
            items = []
            for item in self.outbox:
                if not item.get("handed"):
                    item["handed"] = now
                    items.append({k: v for k, v in item.items() if k not in ("msg_id", "handed", "label")})
            for item in [i for i in self.outbox if i.get("handed") and now - i["handed"] > 15]:
                self._mark_outbox(item, False, "vPilot didn't confirm it.")
        if not was_active:
            log.info("vPilot plugin connected")
            if connected:
                self._maybe_auto_connect()
        return items

    def vpilot_sent(self, out_id: int, ok: bool, error: str) -> None:
        with self.lock:
            item = next((i for i in self.outbox if i["id"] == out_id), None)
        if item:
            self._mark_outbox(item, ok, error)

    def _mark_outbox(self, item: dict, ok: bool, error: str = "") -> None:
        with self.lock:
            if item in self.outbox:
                self.outbox.remove(item)
            m = self._find(item["msg_id"]) if item.get("msg_id") else None
            if m:
                m["status"] = "none" if ok else "failed"
                m["error"] = error
            self._bump()
        if not ok and not item.get("msg_id"):
            self._system(f"{item.get('label', 'vPilot command')} failed: {error}", vp=True)

    def vpilot_event(self, evt: dict) -> None:
        kind = str(evt.get("type", ""))
        sender = str(evt.get("from", "")).upper()
        text = repair(str(evt.get("message", "")).strip())     # "Ã©" -> "é"
        with self.lock:
            self.vpilot_seen = time.time()
        if kind == "connected":
            with self.lock:
                self.vpilot_connected = True
                self.vpilot_observer = bool(evt.get("observer"))
                self.vpilot_callsign = str(evt.get("callsign", "")).upper()
                self.vp_modec = None
                self._bump()
            # remember the details for the Connect button
            remember = {"vpilot_callsign": self.vpilot_callsign, "vpilot_observer": self.vpilot_observer}
            if not self.vpilot_observer:          # an observer connection has no aircraft type / SELCAL
                remember.update({"vpilot_type": str(evt.get("type_code", "")), "vpilot_selcal": str(evt.get("selcal", ""))})
            self.cfg.update(remember)
            self._system(f"Connected to VATSIM as {self.vpilot_callsign}"
                         f"{' (observer)' if self.vpilot_observer else ''}.", vp=True)
            self._maybe_auto_connect()
        elif kind == "disconnected":
            with self.lock:
                self.vpilot_connected = False
                self.vpilot_observer = False
                self.vp_controllers = []
                self.vp_info = {}
                self.vp_modec = None
                self._bump()
            self._system("Disconnected from VATSIM.", vp=True)
        elif kind == "pm":
            # urgent 1: "contact me" (the panel opens its peek by itself, ahead of everything); urgent 2: SELCAL
            extra = {"urgent": 1} if CONTACT_ME.search(text) else {}
            self._notify(self._add("in", "pm", sender, text, chat=sender, **extra))
        elif kind == "broadcast":
            self._notify(self._add("in", "broadcast", sender, text, chat=FREQ))
        elif kind == "selcal":
            freqs = str(evt.get("frequencies", ""))
            msg = self._add("in", "selcal", sender, f"SELCAL alert{' on ' + freqs if freqs else ''}", chat=FREQ, urgent=2)
            self._notify(msg, priority=5)
        elif kind == "radio":
            me = self.vpilot_callsign or self.callsign
            mentioned = bool(me) and me in text.upper()
            alert = mentioned or bool(self.cfg.get("vpilot_all_frequency"))
            # frequency text for others isn't "unread" (no counters, no notification), but it's new until you look at
            # the frequency chat: the panel icon shows a small grey dot for it ("quiet")
            msg = self._add("in", "radio", sender, text, chat=FREQ, freq=str(evt.get("frequencies", "")),
                            mention=mentioned, acked=not alert, quiet=not alert)
            if alert:
                self._notify(msg)
        elif kind == "atis":
            lines = [repair(str(x)) for x in (evt.get("lines") or [])]
            with self.lock:
                self.vp_info[sender] = {"lines": lines, "ts": time.time()}
                quiet = sender in self._quiet_info
                self._quiet_info.discard(sender)
                self._bump()
            if not quiet:   # typed .atis: show it in the frequency chat as before
                body = "\n".join(lines) or "(no controller information)"
                self._add("in", "vinfo", sender, body, chat=FREQ, acked=True)
        elif kind == "metar":
            self._add("in", "vinfo", "METAR", str(evt.get("metar", "")).strip(), chat=FREQ, acked=True)
        elif kind == "controllers":
            with self.lock:
                self.vp_controllers = [
                    {"callsign": str(c.get("callsign", "")).upper(), "frequency": str(c.get("frequency", "")),
                     "lat": c.get("lat"), "lon": c.get("lon")}
                    for c in (evt.get("list") or []) if isinstance(c, dict)
                ]
                self._bump()

    def _maybe_auto_connect(self) -> None:
        if (self.cfg.get("vpilot_auto_connect") and self.status in ("offline", "error")
                and self.cfg.get("hoppie_logon") and self.vpilot_connected and not self.vpilot_observer):
            self._system("Connecting to Hoppie automatically (vPilot is online).")
            self.connect()

    # ------------------------------------------------------------ commands for vPilot
    def _require_vpilot(self, connected: bool = True) -> None:
        if not self.vpilot_active():
            raise ValueError("The Clearway plugin for vPilot isn't running. Install it and restart vPilot.")
        if connected and not self.vpilot_connected:
            raise ValueError("vPilot isn't connected to VATSIM.")

    def _queue(self, kind: str, msg_id: int | None = None, label: str = "", **fields) -> None:
        with self.lock:
            self.outbox.append({"id": self._next_out, "type": kind, "msg_id": msg_id, "label": label, **fields})
            self._next_out += 1
            self._bump()
        self._outbox_event.set()

    def send_text(self, kind: str, to: str, text: str, ack_id: int | None = None) -> None:
        """Send a private message ("pm") or a frequency text message ("radio") through vPilot."""
        self._require_vpilot()
        text = " ".join(text.strip().split())
        to = to.strip().upper()
        if not text:
            raise ValueError("Empty message.")
        if kind == "pm" and not to:
            raise ValueError("Enter who the message is for (a callsign).")
        if kind != "pm" and self.vpilot_observer and self.vpilot_connected:
            raise ValueError("Observers can't transmit on the frequency: send a private message instead.")
        with self.lock:
            me = self.vpilot_callsign or "YOU"
            msg = self._add("out", kind, to if kind == "pm" else me, text, status="sending",
                            chat=to if kind == "pm" else FREQ)
            if ack_id is not None:
                m = self._find(ack_id)
                if m:
                    m["acked"] = True
                    m["reply"] = text
        self._queue(kind, msg_id=msg["id"], to=to, text=text)

    def vpilot_connect(self, callsign: str, type_code: str, selcal: str, observer: bool = False) -> None:
        self._require_vpilot(connected=False)
        if self.vpilot_connected:
            raise ValueError("vPilot is already connected.")
        callsign, type_code, selcal = callsign.strip().upper(), type_code.strip().upper(), selcal.strip().upper()
        tones = "".join(ch for ch in selcal if ch.isalnum())
        if len(tones) == 4:
            selcal = tones[:2] + "-" + tones[2:]          # always AB-CD, like vPilot's own connect window
        if not callsign:
            raise ValueError("Enter a callsign.")
        if not observer and not type_code:
            raise ValueError("Enter a callsign and an aircraft type.")
        self.cfg.update({"vpilot_callsign": callsign, "vpilot_observer": bool(observer)})
        if not observer:
            self.cfg.update({"vpilot_type": type_code, "vpilot_selcal": selcal})
        self._queue("connect", label="Connect", callsign=callsign, type_code=type_code, selcal=selcal, observer=bool(observer))
        self._system(f"Connecting vPilot as {callsign}{' (observer)' if observer else ''}…", vp=True)

    def vpilot_disconnect(self) -> None:
        self._require_vpilot()
        self._queue("disconnect", label="Disconnect")

    def vpilot_modec(self, on: bool) -> None:
        self._require_vpilot()
        self._queue("modec", label="Mode C" if on else "Standby", on=bool(on))
        with self.lock:
            self.vp_modec = bool(on)
            # counted, so the MSFS panel also sets the aircraft's transponder (vPilot follows the sim's), even
            # when the request came from the phone
            self.vp_modec_n = getattr(self, "vp_modec_n", 0) + 1
            self.vp_modec_req = bool(on)           # what was asked (vp_modec can be reset by vPilot events)
            self._bump()

    def vpilot_ident(self) -> None:
        self._require_vpilot()
        self._queue("ident", label="Ident")
        with self.lock:
            self.vp_ident_n = getattr(self, "vp_ident_n", 0) + 1
            self._bump()
        self._system("Ident sent.", vp=True)

    def vpilot_atis(self, callsign: str, quiet: bool = False) -> None:
        """Ask a controller for their information. quiet=True (expanding them in the ATC list)
        shows the answer in the list only, without adding it to the frequency chat."""
        self._require_vpilot()
        callsign = callsign.strip().upper()
        if not callsign:
            raise ValueError("Enter a controller callsign.")
        if quiet:
            with self.lock:
                self._quiet_info.add(callsign)
                self.vp_info.setdefault(callsign, {"lines": None, "ts": 0})["pending"] = True
                self._bump()
        self._queue("atis", label=f"Info request to {callsign}", callsign=callsign)
        if not quiet:
            self._system(f"Requesting controller information from {callsign}…", vp=True)

    def vpilot_metar(self, station: str) -> None:
        self._require_vpilot()
        station = station.strip().upper()
        if not station:
            raise ValueError("Enter an airport code.")
        self._queue("metar", label=f"METAR {station}", station=station)

    def clear_chat(self, chat: str) -> None:
        with self.lock:
            removed = [m for m in self.messages if m.get("chat") == chat and m["kind"] in VP_KINDS]
            self.messages = [m for m in self.messages if m not in removed]
            self._to_trash(removed)
            self._bump()

    # ------------------------------------------------------------ dot commands
    def vpilot_command(self, text: str, chat: str) -> dict:
        """Run what was typed in a vPilot chat: plain text is sent, dot commands are executed.
        Returns hints for the UI, e.g. {"open": "EGLL_TWR"}, {"close": True} or {"copy": True}."""
        text = text.strip()
        chat = (chat or FREQ).upper()
        if not text:
            raise ValueError("Type a message or a command.")
        if not text.startswith("."):
            if chat == FREQ:
                self.send_text("radio", "", text)
            else:
                self.send_text("pm", chat, text)
            return {}

        parts = text.split(None, 2)
        cmd = parts[0].lower()
        arg1 = parts[1] if len(parts) > 1 else ""
        rest = text.split(None, 1)[1] if len(parts) > 1 else ""
        if cmd in NOT_AVAILABLE:
            raise ValueError(f"vPilot doesn't let plugins control {NOT_AVAILABLE[cmd]}. Use {cmd} in vPilot's own window.")
        if cmd == ".chat":
            if not arg1:
                raise ValueError("Usage: .chat CALLSIGN")
            return {"open": arg1.upper()}
        if cmd == ".msg":
            if len(parts) < 3:
                raise ValueError("Usage: .msg CALLSIGN message")
            self.send_text("pm", arg1, parts[2])
            return {"open": arg1.upper()}
        if cmd == ".close":
            return {"close": True}
        if cmd == ".clear":
            self.clear_chat(chat)
            return {}
        if cmd == ".copy":
            return {"copy": True}
        if cmd == ".atis":
            self.vpilot_atis(arg1)
            return {}
        if cmd in (".wx", ".metar"):
            self.vpilot_metar(arg1)
            return {}
        if cmd == ".wallop":
            if not rest:
                raise ValueError("Usage: .wallop message")
            self._require_vpilot()
            with self.lock:
                msg = self._add("out", "pm", "SUPERVISORS", rest, status="sending", chat=FREQ)
            self._queue("pm", msg_id=msg["id"], to="*S", text=rest)
            return {}
        if cmd in (".modec", ".c"):
            self.vpilot_modec(True)
            return {}
        if cmd in (".standby", ".sby"):
            self.vpilot_modec(False)
            return {}
        if cmd == ".ident":
            self.vpilot_ident()
            return {}
        if cmd == ".disconnect":
            self.vpilot_disconnect()
            return {}
        if cmd == ".connect":
            words = text.split()[1:]
            cs = words[0] if words else self.cfg.get("vpilot_callsign")
            tc = words[1] if len(words) > 1 else self.cfg.get("vpilot_type")
            sc = words[2] if len(words) > 2 else self.cfg.get("vpilot_selcal")
            self.vpilot_connect(cs or "", tc or "", sc or "")
            return {}
        if cmd in (".help", ".?"):
            self._system("Commands: " + HELP, vp=True)
            return {}
        raise ValueError(f"Unknown command {cmd}. Type .help for the list.")

    def set_com(self, data: dict) -> None:
        """COM radio state from the MSFS panel (vPilot doesn't share it with plugins)."""
        def radio(n):
            return {"active": str(data.get(f"com{n}", "")), "standby": str(data.get(f"com{n}_stby", "")),
                    "tx": bool(data.get(f"com{n}_tx"))}
        with self.lock:
            new = {"com1": radio(1), "com2": radio(2)}
            changed = not self.com or {k: v for k, v in self.com.items() if k != "ts"} != new
            self.com = {**new, "ts": time.time()}
            if changed:
                self._bump()

    # ------------------------------------------------------------ snapshot
    def vpilot_snapshot(self) -> dict:
        pos = self.position
        ctrls = []
        feed = getattr(self, "_feed", None)
        names = feed.get("names", {}) if feed else {}   # from the VATSIM data (vPilot doesn't give names)
        for c in self.vp_controllers:
            item = dict(c)
            if names.get(c["callsign"]):
                item["name"] = names[c["callsign"]]
            if pos and c.get("lat") is not None and c.get("lon") is not None:
                try:
                    item["distance"] = round(distance_nm(pos["lat"], pos["lon"], float(c["lat"]), float(c["lon"])))
                except (TypeError, ValueError):
                    pass
            item.pop("lat", None)
            item.pop("lon", None)
            info = self.vp_info.get(c["callsign"])
            if info:
                item["info"] = info.get("lines")
                item["info_age"] = int(time.time() - info["ts"]) if info.get("ts") else None
                item["info_pending"] = bool(info.get("pending")) and info.get("lines") is None
            ctrls.append(item)
        ctrls.sort(key=lambda c: (c.get("distance", 99999), c["callsign"]))
        return {
            "running": True if self.vpilot_active() else self.vpilot_running,   # vPilot.exe open (None: unknown)
            "starting": not self.vpilot_running and time.time() - self._vp_starting < 30,
            "active": self.vpilot_active(),
            # without a plugin heartbeat the last known state is stale: report "not connected"
            "connected": self.vpilot_connected and self.vpilot_active(),
            "callsign": self.vpilot_callsign if self.vpilot_active() else "",
            "observer": self.vpilot_observer and self.vpilot_connected and self.vpilot_active(),
            "modec": self.vp_modec,
            "modec_n": getattr(self, "vp_modec_n", 0),
            "modec_req": getattr(self, "vp_modec_req", None),
            "ident_n": getattr(self, "vp_ident_n", 0),
            "com": ({k: v for k, v in self.com.items() if k != "ts"}
                    if self.com and time.time() - self.com["ts"] < 15 else None),
            "controllers": ctrls,
            "last": {"callsign": self.cfg.get("vpilot_callsign") or "", "type": self.cfg.get("vpilot_type") or "",
                     "selcal": self.cfg.get("vpilot_selcal") or "",
                     "observer": bool(self.cfg.get("vpilot_observer"))},
        }
