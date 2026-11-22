"""The CPDLC session: polling Hoppie, message history, replies, ADS-C and notifications.

All shared state is guarded by ``self.lock``. Every change bumps ``self.version`` so
clients (phone page, MSFS panel) can cheaply ask "has anything changed?".
"""
from __future__ import annotations

import logging
import random
import re
import threading
import time
from datetime import datetime, timezone

from . import notify, vatsim
from .config import Config
from .hoppie import HoppieClient, HoppieError, Incoming, build_cpdlc, parse_cpdlc
from .tags import classify
from .selcal import SelcalMixin
from .tsat import TsatMixin
from .vpilot import FREQ, VP_KINDS, VpilotMixin

log = logging.getLogger("clearway.session")

MAX_MESSAGES = 300          # kept per category (CPDLC and vPilot chat separately)
PANEL_TIMEOUT = 12           # seconds without a panel heartbeat before it counts as closed
FAST_POLL_SECONDS = 180     # poll every 20 s for this long after sending a request
UNIT_RE = re.compile(r"_@([A-Z0-9_]+)@_")


def reply_options(msg: dict) -> list[str]:
    """Standard CPDLC answers for an inbound message, based on its response attribute."""
    if msg.get("dir") != "in" or msg.get("kind") != "cpdlc" or msg.get("status") not in ("open", "standby"):
        return []
    ra = msg.get("ra", "")
    standby = [] if msg.get("status") == "standby" else ["STANDBY"]
    if ra == "WU":
        return ["WILCO", "UNABLE"] + standby
    if ra == "AN":
        return ["AFFIRM", "NEGATIVE"] + standby
    if ra == "R":
        return ["ROGER", "UNABLE"] + standby
    if ra == "Y":
        return ["ROGER"] + standby
    return []


QUIET_TEXTS = ("LOGON", "CURRENT ATC UNIT", "CURRENT ATS UNIT", "HANDOVER", "LOGOFF", "SERVICE TERMINATED")


def quick_replies(msg: dict) -> list[str]:
    """Optional answers for an inbound message that needs none (free text from ATC, e.g. "APPROVED. REPORT BACK"):
    a ROGER button that doesn't keep the message unread like the required answers do."""
    if msg.get("dir") != "in" or msg.get("kind") != "cpdlc" or msg.get("reply") or msg.get("status") != "none":
        return []
    if msg.get("ra") not in ("NE", "N", ""):
        return []
    if str(msg.get("text", "")).upper().startswith(QUIET_TEXTS):
        return []
    return ["ROGER"]


