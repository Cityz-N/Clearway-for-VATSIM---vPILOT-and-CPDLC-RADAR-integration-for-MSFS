"""SELCAL tab: generate codes, check them against VATSIM flight plans, keep saved codes for 24 hours,
read the SELCAL of the latest SimBrief flight plan, and watch whether the vPilot callsign has filed.

Merged from the standalone SELCAL code generator (github.com/Cityz-N/SELCAL-code-generator).
Rules: four tones in two pairs (AB-CD); standard tones A-S without I, N, O; no tone twice; tones
ascending within each pair. Extended (SELCAL32) adds T-Z and 1-9 and always uses one of them.
"""
from __future__ import annotations

import gzip
import json
import logging
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .vatsim import FEED_URL

log = logging.getLogger("clearway.selcal")

STD = list("ABCDEFGHJKLMPQRS")
EXT_NEW = list("TUVWXYZ123456789")
EXT = STD + EXT_NEW
TTL_S = 24 * 3600
MAX_PER_CALLSIGN = 10
FEED_MAX_AGE = 60          # seconds before the VATSIM data is fetched again
FP_CHECK_EVERY = 60        # flight plan status check while vPilot is connected
SIMBRIEF_URL = "https://www.simbrief.com/api/xml.fetcher.php"
UA = "Clearway-CPDLC/1.0"

# ICAO designator => (IATA code for the logo, airline name)
AIRLINES = {
    "AAL": ("AA", "American Airlines"), "AAR": ("OZ", "Asiana Airlines"), "ACA": ("AC", "Air Canada"),
    "AEA": ("UX", "Air Europa"), "AEE": ("A3", "Aegean Airlines"), "AFL": ("SU", "Aeroflot"),
    "AFR": ("AF", "Air France"), "AIC": ("AI", "Air India"), "AMX": ("AM", "Aeromexico"),
    "ANA": ("NH", "All Nippon Airways"), "ANZ": ("NZ", "Air New Zealand"), "ARG": ("AR", "Aerolineas Argentinas"),
    "ASA": ("AS", "Alaska Airlines"), "AUA": ("OS", "Austrian Airlines"), "AVA": ("AV", "Avianca"),
    "AZU": ("AD", "Azul"), "BAW": ("BA", "British Airways"), "BEL": ("SN", "Brussels Airlines"),
    "BTI": ("BT", "airBaltic"), "CAL": ("CI", "China Airlines"), "CCA": ("CA", "Air China"),
    "CES": ("MU", "China Eastern"), "CFG": ("DE", "Condor"), "CLX": ("CV", "Cargolux"),
    "CMP": ("CM", "Copa Airlines"), "CPA": ("CX", "Cathay Pacific"), "CRK": ("HX", "Hong Kong Airlines"),
    "CRL": ("SS", "Corsair"), "CSN": ("CZ", "China Southern"), "DAH": ("AH", "Air Algerie"),
    "DAL": ("DL", "Delta Air Lines"), "DLH": ("LH", "Lufthansa"), "EIN": ("EI", "Aer Lingus"),
    "ELY": ("LY", "El Al"), "ENY": ("MQ", "Envoy Air"), "ETD": ("EY", "Etihad Airways"),
    "ETH": ("ET", "Ethiopian Airlines"), "EVA": ("BR", "EVA Air"), "EWG": ("EW", "Eurowings"),
    "EZY": ("U2", "easyJet"), "FBU": ("BF", "French Bee"), "FDX": ("FX", "FedEx Express"),
    "FFT": ("F9", "Frontier Airlines"), "FIN": ("AY", "Finnair"), "FJI": ("FJ", "Fiji Airways"),
    "GFA": ("GF", "Gulf Air"), "GIA": ("GA", "Garuda Indonesia"), "GLO": ("G3", "GOL"),
    "GTI": ("5Y", "Atlas Air"), "HAL": ("HA", "Hawaiian Airlines"), "HVN": ("VN", "Vietnam Airlines"),
    "IBE": ("IB", "Iberia"), "ICE": ("FI", "Icelandair"), "IGO": ("6E", "IndiGo"),
    "ITY": ("AZ", "ITA Airways"), "JAL": ("JL", "Japan Airlines"), "JBU": ("B6", "JetBlue"),
    "KAC": ("KU", "Kuwait Airways"), "KAL": ("KE", "Korean Air"), "KLM": ("KL", "KLM"),
    "KQA": ("KQ", "Kenya Airways"), "LAN": ("LA", "LATAM Airlines"), "LGL": ("LG", "Luxair"),
    "LOT": ("LO", "LOT Polish Airlines"), "MAS": ("MH", "Malaysia Airlines"), "MEA": ("ME", "Middle East Airlines"),
    "MSR": ("MS", "EgyptAir"), "NAX": ("DY", "Norwegian"), "NKS": ("NK", "Spirit Airlines"),
    "OMA": ("WY", "Oman Air"), "PAL": ("PR", "Philippine Airlines"), "PIA": ("PK", "Pakistan International"),
    "QFA": ("QF", "Qantas"), "QTR": ("QR", "Qatar Airways"), "RAM": ("AT", "Royal Air Maroc"),
    "RJA": ("RJ", "Royal Jordanian"), "ROT": ("RO", "TAROM"), "RYR": ("FR", "Ryanair"),
    "SAA": ("SA", "South African Airways"), "SAS": ("SK", "SAS"), "SIA": ("SQ", "Singapore Airlines"),
    "SKW": ("OO", "SkyWest"), "SVA": ("SV", "Saudia"), "SWA": ("WN", "Southwest Airlines"),
    "SWR": ("LX", "Swiss"), "TAM": ("JJ", "LATAM Brasil"), "TAP": ("TP", "TAP Air Portugal"),
    "TAR": ("TU", "Tunisair"), "THA": ("TG", "Thai Airways"), "THY": ("TK", "Turkish Airlines"),
    "TRA": ("HV", "Transavia"), "TSC": ("TS", "Air Transat"), "TVF": ("TO", "Transavia France"),
    "UAE": ("EK", "Emirates"), "UAL": ("UA", "United Airlines"), "UPS": ("5X", "UPS Airlines"),
    "VIR": ("VS", "Virgin Atlantic"), "VLG": ("VY", "Vueling"), "VOZ": ("VA", "Virgin Australia"),
    "WJA": ("WS", "WestJet"), "WZZ": ("W6", "Wizz Air"),
}


