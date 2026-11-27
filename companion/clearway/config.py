"""Settings storage for the Clearway companion.

Settings live in %APPDATA%\\Clearway\\config.json (or ~/.clearway on other systems)
so they survive updates of the executable.
"""
from __future__ import annotations

import json
import os
import secrets
import string
import threading
from pathlib import Path

APP_NAME = "Clearway"


def data_dir() -> Path:
    override = os.environ.get("CLEARWAY_DATA_DIR")   # handy for development/testing
    base = os.environ.get("APPDATA")
    if override:
        path = Path(override)
    else:
        path = Path(base) / APP_NAME if base else Path.home() / ".clearway"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _random_token(n: int) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


DEFAULTS = {
    # Hoppie / network
    "hoppie_logon": "",
    "vatsim_cid": "",
    "callsign_override": "",          # leave empty to read callsign from VATSIM
    "hoppie_url": "http://www.hoppie.nl/acars/system/connect.html",
    # Phone notifications (ntfy)
    "ntfy_enabled": True,
    "ntfy_server": "https://ntfy.sh",
    "ntfy_topic": "",                 # generated on first start
    "mute_phone_when_panel_open": True,
    # Behaviour
    "adsc_enabled": True,
    "open_browser_on_start": False,   # Clearway lives in the tray; double-click to open
    "theme": "dark",                  # "dark" (navy), "black", "light" or "custom" (1.5.0)
    # (1.5.0) edited colours per theme: {"dark": {"bg": "#rrggbb", ...}, ..., "custom": {...}}; missing = the default
    "theme_colors": {},
    "map_colored": False,             # radar map in the theme's sea / land colours (off: the grey map)
    "radar_rings": [],                # radar range rings [{icao, nm, lat, lon}] (radar.py)
    # vPilot plugin
    "vpilot_auto_connect": True,      # connect to Hoppie as soon as vPilot connects to VATSIM
    "vpilot_all_frequency": False,    # alert for all frequency text, not only messages that mention you
    "vpilot_callsign": "",            # last details used to connect vPilot (filled automatically)
    "vpilot_type": "",
    "vpilot_selcal": "",
    "vpilot_observer": False,         # last "connect as observer" choice
    "quit_with_vpilot": True,         # quit Clearway when vPilot closes (only if vPilot ran during this session)
    # MSFS panel: while a panel text field has the cursor, Clearway holds back key presses from
    # MSFS and other programs (ChasePlane...) and types them into the panel itself
    "panel_capture_keys": True,
    "simbrief_user": "",              # SimBrief username or pilot ID (SELCAL tab: latest flight plan)
    "vdgs_tsat": True,               # read your TSAT from the vIFF / CDM network (VDGS) for the panel clock
    "config_version": 2,
    # Local web server
    "port": 8787,
    "pair_key": "",                   # generated on first start, protects the API on your LAN
}


THEMES = ("dark", "black", "light", "custom")
COLOR_KEYS = ("bg", "box", "accent", "text", "icon_bg", "icon_fg", "sea", "land")


def _hex(v) -> str | None:
    v = str(v or "").strip().lower()
    if len(v) == 7 and v[0] == "#" and all(c in "0123456789abcdef" for c in v[1:]):
        return v
    return None


def _merge_theme_colors(current: dict, update: dict) -> dict:
    """update: {"dark": {"bg": "#112233", "alpha": 0.6, ...}} changes those values; {"dark": null} resets the theme."""
    out = {t: dict(current.get(t) or {}) for t in THEMES if isinstance(current.get(t), dict)}
    for theme, vals in update.items():
        if theme not in THEMES:
            continue
        if vals is None:
            out.pop(theme, None)
            continue
        if not isinstance(vals, dict):
            continue
        cur = out.setdefault(theme, {})
        for k, v in vals.items():
            if k in COLOR_KEYS and _hex(v):
                cur[k] = _hex(v)
            elif k == "alpha":
                try:
                    cur[k] = round(max(0.3, min(1.0, float(v))), 2)
                except (TypeError, ValueError):
                    pass
    return out