class Session(VpilotMixin, SelcalMixin, TsatMixin):
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.lock = threading.RLock()
        self.version = 1
        self.messages: list[dict] = []
        self.trash: list[dict] = []    # deleted this session, can be restored until Clearway quits
        self._next_id = 1
        self._next_min = random.randint(1, 50)
        self.status = "offline"        # offline | connecting | online | error
        self.error = ""
        self.callsign = ""
        self.flight: dict = {}
        self.current_unit: str | None = None
        self.pending_logon: str | None = None
        self.pending_since = 0.0               # when the pending logon was sent (cancelled after LOGON_TIMEOUT)
        self.last_poll = 0.0
        self.next_poll = 0.0
        self.contracts: dict[str, dict] = {}   # station -> {interval, next_due}
        self.position: dict | None = None      # {lat, lon, alt, ts, source}
        self._vatsim_pos_ts = 0.0
        self.panel_seen = 0.0
        self.panel_paused = False              # MSFS panel notifications paused (pause button)
        self.fast_until = 0.0
        self.port = 0                           # web server port, set at start (base_url follows the current IP)
        self._base = ("", 0.0)
        self.name_url = ""                      # http://<pc-name>.local:<port> (stays valid when the IP changes)
        self._vp_init()
        self._selcal_init()
        self._tsat_init()
        self._client: HoppieClient | None = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self.notes = self._load_notes()
        threading.Thread(target=self._adsc_loop, daemon=True).start()

    # ------------------------------------------------------------ helpers
    def _bump(self) -> None:
        self.version += 1

    def _add(self, direction: str, kind: str, station: str, text: str, **extra) -> dict:
        with self.lock:
            msg = {
                "id": self._next_id,
                "ts": int(time.time() * 1000),
                "dir": direction,
                "kind": kind,
                "station": station,
                "text": text,
                "min": None, "mrn": None, "ra": "",
                "status": "none",
                "reply": None,
                "acked": direction != "in",
                "collapsed": False,
            }
            msg.update(extra)
            if msg["kind"] not in VP_KINDS and direction != "sys":
                parent = self._find(msg["linked"]) if msg.get("linked") else None
                if parent is None and msg["kind"] == "info" and direction == "in":
                    parent = next((m for m in reversed(self.messages) if m["kind"] == "info" and m["dir"] == "out"), None)
                msg["tag"] = classify(msg, parent)
            self._next_id += 1
            self.messages.append(msg)
            is_vp = msg["kind"] in VP_KINDS
            same = [m for m in self.messages if (m["kind"] in VP_KINDS) == is_vp]
            if len(same) > MAX_MESSAGES:
                drop = {id(m) for m in same[:len(same) - MAX_MESSAGES]}
                self.messages = [m for m in self.messages if id(m) not in drop]
            self._bump()
            return msg

    def _system(self, text: str, vp: bool = False) -> None:
        log.info(text)
        if vp:
            self._add("sys", "vsys", "VPILOT", text, chat=FREQ)
        else:
            self._add("sys", "system", "SYSTEM", text)

    def _take_min(self) -> int:
        with self.lock:
            n = self._next_min
            self._next_min = 1 if self._next_min >= 63 else self._next_min + 1
            return n

    def panel_active(self) -> bool:
        return time.time() - self.panel_seen < PANEL_TIMEOUT

    def _find(self, msg_id: int) -> dict | None:
        for m in self.messages:
            if m["id"] == msg_id:
                return m
        return None

    # ------------------------------------------------------------ connection
    def connect(self) -> None:
        with self.lock:
            if self.status in ("connecting", "online"):
                return
            self.status = "connecting"
            self.error = ""
            self._bump()
        threading.Thread(target=self._connect_worker, daemon=True).start()

    def _fail(self, text: str) -> None:
        with self.lock:
            self.status = "error"
            self.error = text
            self._bump()
        self._system(text)

    def _connect_worker(self) -> None:
        logon = self.cfg.get("hoppie_logon")
        cid = str(self.cfg.get("vatsim_cid") or "").strip()
        override = (self.cfg.get("callsign_override") or "").strip().upper()
        if not override and self.vpilot_connected and self.vpilot_callsign:
            override = self.vpilot_callsign        # vPilot knows the callsign before the VATSIM feed does
        if not logon:
            return self._fail("Enter your Hoppie logon code in Settings first.")
        if not cid and not override:
            return self._fail("Enter your VATSIM CID (or a callsign) in Settings first.")

        callsign, flight = override, {}
        if cid:
            try:
                pilot = vatsim.fetch_pilot(cid)
                if pilot:
                    flight = vatsim.summarize(pilot)
                    callsign = callsign or flight["callsign"]
                    self._set_vatsim_position(flight)
                elif not override:
                    return self._fail("Your CID isn't connected to VATSIM yet. Connect your pilot client, wait a minute, then try again.")
            except Exception as exc:
                if not override:
                    return self._fail(f"Couldn't reach the VATSIM data feed ({exc}).")
        if not callsign:
            return self._fail("No callsign found.")

        client = HoppieClient(self.cfg.get("hoppie_url"), logon)
        try:
            client.send(callsign, "SERVER", "ping", "")
        except HoppieError as exc:
            return self._fail(f"Hoppie refused the connection: {exc}")

        with self.lock:
            self._client = client
            self.callsign = callsign
            self.flight = flight
            self.status = "online"
            self.error = ""
            self._stop.clear()
            self._bump()
        route = f" {flight.get('departure')}→{flight.get('arrival')}" if flight.get("departure") else ""
        self._system(f"Connected to Hoppie as {callsign}{route}.")
        threading.Thread(target=self._poll_loop, daemon=True).start()

    def disconnect(self) -> None:
        with self.lock:
            if self.status != "online":
                self.status = "offline"
                self._bump()
                return
            unit = self.current_unit
            contracts = list(self.contracts.items())
        if unit:
            self._send(unit, "cpdlc", build_cpdlc(self._take_min(), None, "N", "LOGOFF"))
        for station, c in contracts:
            self._send(station, "ads-c", f"REJECT {c['interval']}")
        with self.lock:
            self._stop.set()
            self._wake.set()
            self.status = "offline"
            self.current_unit = None
            self.pending_logon = None
            self.contracts.clear()
            self._client = None
            self._bump()
        self._system("Disconnected.")

    # ------------------------------------------------------------ polling
    def _poll_loop(self) -> None:
        while not self._stop.is_set():
            self._poll_once()
            self._check_logon_timeout()
            fast = time.time() < self.fast_until
            delay = 20 if fast else random.uniform(45, 75)
            with self.lock:
                self.next_poll = time.time() + delay
                self._bump()
            self._wake.clear()
            self._wake.wait(delay)

    LOGON_TIMEOUT = 600   # a logon request still unanswered after 10 minutes is cancelled

    def _check_logon_timeout(self) -> None:
        with self.lock:
            station = self.pending_logon
            if not station or time.time() - self.pending_since < self.LOGON_TIMEOUT:
                return
            self.pending_logon = None
            for m in self.messages:            # the request card stops waiting for an answer
                if m["dir"] == "out" and m["text"] == "REQUEST LOGON" and m["station"] == station and m["status"] == "awaiting":
                    m["status"] = "none"
            self._bump()
        self._system(f"No answer from {station} after 10 minutes: logon request cancelled. Log on again when the station is online.")

    def _poll_once(self) -> None:
        with self.lock:
            client, callsign = self._client, self.callsign
        if not client:
            return
        try:
            incoming = client.send(callsign, "SERVER", "poll", "")
            with self.lock:
                self.last_poll = time.time()
                if self.error:
                    self.error = ""
                    self._system("Hoppie connection restored.")
                self._bump()
            self._handle_incoming(incoming)
        except HoppieError as exc:
            with self.lock:
                first = not self.error
                self.error = str(exc)
                self._bump()
            if first:
                self._system(f"Couldn't reach Hoppie ({exc}). Retrying automatically.")

    def _send(self, to: str, kind: str, packet: str) -> bool:
        with self.lock:
            client, callsign = self._client, self.callsign
        if not client:
            raise ValueError("Not connected.")
        try:
            incoming = client.send(callsign, to, kind, packet)
        except HoppieError as exc:
            self._system(f"Sending failed: {exc}")
            return False
        self._handle_incoming(incoming)
        return True

    def _send_logged(self, to: str, kind: str, packet: str, rec_kind: str, rec_text: str, **extra) -> dict:
        """Record an outbound message first (so instant answers sort after it), then send it."""
        msg = self._add("out", rec_kind, to, rec_text, **extra)
        if not self._send(to, kind, packet):
            with self.lock:
                msg["status"] = "failed"
                self._bump()
            raise ValueError("Hoppie didn't accept the message. Check the connection and try again.")
        return msg

    def _expect_reply(self) -> None:
        self.fast_until = time.time() + FAST_POLL_SECONDS

    # ------------------------------------------------------------ incoming
    def _handle_incoming(self, items: list[Incoming]) -> None:
        for item in items:
            try:
                if item.kind == "cpdlc":
                    self._on_cpdlc(item)
                elif item.kind == "ads-c":
                    self._on_adsc(item)
                else:
                    kind = "info" if item.sender == "SERVER" or item.kind == "inforeq" else "telex"
                    msg = self._add("in", kind, item.sender, item.packet.strip())
                    self._notify(msg)
            except Exception:
                log.exception("Failed to handle %s", item)

    def _on_cpdlc(self, item: Incoming) -> None:
        pkt = parse_cpdlc(item.packet)
        if pkt is None:
            msg = self._add("in", "telex", item.sender, item.packet)
            return self._notify(msg)

        text = pkt.text
        unit = UNIT_RE.search(text)
        upper = text.upper()

        if upper.startswith("HANDOVER"):
            nxt = text.split()[-1].strip("@_ ").upper()
            with self.lock:
                self.current_unit = None
                self.pending_logon = nxt
                self.pending_since = time.time()
                self._bump()
            self._system(f"Handover from {item.sender} to {nxt}, logging on…")
            self._send(nxt, "cpdlc", build_cpdlc(self._take_min(), None, "Y", "REQUEST LOGON"))
            self._expect_reply()
            return
        if upper.startswith("LOGON ACCEPTED"):
            # logged on: shown as a normal message from the station (icon, notification, answers the LOGON request),
            # not just a grey system line that was easy to miss
            with self.lock:
                self.current_unit = self.pending_logon or item.sender
                self.pending_logon = None
                self._bump()
        if upper.startswith("LOGON REJECTED") or upper.startswith("LOGON DENIED"):
            with self.lock:
                self.pending_logon = None
                self._bump()
        confirms_logon = False
        if unit:
            with self.lock:
                self.current_unit = unit.group(1)
                self._bump()
        if upper.startswith("CURRENT ATC UNIT") or upper.startswith("CURRENT ATS UNIT"):
            # some controller clients confirm a logon with CURRENT ATC UNIT instead of LOGON ACCEPTED: when it answers
            # the logon we're waiting for, show it as the confirmation; otherwise it's just a silent unit update
            with self.lock:
                confirms_logon = bool(self.pending_logon) and self.pending_logon == item.sender
                if confirms_logon:
                    self.pending_logon = None
                    self._bump()
            if not confirms_logon:
                return
        if upper.startswith("LOGON ACCEPTED"):
            confirms_logon = True
        if "LOGOFF" in upper:
            with self.lock:
                self.current_unit = None
                self.pending_logon = None
                self._bump()

        display = UNIT_RE.sub(lambda m: m.group(1), text).replace("_", " ").strip()
        if confirms_logon and not upper.startswith("LOGON ACCEPTED"):
            # CURRENT ATC UNIT@_@BIRD@_@REYKJAVIK CONTROL -> CURRENT ATC UNIT BIRD REYKJAVIK CONTROL
            display = re.sub(r"\s+", " ", re.sub(r"[@_]+", " ", text)).strip()
        # Many ATC clients prefix the aircraft callsign; drop it for readability.
        if self.callsign and display.upper().startswith(self.callsign + " "):
            display = display[len(self.callsign) + 1:]

        status = "open" if pkt.ra in ("WU", "AN", "R", "Y") else "none"
        with self.lock:
            linked = None
            if pkt.mrn is not None:
                for m in reversed(self.messages):
                    if m["dir"] == "out" and m["kind"] == "cpdlc" and m["min"] == pkt.mrn and m["station"] == item.sender:
                        m["status"] = "answered"
                        m["reply"] = display
                        linked = m["id"]
                        break
            if linked is None and confirms_logon:
                # the confirmation doesn't always refer to our request's number: answer the open logon request
                for m in reversed(self.messages):
                    if m["dir"] == "out" and m["text"] == "REQUEST LOGON" and m["station"] == item.sender \
                            and m["status"] == "awaiting":
                        m["status"] = "answered"
                        m["reply"] = display
                        linked = m["id"]
                        break
            msg = self._add("in", "cpdlc", item.sender, display,
                            min=pkt.min, mrn=pkt.mrn, ra=pkt.ra, status=status, linked=linked)
        self._notify(msg)

    def _on_adsc(self, item: Incoming) -> None:
        words = item.packet.upper().split()
        interval = next((int(w) for w in words if w.isdigit()), None)
        if "PERIODIC" in words and interval:
            if not self.cfg.get("adsc_enabled"):
                self._send(item.sender, "ads-c", f"REJECT {interval}")
                return
            with self.lock:
                self.contracts[item.sender] = {"interval": interval, "next_due": time.time()}
                self._bump()
            self._system(f"ADS-C: {item.sender} requested a position report every {interval} s. Reporting automatically.")
        elif "CANCEL" in words:
            with self.lock:
                self.contracts.pop(item.sender, None)
                self._bump()
            self._system(f"ADS-C: {item.sender} cancelled its contract.")
        else:
            self._add("in", "info", item.sender, f"ADS-C: {item.packet}")

    # ------------------------------------------------------------ ADS-C
    def set_panel_position(self, lat: float, lon: float, alt_ft: float) -> None:
        with self.lock:
            self.position = {"lat": lat, "lon": lon, "alt": alt_ft, "ts": time.time(), "source": "sim"}

    def _set_vatsim_position(self, flight: dict) -> None:
        if flight.get("lat") is None:
            return
        with self.lock:
            if not self.position or self.position["source"] != "sim" or time.time() - self.position["ts"] > 30:
                self.position = {"lat": flight["lat"], "lon": flight["lon"], "alt": flight.get("alt") or 0,
                                 "ts": time.time(), "source": "vatsim"}
            self._vatsim_pos_ts = time.time()

    def _current_position(self) -> dict | None:
        with self.lock:
            pos = self.position
            fresh = pos and pos["source"] == "sim" and time.time() - pos["ts"] < 30
            need_vatsim = not fresh and time.time() - self._vatsim_pos_ts > 30
        if need_vatsim and self.cfg.get("vatsim_cid"):
            try:
                pilot = vatsim.fetch_pilot(self.cfg.get("vatsim_cid"))
                if pilot:
                    self._set_vatsim_position(vatsim.summarize(pilot))
            except Exception as exc:
                log.warning("VATSIM position refresh failed: %s", exc)
        with self.lock:
            return dict(self.position) if self.position else None

    def _adsc_loop(self) -> None:
        while True:
            time.sleep(1)
            with self.lock:
                if self.status != "online" or not self.contracts:
                    continue
                now = time.time()
                due = [s for s, c in self.contracts.items() if c["next_due"] <= now]
                for s in due:
                    self.contracts[s]["next_due"] = now + self.contracts[s]["interval"]
            if not due:
                continue
            pos = self._current_position()
            if not pos:
                continue
            stamp = datetime.now(timezone.utc).strftime("%d%H%M")
            report = f"REPORT {self.callsign} {stamp} {pos['lat']:.5f} {pos['lon']:.5f} {round((pos['alt'] or 0) / 100)}"
            for station in due:
                try:
                    self._send(station, "ads-c", report)
                except ValueError:
                    pass

    # ------------------------------------------------------------ notifications
    def _notify(self, msg: dict, priority: int | None = None) -> None:
        if not self.cfg.get("ntfy_enabled") or not self.cfg.get("ntfy_topic"):
            return
        # the phone stays quiet while the panel is open, unless its notifications are paused
        if self.cfg.get("mute_phone_when_panel_open") and self.panel_active() and not self.panel_paused:
            return
        key = self.cfg.get("pair_key")
        title = {"cpdlc": "CPDLC", "telex": "Telex", "info": "Info", "pm": "Message", "radio": "Frequency",
                 "broadcast": "Broadcast", "selcal": "SELCAL"}.get(msg["kind"], "Message")
        options = reply_options(msg)
        actions = [notify.quick_action(o, self.base_url, key, msg["id"], o) for o in options] if self.base_url else None
        click = f"{self.base_url}/?k={key}#m{msg['id']}" if self.base_url else None
        notify.publish(
            self.cfg.get("ntfy_server"), self.cfg.get("ntfy_topic"),
            f"{title} · {msg['station']}", msg["text"] or "(empty message)",
            priority=priority or (5 if options else 4),
            tags={"cpdlc": ["airplane"], "selcal": ["bell"], "broadcast": ["loudspeaker"],
                  "radio": ["radio"]}.get(msg["kind"], ["envelope"]),
            click=click, actions=actions,
        )

    def test_notification(self) -> None:
        notify.publish(self.cfg.get("ntfy_server"), self.cfg.get("ntfy_topic"),
                       "Clearway test", "Notifications are working. Clear skies!",
                       priority=4, tags=["white_check_mark"],
                       click=f"{self.base_url}/?k={self.cfg.get('pair_key')}" if self.base_url else None)

    # ------------------------------------------------------------ user actions
    def _require_online(self) -> None:
        if self.status != "online":
            raise ValueError("Not connected. Press Connect first.")

    def reply(self, msg_id: int, text: str) -> None:
        with self.lock:
            target = self._find(msg_id)
        if target and target["dir"] == "in" and target["kind"] in ("pm", "radio"):
            # vPilot messages: plain text, any case, no Hoppie connection needed
            return self.send_text(target["kind"], target["station"], text, ack_id=msg_id)
        self._require_online()
        text = text.strip().upper()
        if not text:
            raise ValueError("Empty reply.")
        with self.lock:
            msg = self._find(msg_id)
            if not msg or msg["dir"] != "in" or msg["kind"] not in ("cpdlc", "telex"):
                raise ValueError("Message not found.")
            station, mrn, kind = msg["station"], msg.get("min"), msg["kind"]
        if kind == "telex":
            return self.send_telex(station, text, ack_id=msg_id)
        packet = build_cpdlc(self._take_min(), mrn, "N", text)
        self._send_logged(station, "cpdlc", packet, "cpdlc", text, mrn=mrn, linked=msg_id)
        with self.lock:
            msg["reply"] = text
            msg["status"] = "standby" if text == "STANDBY" else "closed"
            msg["acked"] = True
            self._bump()

    def ack(self, msg_id: int | None = None, chat: str | None = None, scope: str | None = None) -> None:
        """Mark messages read: one message, a vPilot chat, a whole tab ("cpdlc"/"vpilot") or everything."""
        with self.lock:
            for m in self.messages:
                if msg_id is not None:
                    hit = m["id"] == msg_id
                elif chat is not None:
                    hit = m.get("chat") == chat and m["kind"] in VP_KINDS
                elif scope == "vpilot":
                    hit = m["kind"] in VP_KINDS
                elif scope == "cpdlc":
                    hit = m["kind"] not in VP_KINDS
                else:
                    hit = True
                if hit:
                    m["acked"] = True
                    m.pop("quiet", None)
            self._bump()

    def unack(self, msg_id: int) -> None:
        """Mark one received message as unread again (right click on the panel icon)."""
        with self.lock:
            msg = self._find(msg_id)
            if not msg or msg["dir"] != "in":
                raise ValueError("Message not found.")
            msg["acked"] = False
            self._bump()

    def _to_trash(self, removed: list[dict]) -> None:
        self.trash.extend(removed)
        del self.trash[:-MAX_MESSAGES]

    def delete(self, msg_id: int) -> None:
        with self.lock:
            removed = [m for m in self.messages if m["id"] == msg_id]
            if not removed:
                raise ValueError("Message not found.")
            self.messages = [m for m in self.messages if m["id"] != msg_id]
            self._to_trash(removed)
            self._bump()

    def clear_history(self) -> None:
        """Delete everything except messages still waiting for an answer (restorable)."""
        with self.lock:
            keep = lambda m: m["kind"] in VP_KINDS or (m["dir"] == "in" and m["status"] in ("open", "standby"))  # noqa: E731
            self._to_trash([m for m in self.messages if not keep(m)])
            self.messages = [m for m in self.messages if keep(m)]
            self._bump()

    def restore(self, msg_id: int | None = None) -> None:
        """Bring back one deleted message (or all of them when msg_id is None)."""
        with self.lock:
            back = [m for m in self.trash if msg_id is None or m["id"] == msg_id]
            if not back:
                raise ValueError("Nothing to restore.")
            ids = {m["id"] for m in back}
            self.trash = [m for m in self.trash if m["id"] not in ids]
            self.messages = sorted(self.messages + back, key=lambda m: m["id"])
            self._bump()

    def collapse(self, msg_id: int | None, collapsed: bool) -> None:
        """Fold a message to one line (or all messages when msg_id is None)."""
        with self.lock:
            for m in self.messages:
                if msg_id is None or m["id"] == msg_id:
                    m["collapsed"] = bool(collapsed)
            self._bump()

    def logon(self, station: str) -> None:
        self._require_online()
        station = station.strip().upper()
        if not station:
            raise ValueError("Enter the ATC station (e.g. EGGX, KZNY, CZQX).")
        with self.lock:
            self.pending_logon = station
            self.pending_since = time.time()
            self._bump()
        self._expect_reply()
        n = self._take_min()   # kept on the request, so the station's LOGON ACCEPTED is linked to it as its answer
        self._send_logged(station, "cpdlc", build_cpdlc(n, None, "Y", "REQUEST LOGON"),
                          "cpdlc", "REQUEST LOGON", min=n, ra="Y", status="awaiting")

    def logoff(self) -> None:
        self._require_online()
        with self.lock:
            unit = self.current_unit or self.pending_logon
        if not unit:
            raise ValueError("You're not logged on to any ATC station.")
        self._send_logged(unit, "cpdlc", build_cpdlc(self._take_min(), None, "N", "LOGOFF"), "cpdlc", "LOGOFF")
        with self.lock:
            self.current_unit = None
            self.pending_logon = None
            self._bump()

    def send_cpdlc(self, station: str | None, text: str, ra: str = "Y") -> None:
        self._require_online()
        station = (station or self.current_unit or "").strip().upper()
        text = " ".join(text.strip().upper().split())
        if not station:
            raise ValueError("Log on to an ATC station first.")
        if not text:
            raise ValueError("Empty message.")
        n = self._take_min()
        self._expect_reply()
        self._send_logged(station, "cpdlc", build_cpdlc(n, None, ra, text), "cpdlc", text,
                          min=n, ra=ra, status="awaiting" if ra == "Y" else "none")

    def send_telex(self, station: str, text: str, ack_id: int | None = None) -> None:
        self._require_online()
        station = station.strip().upper()
        text = text.strip().upper()
        if not station or not text:
            raise ValueError("Enter a station and a message.")
        self._expect_reply()
        self._send_logged(station, "telex", text, "telex", text)
        if ack_id is not None:
            with self.lock:
                m = self._find(ack_id)
                if m:
                    m["acked"] = True
                    m["reply"] = text
                    self._bump()

    def inforeq(self, what: str, icao: str) -> None:
        what = what.strip().lower()
        icao = icao.strip().upper()
        if what not in ("metar", "taf", "shorttaf", "vatatis"):
            raise ValueError("Unknown request type.")
        if len(icao) != 4:
            raise ValueError("Enter a 4-letter ICAO code.")
        if what == "vatatis" and self.status != "online":
            return self._vatsim_atis(icao)        # not connected to Hoppie: the ATIS straight from the VATSIM data
        self._require_online()
        label = "ATIS" if what == "vatatis" else what.upper()
        self._send_logged("SERVER", "inforeq", f"{what} {icao}", "info", f"{label} {icao}")

    def _vatsim_atis(self, icao: str) -> None:
        """An ATIS request without a Hoppie connection: answered from the VATSIM data, one reply per ATIS online for that
        airport (EGLL_ATIS, or EDDF_A_ATIS and EDDF_D_ATIS)."""
        feed = self._vatsim_feed(max_age=60)
        if not feed:
            raise ValueError("Not connected to Hoppie, and the VATSIM data isn't reachable.")
        found = sorted((cs, a) for cs, a in (feed.get("atis") or {}).items()
                       if cs.startswith(icao + "_") and cs.endswith("_ATIS") and a.get("lines"))
        req = self._add("out", "info", "VATSIM", f"ATIS {icao}", status="answered" if found else "none")
        if not found:
            self._system(f"No ATIS online for {icao} on VATSIM.")
            return
        with self.lock:
            req["reply"] = ", ".join(cs for cs, _ in found)
            self._bump()
        for cs, a in found:
            msg = self._add("in", "info", cs, " ".join(a["lines"]) + (f" ({a['f']})" if a.get("f") else ""),
                            linked=req["id"])
            self._notify(msg)

    # ------------------------------------------------------------ notepad
    def _notes_path(self):
        from .config import data_dir
        return data_dir() / "notes.txt"

    def _load_notes(self) -> str:
        try:
            return self._notes_path().read_text(encoding="utf-8")
        except OSError:
            return ""

    def save_notes(self, text: str) -> None:
        text = str(text)[:50_000]
        with self.lock:
            self.notes = text
            self._bump()
        try:
            self._notes_path().write_text(text, encoding="utf-8")
        except OSError as exc:
            log.warning("Couldn't save notes: %s", exc)

    @property
    def base_url(self) -> str:
        """http://<this PC's current IP>:<port>. Looked up again every 15 s rather than once at start: the IP can
        change while Clearway runs (Wi-Fi reconnect, Windows' random hardware addresses), and a stale one makes
        the pairing QR code and notification links point nowhere."""
        if not self.port:
            return ""
        url, ts = self._base
        if not url or time.time() - ts > 15:
            from .server import lan_ip
            url = f"http://{lan_ip()}:{self.port}"
            self._base = (url, time.time())
        return url

    # ------------------------------------------------------------ snapshot
    def snapshot(self) -> dict:
        with self.lock:
            msgs = []
            for m in self.messages:
                item = dict(m)
                item["options"] = reply_options(m)
                item["quick"] = quick_replies(m)
                msgs.append(item)
            unacked_vp = sum(1 for m in self.messages if m["dir"] == "in" and not m["acked"] and m["kind"] in VP_KINDS)
            unacked_cpdlc = sum(1 for m in self.messages if m["dir"] == "in" and not m["acked"] and m["kind"] not in VP_KINDS)
            unacked = unacked_vp + unacked_cpdlc
            quiet_vp = sum(1 for m in self.messages if m.get("quiet"))   # new frequency text for others
            return {
                "version": self.version,
                "status": self.status,
                "error": self.error,
                "callsign": self.callsign,
                "flight": {k: v for k, v in self.flight.items() if k not in ("lat", "lon", "alt")},
                "current_unit": self.current_unit,
                "pending_logon": self.pending_logon,
                "last_poll": int(self.last_poll * 1000),
                "next_poll": int(self.next_poll * 1000),
                "contracts": [{"station": s, "interval": c["interval"]} for s, c in self.contracts.items()],
                "position_source": self.position["source"] if self.position else None,
                "panel_active": self.panel_active(),
                "unacked": unacked,
                "unacked_vpilot": unacked_vp,
                "unacked_cpdlc": unacked_cpdlc,
                "quiet_vpilot": quiet_vp,
                "notes": self.notes,
                "messages": msgs,
                "trash": [{k: m.get(k) for k in ("id", "ts", "dir", "kind", "station", "text")}
                          for m in reversed(self.trash) if m["dir"] != "sys"],
                "settings": self.cfg.public(),
                "base_url": self.base_url,
                "name_url": self.name_url,
                "vpilot": {**self.vpilot_snapshot(), "fp_status": self.fp_status},
                "selcal": self.selcal_snapshot(),
                "tsat": self.tsat,                 # TSAT start-up window (vIFF / VDGS), or None
            }