# ------------------------------------------------------------ codes
def normalize_callsign(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def valid_callsign(cs: str) -> bool:
    return bool(re.fullmatch(r"[A-Z0-9]{2,7}", cs)) and bool(re.search(r"[A-Z]", cs))


def airline_for(cs: str) -> dict | None:
    """AFR, AFR123 or AFR12A, but not a registration such as FGABC."""
    m = re.fullmatch(r"([A-Z]{3})(\d[A-Z0-9]*)?", cs or "")
    if not m or m.group(1) not in AIRLINES:
        return None
    iata, name = AIRLINES[m.group(1)]
    return {"iata": iata, "name": name}


def _pick(tones: list[str], k: int) -> list[str]:
    pool = tones[:]
    for i in range(len(pool) - 1, 0, -1):
        j = secrets.randbelow(i + 1)
        pool[i], pool[j] = pool[j], pool[i]
    return pool[:k]


def make_code(extended: bool = False) -> str:
    tones_set = EXT if extended else STD
    while True:
        tones = _pick(tones_set, 4)
        if not extended or any(t in EXT_NEW for t in tones):
            break
    order = tones_set.index
    p1 = sorted(tones[:2], key=order)
    p2 = sorted(tones[2:], key=order)
    return "".join(p1) + "-" + "".join(p2)


def parse_code(text: str) -> str | None:
    """'ERMP', 'ER-MP', 'SEL/ER-MP' -> 'ER-MP' (None when it isn't four valid tones)."""
    raw = re.sub(r"[^A-Z0-9]", "", str(text or "").upper().replace("SEL/", ""))
    if len(raw) != 4 or any(c not in EXT for c in raw) or len(set(raw)) != 4:
        return None
    return raw[:2] + "-" + raw[2:]


def code_key(code: str) -> str:
    """Same tones in either pair order count as the same code (AB-CD = CD-AB)."""
    a, b = "".join(sorted(code[:2])), "".join(sorted(code[3:]))
    return "-".join(sorted([a, b]))


SEL_RE = re.compile(r"\bSEL/([A-Z0-9]{2}-?[A-Z0-9]{2})\b")


class SelcalMixin:
    def _selcal_init(self) -> None:
        self.selcal_saved: list[dict] = self._selcal_load()
        self.selcal_current: dict | None = None     # last generated codes
        self.selcal_checked: dict | None = None     # last code typed in "Check a code"
        self.simbrief: dict | None = None
        self.simbrief_error = ""
        self._feed: dict | None = None              # {ts, used: {key: [(callsign, code, where)]}, pilots, prefiles}
        self._feed_error = ""
        self._feed_lock = threading.Lock()
        self.fp_status: str | None = None           # filed | prefiled | none | None (unknown)
        threading.Thread(target=self._fp_loop, daemon=True, name="fp-status").start()

    # ------------------------------------------------------------ saved codes (data/selcal.json)
    def _selcal_path(self):
        from .config import data_dir
        return data_dir() / "selcal.json"

    def _selcal_load(self) -> list[dict]:
        try:
            data = json.loads(self._selcal_path().read_text(encoding="utf-8"))
            return [e for e in data if isinstance(e, dict) and e.get("expires", 0) > time.time()]
        except (OSError, ValueError):
            return []

    def _selcal_store(self) -> None:
        try:
            self._selcal_path().write_text(json.dumps(self.selcal_saved), encoding="utf-8")
        except OSError as exc:
            log.warning("Couldn't save SELCAL codes: %s", exc)

    def _selcal_live(self) -> list[dict]:
        now = time.time()
        live = [e for e in self.selcal_saved if e.get("expires", 0) > now]
        if len(live) != len(self.selcal_saved):
            self.selcal_saved = live
            self._selcal_store()
        return sorted(live, key=lambda e: -e["expires"])

    def selcal_save(self, callsign: str, generated: int, std: str | None, ext: str | None) -> str:
        cs = normalize_callsign(callsign)
        if not valid_callsign(cs):
            raise ValueError("Enter a callsign first (2-7 letters or digits)." if not cs else "Callsigns are 2-7 letters or digits.")
        codes = {k: parse_code(v) for k, v in (("std", std), ("ext", ext)) if v}
        codes = {k: v for k, v in codes.items() if v}
        if not codes:
            raise ValueError("Generate a code first.")
        with self.lock:
            live = self._selcal_live()
            same = [e for e in live if e["callsign"] == cs and e.get("generated") == generated]
            if not same and sum(1 for e in live if e["callsign"] == cs) >= MAX_PER_CALLSIGN:
                raise ValueError(f"Too many saved codes for {cs} (maximum {MAX_PER_CALLSIGN}). Remove one first.")
            entry = dict(same[0]) if same else {}
            entry.update({"callsign": cs, "generated": generated, **codes, "expires": time.time() + TTL_S})
            self.selcal_saved = [entry] + [e for e in live if not (e["callsign"] == cs and e.get("generated") == generated)]
            self._selcal_store()
            self._bump()
        return "saved"

    def selcal_remove(self, callsign: str, generated: int) -> None:
        cs = normalize_callsign(callsign)
        with self.lock:
            self.selcal_saved = [e for e in self._selcal_live() if not (e["callsign"] == cs and e.get("generated") == generated)]
            self._selcal_store()
            self._bump()

    # ------------------------------------------------------------ VATSIM data
    def _vatsim_feed(self, max_age: float = FEED_MAX_AGE) -> dict | None:
        with self._feed_lock:
            if self._feed and time.time() - self._feed["ts"] < max_age:
                return self._feed
            try:
                req = urllib.request.Request(FEED_URL, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
                with urllib.request.urlopen(req, timeout=20) as resp:
                    raw = resp.read()
                    if resp.headers.get("Content-Encoding") == "gzip":
                        raw = gzip.decompress(raw)
                data = json.loads(raw)
            except Exception as exc:   # network, JSON...
                self._feed_error = "VATSIM data not reachable"
                log.warning("VATSIM feed: %s", exc)
                return self._feed
            used: dict[str, list] = {}
            pilots: dict[str, bool] = {}
            prefiles: set[str] = set()
            moving: dict[str, dict] = {}           # online pilots: departure airport and ground speed (TSAT check)
            my_cid = str(self.cfg.get("vatsim_cid") or "").strip()
            mine = None                            # your own flight plan (matched by your CID): online first, else prefile
            for where, items in (("online", data.get("pilots", [])), ("prefiled", data.get("prefiles", []))):
                for p in items:
                    cs = str(p.get("callsign", "")).upper()
                    fp = p.get("flight_plan") or {}
                    if where == "online":
                        pilots[cs] = bool(fp)
                        moving[cs] = {"dep": str(fp.get("departure") or "").upper(), "gs": p.get("groundspeed") or 0}
                    else:
                        prefiles.add(cs)
                    m = SEL_RE.search(str(fp.get("remarks", "")).upper())
                    code = parse_code(m.group(1)) if m else None
                    if code:
                        used.setdefault(code_key(code), []).append({"callsign": cs, "code": code, "where": where})
                    if my_cid and fp and mine is None and str(p.get("cid", "")).strip() == my_cid:
                        mine = {"callsign": cs, "type": _icao_type(fp), "selcal": code, "where": where,
                                "departure": str(fp.get("departure") or "").upper(),
                                "arrival": str(fp.get("arrival") or "").upper()}
            # controllers (and ATIS stations): the name each one shows on VATSIM (full name, first name or CID),
            # for the vPilot ATC list
            names = {str(c.get("callsign", "")).upper(): str(c.get("name") or "").strip()
                     for c in list(data.get("controllers", [])) + list(data.get("atis", []))}
            # online ATIS stations and their text: a CPDLC ATIS request is answered from these when Hoppie isn't connected
            atis_text = {str(a.get("callsign", "")).upper(): {"f": str(a.get("frequency") or ""),
                                                              "lines": [str(x) for x in (a.get("text_atis") or []) if str(x).strip()]}
                         for a in data.get("atis", [])}
            self._feed = {"ts": time.time(), "used": used, "pilots": pilots, "prefiles": prefiles, "moving": moving,
                          "names": names, "mine": mine, "atis": atis_text, "count": len(pilots) + len(prefiles)}
            self._feed_error = ""
        with self.lock:
            self._bump()          # "Free / Used by" lines on every screen follow the new data
        return self._feed

    def _own_callsigns(self) -> set[str]:
        """Callsigns that are you: your own prefile or flight plan never counts as 'used by'."""
        own = {normalize_callsign(self.vpilot_callsign or ""), normalize_callsign(self.cfg.get("vpilot_callsign") or "")}
        if self.simbrief:
            own.add(self.simbrief.get("callsign", ""))
        if self.selcal_current:
            own.add(self.selcal_current.get("callsign", ""))
        own.discard("")
        return own

    def _used_by(self, code: str | None, exclude="") -> list[dict] | None:
        """Who else uses this code on VATSIM (online or prefiled). None = not checked.
        `exclude`: a callsign or a set of callsigns that are you."""
        if not code or not self._feed:
            return None
        skip = {exclude} if isinstance(exclude, str) else set(exclude)
        skip |= self._own_callsigns()
        return [u for u in self._feed["used"].get(code_key(code), []) if u["callsign"] not in skip]

    def selcal_generate(self, callsign: str) -> dict:
        cs = normalize_callsign(callsign)
        feed = self._vatsim_feed()
        codes = {}
        for kind, extended in (("std", False), ("ext", True)):
            for _ in range(500):                       # avoid codes already on VATSIM
                code = make_code(extended)
                if not feed or not feed["used"].get(code_key(code)):
                    break
            codes[kind] = code
        with self.lock:
            self.selcal_current = {"callsign": cs, "generated": int(time.time() * 1000), **codes}
            self._bump()
        return self.selcal_current

    def selcal_check(self, code: str, remember: bool = True, exclude: str = "") -> dict:
        """A code typed by hand: is it valid, and does anyone on VATSIM use it?
        remember=False (vPilot connect form) doesn't change the SELCAL tab; `exclude` is your own callsign."""
        c = parse_code(code)
        if not c:
            raise ValueError("A SELCAL is four different tones, e.g. AB-CD (A-S without I, N, O; extended adds T-Z, 1-9).")
        t = c.replace("-", "")
        tones = EXT if any(x in EXT_NEW for x in t) else STD
        if tones.index(t[0]) > tones.index(t[1]) or tones.index(t[2]) > tones.index(t[3]):
            raise ValueError(f"Tones must be in order within each pair ({''.join(sorted(t[:2], key=tones.index))}-"
                             f"{''.join(sorted(t[2:], key=tones.index))}, not {c}).")
        self._vatsim_feed()
        if remember:
            with self.lock:
                self.selcal_checked = {"code": c, "ts": int(time.time() * 1000), "callsign": normalize_callsign(exclude)}
                self._bump()
        return {"code": c, "used_by": self._used_by(c, normalize_callsign(exclude))}

    # ------------------------------------------------------------ SimBrief
    def simbrief_fetch(self, user: str | None = None) -> dict:
        if user is not None:
            self.cfg.update({"simbrief_user": str(user).strip()})
        user = str(self.cfg.get("simbrief_user") or "").strip()
        if not user:
            raise ValueError("Enter your SimBrief username or pilot ID first.")
        key = "userid" if user.isdigit() else "username"
        url = f"{SIMBRIEF_URL}?{key}={urllib.parse.quote(user)}&json=v2"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as resp:
                ofp = json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            msg = "SimBrief didn't find a flight plan for that user." if exc.code == 400 else f"SimBrief error {exc.code}."
            with self.lock:
                self.simbrief_error = msg
                self._bump()
            raise ValueError(msg)
        except Exception as exc:
            with self.lock:
                self.simbrief_error = "SimBrief not reachable."
                self._bump()
            raise ValueError("SimBrief not reachable.") from exc
        g = lambda *path: _dig(ofp, *path)  # noqa: E731
        callsign = normalize_callsign(g("atc", "callsign") or (str(g("general", "icao_airline") or "") + str(g("general", "flight_number") or "")))
        code = parse_code(g("aircraft", "selcal") or "")
        if not code:
            m = SEL_RE.search(" ".join(str(g("atc", k) or "") for k in ("section18", "flightplan_text")).upper())
            code = parse_code(m.group(1)) if m else None
        info = {
            "callsign": callsign,
            "selcal": code,
            "departure": str(g("origin", "icao_code") or ""),
            "arrival": str(g("destination", "icao_code") or ""),
            "aircraft": str(g("aircraft", "icaocode") or g("aircraft", "icao_code") or ""),
            "reg": str(g("aircraft", "reg") or ""),
            "generated": _time_ms(g("params", "time_generated")),
            "fetched": int(time.time() * 1000),
        }
        self._vatsim_feed()
        with self.lock:
            self.simbrief = info
            self.simbrief_error = ""
            self._bump()
        return info

    def selcal_use(self, code: str) -> str:
        c = parse_code(code)
        if not c or any(t in EXT_NEW for t in c.replace("-", "")):
            raise ValueError("vPilot takes a standard 16-tone code (A-S).")
        self.cfg.update({"vpilot_selcal": c})
        with self.lock:
            self._bump()
        return c

    # ------------------------------------------------------------ flight plan status (vPilot)
    def _fp_loop(self) -> None:
        last = 0.0
        idle_fetch = 0.0
        while True:
            time.sleep(5)
            connected = self.vpilot_connected and self.vpilot_active() and not self.vpilot_observer
            if not connected:
                if self.fp_status is not None:
                    with self.lock:
                        self.fp_status = None
                        self._bump()
                last = 0.0
                # not connected yet: keep your filed flight plan (prefile, by CID) at hand for vPilot's connect form
                # and the SELCAL tab, at most once a minute and only while vPilot is open or the panel is showing
                if (str(self.cfg.get("vatsim_cid") or "").strip() and (self.vpilot_active() or self.panel_active())
                        and time.time() - idle_fetch >= 60):
                    idle_fetch = time.time()
                    self._vatsim_feed(max_age=60)
                continue
            if time.time() - last < FP_CHECK_EVERY:
                continue
            last = time.time()
            feed = self._vatsim_feed(max_age=30)
            if not feed:
                continue
            cs = str(self.vpilot_callsign or "").upper()
            if cs in feed["pilots"]:
                status = "filed" if feed["pilots"][cs] else ("prefiled" if cs in feed["prefiles"] else "none")
            else:
                status = None                       # not in the VATSIM data yet (it lags ~15-30 s)
            if status != self.fp_status:
                with self.lock:
                    self.fp_status = status
                    self._bump()

    # ------------------------------------------------------------ snapshot
    def selcal_snapshot(self) -> dict:
        cur = dict(self.selcal_current) if self.selcal_current else None
        if cur:
            cur["airline"] = airline_for(cur["callsign"])
            cur["std_used"] = self._used_by(cur.get("std"), cur["callsign"])
            cur["ext_used"] = self._used_by(cur.get("ext"), cur["callsign"])
        sb = dict(self.simbrief) if self.simbrief else None
        if sb:
            sb["used_by"] = self._used_by(sb.get("selcal"), sb.get("callsign", ""))
            sb["airline"] = airline_for(sb.get("callsign", ""))
        saved = []
        for e in self._selcal_live():
            item = dict(e)
            item["airline"] = airline_for(e["callsign"])
            item["left"] = int(e["expires"] - time.time())
            saved.append(item)
        chk = dict(self.selcal_checked) if self.selcal_checked else None
        if chk:
            chk["used_by"] = self._used_by(chk["code"], chk.get("callsign", ""))
        feed = self._feed
        return {
            "current": cur,
            "checked": chk,
            "simbrief": sb,
            "simbrief_error": self.simbrief_error,
            "simbrief_user": str(self.cfg.get("simbrief_user") or ""),
            "saved": saved,
            "max_per_callsign": MAX_PER_CALLSIGN,
            "vatsim": {"checked": bool(feed), "age": int(time.time() - feed["ts"]) if feed else None,
                       "count": feed["count"] if feed else 0, "error": self._feed_error},
            # your own VATSIM flight plan (prefile or online, by your CID): fills vPilot's connect form, SELCAL fallback
            "vatsim_fp": dict(feed["mine"]) if feed and feed.get("mine") else None,
        }


def _icao_type(fp: dict) -> str:
    """The aircraft's ICAO type from a VATSIM flight plan: aircraft_short ('B77L'), else the middle of 'H/B77L/L'."""
    short = str(fp.get("aircraft_short") or "").strip().upper()
    if short:
        return short
    parts = [x for x in str(fp.get("aircraft_faa") or fp.get("aircraft") or "").upper().split("/") if x]
    if len(parts) >= 2 and len(parts[0]) == 1:       # H/B77L/L: wake category first
        return parts[1].split("-")[0]
    return parts[0].split("-")[0] if parts else ""


def _time_ms(value) -> int:
    """SimBrief gives either a Unix time ('1794876345') or an ISO date ('2026-11-17T02:42:21Z')."""
    s = str(value or "").strip()
    if s.isdigit():
        return int(s) * 1000
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def _dig(obj, *path):
    for k in path:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(k)
    if isinstance(obj, (dict, list)):
        return None if not obj else obj
    return obj