class Config:
    def __init__(self, path: Path | None = None):
        self.path = path or data_dir() / "config.json"
        self._lock = threading.Lock()
        self.values = dict(DEFAULTS)
        self.load()
        changed = False
        if int(self.values.get("config_version") or 1) < 2:
            # v0.1 opened the browser on every start; the tray icon replaces that.
            self.values["open_browser_on_start"] = False
            self.values["config_version"] = 2
            changed = True
        if not self.values.get("ntfy_topic"):
            self.values["ntfy_topic"] = "clearway-" + _random_token(20)
            changed = True
        if not self.values.get("pair_key"):
            self.values["pair_key"] = _random_token(24)
            changed = True
        if changed:
            self.save()

    def load(self) -> None:
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                for key in DEFAULTS:
                    if key in data:
                        self.values[key] = data[key]
                # files written before versioning existed count as version 1
                self.values["config_version"] = data.get("config_version", 1)
            except (OSError, ValueError):
                pass

    def save(self) -> None:
        with self._lock:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.values, indent=2), encoding="utf-8")
            tmp.replace(self.path)

    def get(self, key: str):
        return self.values.get(key, DEFAULTS.get(key))

    def update(self, data: dict) -> None:
        """Update editable settings from the UI. Unknown keys are ignored."""
        editable = {
            "hoppie_logon": str, "vatsim_cid": str, "callsign_override": str,
            "ntfy_enabled": bool, "mute_phone_when_panel_open": bool,
            "adsc_enabled": bool, "open_browser_on_start": bool, "theme": str,
            "vpilot_auto_connect": bool, "vpilot_all_frequency": bool,
            "vpilot_callsign": str, "vpilot_type": str, "vpilot_selcal": str, "vpilot_observer": bool,
            "panel_capture_keys": bool, "simbrief_user": str, "vdgs_tsat": bool, "quit_with_vpilot": bool,
        }
        if isinstance(data.get("radar_rings"), list):        # (1.5.0) radar range rings, validated by radar.py
            self.values["radar_rings"] = data["radar_rings"][:5]
        if isinstance(data.get("theme_colors"), dict):       # (1.5.0) theme editor: one theme's colours, or reset
            self.values["theme_colors"] = _merge_theme_colors(self.values.get("theme_colors") or {}, data["theme_colors"])
        if "map_colored" in data:
            self.values["map_colored"] = bool(data["map_colored"])
        for key, kind in editable.items():
            if key in data:
                value = data[key]
                if kind is bool:
                    value = bool(value)
                else:
                    value = str(value).strip()
                    if key == "callsign_override":
                        value = value.upper()
                    if key == "theme" and value not in ("dark", "black", "light", "custom"):
                        continue
                self.values[key] = value
        self.save()

    def regenerate_topic(self) -> None:
        self.values["ntfy_topic"] = "clearway-" + _random_token(20)
        self.save()

    def public(self) -> dict:
        """Settings safe to show in the UI (logon code is masked)."""
        logon = self.values.get("hoppie_logon", "")
        return {
            "hoppie_logon_set": bool(logon),
            "hoppie_logon_hint": (logon[:2] + "•" * max(0, len(logon) - 4) + logon[-2:]) if len(logon) > 4 else ("•" * len(logon)),
            "vatsim_cid": self.values.get("vatsim_cid", ""),
            "callsign_override": self.values.get("callsign_override", ""),
            "ntfy_enabled": self.values.get("ntfy_enabled", True),
            "ntfy_server": self.values.get("ntfy_server"),
            "ntfy_topic": self.values.get("ntfy_topic"),
            "mute_phone_when_panel_open": self.values.get("mute_phone_when_panel_open", True),
            "adsc_enabled": self.values.get("adsc_enabled", True),
            "open_browser_on_start": self.values.get("open_browser_on_start", False),
            "theme": self.values.get("theme", "dark"),
            "theme_colors": self.values.get("theme_colors") or {},
            "map_colored": bool(self.values.get("map_colored", False)),
            "vpilot_auto_connect": self.values.get("vpilot_auto_connect", True),
            "vpilot_all_frequency": self.values.get("vpilot_all_frequency", False),
            "vdgs_tsat": self.values.get("vdgs_tsat", True),
            "quit_with_vpilot": self.values.get("quit_with_vpilot", True),
            "panel_capture_keys": self.values.get("panel_capture_keys", True),
            "port": self.values.get("port"),
        }
