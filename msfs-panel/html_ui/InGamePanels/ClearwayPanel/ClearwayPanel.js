/* Clearway MSFS toolbar panel.
   Talks to the Clearway companion on this PC (http://localhost:8787).
   Two tabs: vPilot (frequency + private chats, nearby ATC, transponder) and CPDLC.
   Written in plain ES2015 for the sim's Coherent GT browser; also runs in a normal browser for testing. */
(function () {
  "use strict";

  // ?api=http://localhost:8797 lets developers point a browser copy of the panel at a test server
  var apiParam = /[?&]api=([^&]+)/.exec(window.location.search || "");
  var API = apiParam ? decodeURIComponent(apiParam[1]) : "http://localhost:8787";
  var POLL_MS = 1000;
  var COM_MS = 1000;
  var POSITION_MS = 10000;
  var VP = { pm: 1, radio: 1, broadcast: 1, selcal: 1, vinfo: 1, vsys: 1 };
  // Test builds only: shows which focus / mouse signals the sim sends (see startFocusDebug). Keep false in releases.
  var FOCUS_DEBUG = /[?&]focusdebug=1/.test(window.location.search || "");

  var el = function (id) { return document.getElementById(id); };
  var state = null;
  var version = 0;
  var lastVp = 0, lastCp = 0;
  var reachable = true;
  var expanded = false;
  var tab = "cpdlc";
  var notesOpen = false;
  var reqOpen = false;
  var reqKind = "logon";
  var wxKind = "metar";
  var started = false;
  // vPilot chats
  var activeChat = "FREQ";
  var openedChats = [];
  var closedChats = {};
  var atcOpen = false;
  var lastChatKey = "";
  var ackPending = {};
  var atcOpenRows = {};    // controllers whose information is expanded
  var com = null;          // COM radios read from the sim
  var comPower = null;     // { 1: bool, 2: bool }: each radio has power (sim only)
  var vpClosingUntil = 0;  // vPilot close confirmed: the power button stays yellow until it's gone (ms timestamp)
  var vpOpenSince = 0;     // when vPilot's process was first seen running (yellow until its plugin reports in)
  var xpdr = null;         // the aircraft's transponder state in the sim (see simTransponder)
  var lastModecN = null, lastIdentN = null;   // Clearway's Mode C / ident request counters (see renderVpilot)
  var comSentAt = 0, comSentKey = "";
  var hintTimers = {};

  // ------------------------------------------------------------ storage (sim or browser)
  function load(key, fallback) {
    try {
      var v = (typeof GetStoredData === "function") ? GetStoredData(key) : window.localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try {
      var s = JSON.stringify(value);
      if (typeof SetStoredData === "function") SetStoredData(key, s); else window.localStorage.setItem(key, s);
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ HTTP
  function request(method, path, body, done) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, API + path, true);
    xhr.timeout = 4000;
    // text/plain keeps this a "simple" request (no CORS preflight)
    if (body) xhr.setRequestHeader("Content-Type", "text/plain");
    xhr.onload = function () {
      var data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (done) done(xhr.status >= 200 && xhr.status < 300 && data.ok !== false, data);
    };
    xhr.onerror = xhr.ontimeout = function () { if (done) done(false, { error: "Clearway companion not reachable" }); };
    xhr.send(body ? JSON.stringify(body) : null);
  }

  // The vPilot plugin listens on Clearway's port - 1 and can start Clearway when it isn't running
  var pluginUp = false, cwStarting = 0, pluginCheckedAt = 0;
  function pluginUrl(path) {
    var m = /^(https?:\/\/[^\/:]+):(\d+)/.exec(API);
    return m ? m[1] + ":" + (parseInt(m[2], 10) - 1) + path : null;
  }
  function pluginGet(path, done) {
    var url = pluginUrl(path);
    if (!url) return done(false, {});
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.timeout = 3000;
    xhr.onload = function () {
      var data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      done(xhr.status === 200, data);
    };
    xhr.onerror = xhr.ontimeout = function () { done(false, {}); };
    xhr.send(null);
  }
  function checkPlugin() {            // only while Clearway is unreachable, every 5 s
    if (reachable || Date.now() - pluginCheckedAt < 5000) return;
    pluginCheckedAt = Date.now();
    pluginGet("/clearway", function (ok, data) {
      var up = ok && data.plugin === "clearway";
      if (up !== pluginUp) { pluginUp = up; render(); }
    });
  }
  function startClearway() {
    if (Date.now() - cwStarting < 30000) return;
    pluginGet("/clearway/start", function (ok, data) {
      if (ok && data.ok) { cwStarting = Date.now(); hint("Starting Clearway in the background...", false, "cw-vp-hint"); }
      else hint(data.error || "The vPilot plugin couldn't start Clearway.", true, "cw-vp-hint");
      render();
    });
  }

  function act(path, body, okHint, hintId, after) {
    request("POST", "/api/" + path, body || {}, function (ok, data) {
      if (okHint !== null) hint(ok ? (okHint || "") : (data.error || "Failed"), !ok, hintId);
      if (after) after(ok, data);
      poll(true);
    });
  }

  // Pause button: no flashing / colour / counters on the icon. Clearway then stops muting the phone.
  var paused = false;
  var introUntil = 0;          // the icon stays fully visible until then (first 10 s after the panel starts)
  function setPaused(on) {
    paused = !!on;
    save("CLEARWAY_PAUSED", paused);
    var b = el("cw-pause");
    b.classList.toggle("paused", paused);
    b.title = paused ? "Notifications muted: click to turn them back on" : "Mute panel notifications";
    if (state) render();
    poll(true);
  }

  function poll(force) {
    request("GET", "/api/state?panel=1&paused=" + (paused ? 1 : 0) + "&since=" + (force ? 0 : version), null, function (ok, data) {
      if (!ok) {
        if (reachable) { reachable = false; pluginCheckedAt = 0; render(); }
        checkPlugin();
        return;
      }
      if (!reachable) { reachable = true; cwStarting = 0; }
      if (data.unchanged) return;
      version = data.version;
      state = data;
      render();
    });
  }

  function readCom() {
    if (typeof SimVar === "undefined") return;
    try {
      var f = function (v) { var n = SimVar.GetSimVarValue(v, "MHz"); return n ? n.toFixed(3) : ""; };
      var b = function (v) { return !!SimVar.GetSimVarValue(v, "Bool"); };
      com = {
        com1: f("COM ACTIVE FREQUENCY:1"), com1_stby: f("COM STANDBY FREQUENCY:1"), com1_tx: b("COM TRANSMIT:1"), com1_rx: b("COM RECEIVE:1"),
        com2: f("COM ACTIVE FREQUENCY:2"), com2_stby: f("COM STANDBY FREQUENCY:2"), com2_tx: b("COM TRANSMIT:2"), com2_rx: b("COM RECEIVE:2")
      };
      xpdr = SimVar.GetSimVarValue("TRANSPONDER STATE:1", "Enum");
      // radio power: COM STATUS is 0 when the radio works (2 = no electricity, 3 = failed, 1 = not fitted). Kept out
      // of `com` (what Clearway is sent); an aircraft that doesn't report it counts as powered
      var st = function (n) { var v = SimVar.GetSimVarValue("COM STATUS:" + n, "Enum"); return typeof v !== "number" || isNaN(v) || v === 0; };
      comPower = { 1: st(1), 2: st(2) };
      // (1.5.0) squawking 7700: the whole panel turns red. Read as Bco16 (gives 7700); the raw BCD value is 0x7700
      var sq = SimVar.GetSimVarValue("TRANSPONDER CODE:1", "Bco16");
      setEmergency(sq === 7700 || sq === 0x7700);
    } catch (e) { return; }
    var key = JSON.stringify(com), now = Date.now();
    if (reachable && (key !== comSentKey || now - comSentAt > 5000)) {   // share with Clearway (phone)
      comSentKey = key; comSentAt = now;
      request("POST", "/api/com", com, null);
    }
    updateFreqChip();
  }

  // 7700: the panel's colours turn red (over whichever theme is set) and a "7700" tag shows next to your callsign
  var emergency = false;
  function setEmergency(on) {
    if (on === emergency) return;
    emergency = on;
    el("cw-root").classList.toggle("emergency", on);
    var tag = el("cw-7700");
    if (tag) tag.classList.toggle("hidden", !on);
    applyTheme();                                       // the 7700 red wins over edited colours too
  }

  // ------------------------------------------------------------ themes (1.5.0: editable colours, Custom)
  // Dark / Black / Light keep their stylesheet colours until edited in Settings; an edited theme (and Custom, always)
  // gets a generated style over them: background, boxes, accent, text, icon background and symbol, transparency.
  // The defaults here are what the editor shows (the 1.4.0 contrast pass colours).
  var THEME_DEFAULTS = {
    dark: { bg: "#050e17", box: "#0b1826", accent: "#96aaff", text: "#e6e9f0", icon_bg: "#0b1826", icon_fg: "#5b9bd5", alpha: 0.75, sea: "#172131", land: "#39424f" },
    black: { bg: "#000000", box: "#0e0e0e", accent: "#96aaff", text: "#e6e9f0", icon_bg: "#0e0e0e", icon_fg: "#cfcfcf", alpha: 0.75, sea: "#161616", land: "#363636" },
    light: { bg: "#e4e8f0", box: "#eff1f5", accent: "#3553d4", text: "#151a26", icon_bg: "#eff1f5", icon_fg: "#3d7bbf", alpha: 0.9, sea: "#2f4052", land: "#56616d" },
    custom: { bg: "#1a1033", box: "#2a1d4d", accent: "#b69cff", text: "#efeaff", icon_bg: "#2a1d4d", icon_fg: "#b69cff", alpha: 0.6, sea: "#1b1430", land: "#3b3352" }
  };
  function rgbOf(h) { h = String(h || "#000000"); return [parseInt(h.substr(1, 2), 16) || 0, parseInt(h.substr(3, 2), 16) || 0, parseInt(h.substr(5, 2), 16) || 0]; }
  function rgba(h, a) { var c = rgbOf(h); return "rgba(" + c[0] + ", " + c[1] + ", " + c[2] + ", " + a + ")"; }
  function mixHex(a, b, t) {
    var x = rgbOf(a), y = rgbOf(b), o = "#";
    for (var i = 0; i < 3; i++) o += ("0" + Math.round(x[i] + (y[i] - x[i]) * t).toString(16)).slice(-2);
    return o;
  }
  function lum(h) {
    var c = rgbOf(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  var themeKey = "";
  function applyTheme() {
    var st = state && state.settings, root = el("cw-root");
    if (!st) return;
    var t = st.theme === "light" || st.theme === "black" || st.theme === "custom" ? st.theme : "dark";
    var edits = (st.theme_colors || {})[t], on = !emergency && (t === "custom" || (edits && Object.keys(edits).length > 0));
    // (1.5.0) the light-background styling (badges, greens, the active tab...) follows the colours actually used: a
    // light custom theme gets it too, and a Light theme edited dark doesn't (they washed out on a light background)
    var bgNow = on ? ((edits && edits.bg) || THEME_DEFAULTS[t].bg) : THEME_DEFAULTS[t].bg;
    root.classList.toggle("light", lum(bgNow) > 0.4);
    root.classList.toggle("black", t === "black");
    var key = on ? t + JSON.stringify(edits || {}) : "";
    root.classList.toggle("cw-themed", on);
    if (key === themeKey) return;
    themeKey = key;
    var tag = document.getElementById("cw-theme-style");
    if (!tag) { tag = document.createElement("style"); tag.id = "cw-theme-style"; document.head.appendChild(tag); }
    if (!on) { tag.textContent = ""; return; }
    var c = {}, d = THEME_DEFAULTS[t];
    for (var k in d) c[k] = (edits && edits[k] !== undefined) ? edits[k] : d[k];
    var P = "#cw-root.cw-themed", I = " !important; ";
    // muted text (status lines, times, hints): the text colour tinted with the accent, so it follows the theme too
    var muted = mixHex(mixHex(c.text, c.accent, 0.35), c.bg, 0.25), onAccent = lum(c.accent) > 0.4 ? "#0b1020" : "#ffffff";
    tag.textContent =
      P + " { --bg: " + c.bg + I + "--surface: " + c.box + I + "--surface-2: " + mixHex(c.box, c.text, 0.08) + I +
        "--line: " + mixHex(c.box, c.text, 0.14) + I + "--text: " + c.text + I + "--muted: " + muted + I +
        "--accent: " + c.accent + I + "--accent-soft: " + rgba(c.accent, 0.16) + I + "--var-text: " + mixHex(c.accent, c.text, 0.3) + I +
        "--bubble: " + c.icon_bg + I + "--bubble-line: " + c.icon_fg + I + "--glyph-off: " + c.icon_fg + I + "--icon-blue: " + c.icon_fg + I +
        "--on-accent: " + onAccent + I + "--unread: " + mixHex(c.bg, "#f5b14c", 0.14) + I + "}\n" +
      [" #cw-card", " #cw-peek", " #cw-com-pop", " #cw-notes-win", " #cw-radar-win"].map(function (s) { return P + s; }).join(", ") +
        " { --bg: " + rgba(c.bg, c.alpha) + I + "--surface: " + rgba(c.box, 0.5) + I + "--surface-2: " + rgba(mixHex(c.box, c.text, 0.1), 0.8) + I +
        "--text: " + c.text + I + "--muted: " + muted + I + "--accent: " + c.accent + I + "--unread: " + rgba(mixHex(c.bg, "#f5b14c", 0.3), 0.5) + I + "}\n" +
      P + " #cw-card.radar-tab { --bg: " + c.bg + I + "--surface: " + c.box + I + "}\n" +
      P + " #cw-peek { background-color: " + rgba(c.bg, Math.max(0.85, c.alpha)) + I + "}\n" +
      P + " #cw-com-pop { background-color: " + mixHex(c.bg, c.box, 0.5) + I + "}\n" +
      // the radar's buttons, readout, cards and ring menu (radar.css --rd-* variables)
      P + " #rd-radar { --rd-bg: " + rgba(mixHex(c.bg, c.box, 0.5), 0.88) + I + "--rd-panel: " + rgba(c.bg, 0.94) + I +
        "--rd-hover: " + rgba(mixHex(c.box, c.text, 0.12), 0.95) + I + "--rd-line: " + mixHex(c.box, c.text, 0.16) + I +
        "--rd-acc-line: " + mixHex(c.box, c.accent, 0.5) + I + "--rd-text: " + c.text + I + "--rd-acc: " + c.accent + I +
        "--rd-muted: " + muted + I + "--rd-dim: " + mixHex(c.text, c.bg, 0.5) + I + "}\n";
  }

  // The aircraft's transponder in the sim: 0 off, 1 standby, 2 test, 3 on, 4 altitude (= Mode C)
  function simTransponder(state) {
    if (typeof SimVar === "undefined") return;
    try { SimVar.SetSimVarValue("TRANSPONDER STATE:1", "Enum", state); } catch (e) { /* aircraft without one */ }
  }
  function simIdent() {
    if (typeof SimVar === "undefined") return;
    try { SimVar.SetSimVarValue("K:XPNDR_IDENT_ON", "number", 1); } catch (e) { /* ignore */ }
  }

  function txFreq() {
    var c = com;
    if (!c && state && state.vpilot && state.vpilot.com) {   // outside the sim: use what Clearway knows
      var s = state.vpilot.com;
      c = { com1: s.com1.active, com1_tx: s.com1.tx, com2: s.com2.active, com2_tx: s.com2.tx };
    }
    if (!c) return "";
    if (c.com1_tx) return c.com1;
    if (c.com2_tx) return c.com2;
    return c.com1;
  }


  function updateFreqChip() {
    updateRadioBtn();
    var chip = document.querySelector('.cw-chip-tab[data-chat="FREQ"] .cw-chip-freq');
    if (chip) chip.textContent = txFreq() ? " " + txFreq() : "";
    var pop = el("cw-com-pop");
    if (!com) { pop.innerHTML = "<div class=\"cw-com-row\">Radios are read from the sim (MSFS only).</div>"; return; }
    var row = function (n) {
      return "<div class=\"cw-com-row\"><b>COM" + n + "</b><span class=\"cw-freq\">" + (com["com" + n] || "---.---") + "</span>" +
        // TX = transmitting on this radio, RX = listening to it (each shown when on, greyed when off)
        "<span class=\"cw-com-tx" + (com["com" + n + "_tx"] ? "" : " off") + "\">TX</span>" +
        "<span class=\"cw-com-tx rx" + (com["com" + n + "_rx"] ? "" : " off") + "\">RX</span></div>";
    };
    pop.innerHTML = row(1) + row(2);
  }
  // the radios popup under `anchor` (frequency tab or header icon), kept inside the card
  function showComPop(anchor) {
    updateFreqChip();
    var pop = el("cw-com-pop"), card = el("cw-card");
    pop.classList.remove("hidden");
    var c = card.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    var maxLeft = card.clientWidth - pop.offsetWidth - 6;
    pop.style.left = Math.max(6, Math.min(a.left - c.left, maxLeft)) + "px";
    pop.style.top = (a.bottom - c.top + 4) + "px";
  }

  // The radio icon in the header: lit (teal) when a controller is on the frequency you transmit on, amber for a few
  // seconds when text arrives on that frequency. vPilot doesn't tell plugins about voice (push-to-talk or someone
  // talking), so only these two can be shown. A class change on the 1 s radio check: no measurable cost
  function updateRadioBtn() {
    var b = el("cw-radio-btn");
    if (!b) return;
    var f = txFreq(), vp = (state && state.vpilot) || {}, tuned = false, who = "";
    // which radio you transmit on (COM2 only when COM2 alone transmits, as txFreq) and whether it has power
    var c = com || {}, two = !!(c.com2_tx && !c.com1_tx);
    var off = !!(comPower && !comPower[two ? 2 : 1]);
    b.classList.toggle("c2", two);
    var fq = document.querySelector('.cw-chip-tab[data-chat="FREQ"]');
    if (fq) { fq.classList.toggle("c2", two); fq.classList.toggle("off", off); }
    b.classList.toggle("off", off);
    if (off) {
      b.classList.remove("tuned"); b.classList.remove("rx"); b.classList.remove("unicom"); b.classList.remove("guard");
      b.title = "COM" + (two ? 2 : 1) + " has no power - hover for COM1 / COM2";
      return;
    }
    if (f && vp.connected) {
      (vp.controllers || []).forEach(function (c) {
        if (c.frequency && Number(c.frequency).toFixed(3) === Number(f).toFixed(3)) { tuned = true; who = who || c.callsign; }
      });
    }
    var rx = false, msgs = state && state.messages;
    if (f && msgs) {
      for (var i = msgs.length - 1; i >= 0 && i > msgs.length - 15; i--) {
        var m = msgs[i];
        if (m.kind !== "radio" || m.dir !== "in") continue;
        if (Date.now() - m.ts < 4000) rx = true;          // message times are in ms
        break;
      }
    }
    // always-open frequencies: UNICOM 122.800 (blue) and guard 121.500 (orange), when no controller is on them
    var ff = f ? Number(f).toFixed(3) : "", unicom = !tuned && ff === "122.800", guard = !tuned && ff === "121.500";
    b.classList.toggle("tuned", tuned && !rx);
    b.classList.toggle("unicom", unicom && !rx);
    b.classList.toggle("guard", guard && !rx);
    b.classList.toggle("rx", rx);
    b.title = (f ? "Transmitting on " + f + " (COM" + (two ? 2 : 1) + ")" : "Radios") + (tuned ? ", " + who : unicom ? ", Unicom" : guard ? ", Guard" : "") +
      " - hover for COM1 / COM2";
  }

  function sendPosition() {
    if (typeof SimVar === "undefined" || !reachable) return;
    try {
      var lat = SimVar.GetSimVarValue("PLANE LATITUDE", "degree latitude");
      var lon = SimVar.GetSimVarValue("PLANE LONGITUDE", "degree longitude");
      var alt = SimVar.GetSimVarValue("PLANE ALTITUDE", "feet");
      if (typeof lat === "number" && (lat !== 0 || lon !== 0)) {
        request("POST", "/api/position", { lat: lat, lon: lon, alt: alt }, null);
      }
    } catch (e) { /* sim not ready */ }
  }

  // ------------------------------------------------------------ helpers
  // The sim's panel font lacks some symbols; swap them for plain ones before display.
  function plain(s) {
    return String(s == null ? "" : s).replace(/\u2026/g, "...").replace(/\u2192/g, "to").replace(/\u00d7/g, "x")
      .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, "\"").replace(/[\u2013\u2014\u00b7]/g, "-");
  }
  var TICK_ICON = "<svg class=\"cw-ti\" viewBox=\"0 0 12 12\"><path d=\"M2.5 6.4l2.4 2.4 4.6-5\"/></svg>";
  var X_ICON = "<svg class=\"cw-xi\" viewBox=\"0 0 10 10\"><path d=\"M2 2l6 6M8 2l-6 6\"/></svg>";
  // the frequency chat's tab: a radio (a dot sending waves both ways) instead of the word FREQ, to save room
  var RADIO_ICON = "<svg class=\"cw-radio-i\" viewBox=\"0 0 20 14\"><circle cx=\"10\" cy=\"7\" r=\"1.7\"/>" +
    "<path d=\"M6.6 3.6a4.8 4.8 0 0 0 0 6.8M13.4 3.6a4.8 4.8 0 0 1 0 6.8M3.8 1.2a8.4 8.4 0 0 0 0 11.6M16.2 1.2a8.4 8.4 0 0 1 0 11.6\"/></svg>";
  function esc(s) {
    return plain(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(t) {
    return esc(t).replace(/@([^@\n]*)@/g, function (_, v) { return v.trim() ? "<span class=\"cw-var\">" + v + "</span>" : ""; }).replace(/@/g, " ");
  }
  function utc(ms) {
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getUTCHours()) + p(d.getUTCMinutes()) + "z";
  }
  function findMsg(id) {
    if (!state) return null;
    for (var i = 0; i < state.messages.length; i++) if (state.messages[i].id === id) return state.messages[i];
    return null;
  }
  function hint(text, err, id) {
    var h = el(id || (tab === "vpilot" ? "cw-vp-hint" : "cw-hint"));
    if (!h) return;
    h.textContent = plain(text || "");
    h.style.color = err ? "var(--rose)" : "var(--muted)";
    h.classList.toggle("on", !!text);            // the vPilot one floats above the message box while it has text
    var key = id || "default";
    clearTimeout(hintTimers[key]);
    if (text) hintTimers[key] = setTimeout(function () { h.textContent = ""; h.classList.remove("on"); }, err ? 9000 : 4000);
  }
  function attr(t, name) { return t && t.getAttribute ? t.getAttribute(name) : null; }
  function pick(t, name) { var n = t && t.closest ? t.closest("[" + name + "]") : null; return n ? n.getAttribute(name) : null; }
  function up(t, selector) { return t && t.closest ? t.closest(selector) : null; }

  // ------------------------------------------------------------ render: shell
  function render() {
    applyTheme();
    checkPanelReset();
    var vpCount = reachable && state ? (state.unacked_vpilot || 0) : 0;
    var cpCount = reachable && state ? (state.unacked_cpdlc || 0) : 0;
    var bubble = el("cw-bubble");
    var status = !reachable ? "offline" : (state ? state.status : "offline");
    var vpOnline = reachable && state && state.vpilot && state.vpilot.connected;
    // vPilot messages meant for me (private chats, SELCAL, frequency text with my callsign) colour the icon;
    // the rest (new frequency text for others, broadcasts) only show a small grey dot at its bottom left
    var vpMine = 0;
    if (vpCount && state) for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      if (m.dir === "in" && !m.acked && (m.kind === "pm" || m.kind === "selcal" || (m.kind === "radio" && m.mention))) vpMine++;
    }
    var vpOther = vpCount - vpMine + (reachable && state ? (state.quiet_vpilot || 0) : 0);

    bubble.className = "";
    if (status === "online" || vpOnline) bubble.classList.add("online");
    if (!reachable) bubble.classList.add("error");
    if (!vpOnline) bubble.classList.add("novatsim");     // the faint icon turns yellow while not on VATSIM
    if (paused) {
      // notifications paused: the icon stays faint and quiet (no flash, colour or counters)
      bubble.classList.add("paused");
      if (!expanded) bubble.classList.add("idle");
    } else {
      // first seconds after the panel opens: fully visible so it's easy to find, then the usual faint icon
      var anyUnread = vpMine > 0 || cpCount > 0 || vpOther > 0;
      if (!anyUnread && !expanded && Date.now() >= introUntil) bubble.classList.add("idle");   // nearly invisible until needed
      // a new message colours the quarter under its pill (no flashing): cyan top left for vPilot messages to me,
      // amber top right for CPDLC. With the card closed the rest of the icon fades away until hovered.
      // vPilot messages that aren't for me: no colour, only the grey dot (faint by colours, not opacity, so the dot shows)
      if (vpMine > 0) bubble.classList.add("q-vp");
      if (cpCount > 0) bubble.classList.add("q-cp");
      if (anyUnread && !expanded && Date.now() >= introUntil) bubble.classList.add("q-faint");
    }
    // start-up window open (TSAT -5 to +5 min) and not seen yet: the icon turns electric yellow-green
    tsatAlertOn = tsatAlert();
    if (tsatAlertOn) { bubble.classList.remove("idle"); bubble.classList.remove("q-faint"); bubble.classList.add("alert-tsat"); }
    // after that, until the flight is activated: a ring counting down the rest of the start-up window, then orange
    updateTsatRing();
    lastVp = vpMine + vpOther; lastCp = cpCount;
    el("cw-odot").classList.toggle("hidden", paused || !vpOther || vpMine > 0 || cpCount > 0);
    var cs = myCallsign(), bcs = el("cw-bub-cs");
    if (bcs.textContent !== cs) bcs.textContent = cs;
    bcs.classList.toggle("hidden", !cs);
    setDot("cw-ndot-vp", paused ? 0 : vpMine); setDot("cw-ndot-cp", paused ? 0 : cpCount);
    checkUrgent();                                                    // "contact me" / SELCAL: their peek opens by itself
    setDot("cw-tdot-vp", vpCount); setDot("cw-tdot-cp", cpCount);

    renderVpilot();
    renderCpdlc();
    renderSelcal();
    renderNotes();
    checkTsat();
    if (expanded) placeCard();
  }

  function setDot(id, n) {
    var d = el(id);
    d.textContent = n > 9 ? "9+" : String(n);
    d.classList.toggle("hidden", !n);
  }

  function showTab(t) {
    releaseKeyboard();
    tab = t;
    save("CLEARWAY_TAB", t);
    var tabs = el("cw-head").getElementsByClassName("cw-tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("on", attr(tabs[i], "data-tab") === t && !notesOpen);
    el("cw-pane-vpilot").classList.toggle("hidden", t !== "vpilot" || notesOpen);
    el("cw-pane-cpdlc").classList.toggle("hidden", t !== "cpdlc" || notesOpen);
    el("cw-pane-selcal").classList.toggle("hidden", t !== "selcal" || notesOpen);
    el("cw-pane-radar").classList.toggle("hidden", t !== "radar" || notesOpen);
    // Radar tab: the card's shared size, or twice as wide and taller when expanded (.radar); in its own window
    // a short note is shown instead. .radar-tab keeps the Radar tab opaque either way
    var radarHere = t === "radar" && !notesOpen && !radarDetached;
    el("cw-card").classList.toggle("radar", radarHere && radarBig);
    el("cw-card").classList.toggle("radar-tab", radarHere);
    el("cw-notes").classList.toggle("hidden", !notesOpen);
    el("cw-notes-btn").classList.toggle("on", notesOpen);
    if (!notesOpen || notesDetached) resetNotesGrow();   // leaving the notepad: the card's normal size again
    lastChatKey = "";
    if (state) render();
    if (t === "cpdlc" && reqOpen && !notesOpen) renderFields();   // the request fields measured once they show
    placeCard();
    updateCardGrip();
  }

  // ------------------------------------------------------------ render: vPilot
  function vpMessages() {
    var out = [];
    if (!state) return out;
    for (var i = 0; i < state.messages.length; i++) if (VP[state.messages[i].kind]) out.push(state.messages[i]);
    return out;
  }

  function chatList() {
    var msgs = vpMessages();
    var chats = { FREQ: { unread: 0, last: 0 } };
    var order = ["FREQ"];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i], c = m.chat || "FREQ";
      if (!chats[c]) { chats[c] = { unread: 0, last: 0 }; order.push(c); }
      chats[c].last = Math.max(chats[c].last, m.id);
      if (m.dir === "in" && !m.acked) chats[c].unread++;
    }
    for (var j = 0; j < openedChats.length; j++) {
      if (!chats[openedChats[j]]) { chats[openedChats[j]] = { unread: 0, last: 0 }; order.push(openedChats[j]); }
    }
    var visible = [];
    for (var k = 0; k < order.length; k++) {
      var name = order[k];
      var hidden = name !== "FREQ" && closedChats[name] !== undefined && chats[name].last <= closedChats[name] && name !== activeChat;
      if (!hidden) visible.push({ name: name, unread: chats[name].unread });
    }
    return visible;
  }

  // "Connect as observer" tickbox: an observer only needs a callsign
  var observerTick = null;
  function setObserverTick(on) {
    observerTick = on;
    el("cw-vp-obs").classList.toggle("on", on);
    el("cw-vp-type-in").classList.toggle("dim", on);
    el("cw-vp-selcal-in").classList.toggle("dim", on);
  }

  function renderVpilot() {
    var vp = (state && reachable && state.vpilot) || {};
    el("cw-vp-dot").className = "cw-dot " + (!reachable ? "error" : !vp.active ? "" : vp.connected ? "online" : "connecting");
    // Clearway not running: a Start button when the vPilot plugin can start it (green while it starts)
    var cwRun = el("cw-cw-run");
    if (reachable) cwStarting = 0;
    var starting = !reachable && Date.now() - cwStarting < 30000;
    cwRun.className = "cw-mini wide cw-cw-run" + (reachable || (!pluginUp && !starting) ? " hidden" : starting ? " starting" : "");
    cwRun.textContent = starting ? "Starting..." : "Start";
    el("cw-vp-cs").textContent = !reachable ? "Clearway not running" : !vp.active ? "vPilot not opened / plugin not found" :
      vp.connected ? vp.callsign + (vp.observer ? " (observer)" : "") : "vPilot offline";
    // flight plan on VATSIM for this callsign: green tick filed, red cross not filed (or only a prefile).
    // Hidden until VATSIM's data has your callsign (fp_status null), and for observers.
    var fpWarn = el("cw-fp-warn"), fpShow = !!(vp.connected && !vp.observer && vp.fp_status), fpOk = vp.fp_status === "filed";
    fpWarn.className = "cw-fp-warn" + (fpShow ? "" : " hidden") + (fpOk ? " ok" : "");
    fpWarn.innerHTML = "FP status" + (fpOk ? TICK_ICON : X_ICON);
    fpWarn.title = fpOk ? "Flight plan filed on VATSIM for " + (vp.callsign || "this callsign")
      : vp.fp_status === "prefiled" ? "Only a prefile on VATSIM: the flight plan isn't active for this connection"
      : "No flight plan filed on VATSIM for " + (vp.callsign || "this callsign");
    var conn = el("cw-vp-conn");
    conn.textContent = vp.connected ? "Disconnect" : "Connect";
    conn.classList.toggle("danger", !!vp.connected);
    conn.classList.toggle("disabled", !vp.active);
    // vPilot start button: red while vPilot is closed (click starts it in the background), green once it's open
    // power button: red (closed, click to start) > yellow (starting) > green (open, click to close) > yellow (closing) > red
    var run = el("cw-vp-run"), open = vp.running === true;
    if (!open || Date.now() > vpClosingUntil) vpClosingUntil = 0;           // closed (or gave up waiting): no longer closing
    // vPilot's window is up a few seconds before its plugin reports in ("vPilot not opened" -> "vPilot offline"): stay
    // yellow until it does (30 s at most, so a missing plugin doesn't leave it yellow forever)
    if (!open) vpOpenSince = 0; else if (!vpOpenSince) vpOpenSince = Date.now();
    var loading = open && !vp.active && Date.now() - vpOpenSince < 30000;
    var closing = open && vpClosingUntil > 0, wait = vp.starting || loading || closing;
    run.className = "cw-mini cw-vp-run" + (!reachable || vp.running == null ? " hidden" : wait ? " starting" : open ? " open" : "");
    run.title = closing ? "vPilot is closing..." : vp.starting || loading ? "vPilot is starting..." : open ? "vPilot is open: click to close it" : "Start vPilot";
    if (!open && !el("cw-vp-close-ask").classList.contains("hidden")) el("cw-vp-close-ask").classList.add("hidden");   // already gone
    // Mode C / standby / ident asked from anywhere (phone, dot command, these buttons): set the aircraft's
    // transponder in the sim too, since vPilot follows it. The first state seen is only remembered.
    if (typeof vp.modec_n === "number") {
      if (lastModecN !== null && vp.modec_n !== lastModecN && typeof vp.modec_req === "boolean") simTransponder(vp.modec_req ? 4 : 1);
      lastModecN = vp.modec_n;
    }
    if (typeof vp.ident_n === "number") {
      if (lastIdentN !== null && vp.ident_n !== lastIdentN) simIdent();
      lastIdentN = vp.ident_n;
    }
    // in the sim, the buttons show the aircraft's real transponder (what vPilot sends); elsewhere the last command
    var modeC = typeof xpdr === "number" && !isNaN(xpdr) ? xpdr >= 3 : vp.modec;
    el("cw-vp-sby").classList.toggle("on", modeC === false);
    el("cw-vp-c").classList.toggle("on", modeC === true);
    ["cw-vp-sby", "cw-vp-c", "cw-vp-id"].forEach(function (id) { el(id).classList.toggle("disabled", !vp.connected || !!vp.observer); });
    if (vp.connected) {
      el("cw-vp-connect").classList.add("hidden");
      if (/^Connecting/.test(el("cw-vp-hint").textContent)) hint("", false, "cw-vp-hint");
    }
    var last = vp.last || {}, f = (state && state.flight) || {};
    // type and SELCAL: from your VATSIM flight plan (matched by your CID) when there is one, else your last connection.
    // A value filled in this way follows the flight plan when it arrives or changes; one you typed is never touched
    var vfp = (state && state.selcal && state.selcal.vatsim_fp) || {};
    prefillInput("cw-vp-cs-in", last.callsign || (state && state.callsign));
    autoInput("cw-vp-type-in", vfp.type || last.type || f.aircraft);
    autoInput("cw-vp-selcal-in", vfp.selcal ? fmtSelcal(vfp.selcal) : last.selcal ? fmtSelcal(last.selcal) : "");
    if (observerTick === null && state && state.vpilot) setObserverTick(!!last.observer);   // last choice
    renderVpSimbrief();

    var chats = chatList(), found = false, html = "";
    for (var i = 0; i < chats.length; i++) if (chats[i].name === activeChat) found = true;
    if (!found) activeChat = "FREQ";
    // ATC on the left (its count stands out when controllers are online), private chats, frequency on the right
    var n = vp.controllers ? vp.controllers.length : 0;
    html += "<div class=\"cw-chip-tab atc" + (atcOpen ? " on" : "") + (n ? " has" : "") + "\" data-atc-toggle=\"1\">ATC" +
      (n ? "<span class=\"cw-atc-n\">" + n + "</span>" : "") + "</div>";
    // with the ATC list open, its type filters sit on this row, next to ATC (the private chats come back when it closes)
    if (atcOpen) html += atcFiltersHtml(vp.controllers || []);
    var chip = function (c) {
      return "<div class=\"cw-chip-tab" + (c.name === "FREQ" ? " freq" : "") + (c.name === activeChat && !atcOpen ? " on" : "") + "\" data-chat=\"" + esc(c.name) + "\">" +
        (c.name === "FREQ" ? "<span class=\"cw-radio-wrap\">" + RADIO_ICON + "<span class=\"cw-c2\">2</span></span><span class=\"cw-chip-freq\">" + (txFreq() ? " " + txFreq() : "") + "</span>" : esc(c.name)) +
        (c.unread && (c.name !== activeChat || atcOpen) ? "<span class=\"cw-tdot vp\">" + c.unread + "</span>" : "") +
        (c.name !== "FREQ" ? "<span class=\"cw-chip-x\" data-closechat=\"" + esc(c.name) + "\">" + X_ICON + "</span>" : "") + "</div>";
    };
    for (var j = 0; j < chats.length; j++) if (chats[j].name !== "FREQ" && !atcOpen) html += chip(chats[j]);
    for (var j2 = 0; j2 < chats.length; j2++) if (chats[j2].name === "FREQ") html += chip(chats[j2]);
    el("cw-vp-chips").innerHTML = html;
    updateRadioBtn();           // COM2 / no-power marks on the new frequency tab
    fitChips();

    el("cw-vp-chat").classList.toggle("hidden", atcOpen);
    el("cw-vp-atc").classList.toggle("hidden", !atcOpen);
    // observers can't transmit on the frequency: only dot commands there, text goes in private chats
    var obsFreq = !!(vp.connected && vp.observer && activeChat === "FREQ");
    el("cw-vp-input").placeholder = obsFreq ? "Observer: private messages only (or a .command)"
      : activeChat === "FREQ" ? "Message, or a .command" : "To " + activeChat + ", or a .command";
    el("cw-vp-send").classList.toggle("disabled", obsFreq && !/^\s*\./.test(el("cw-vp-input").value));
    if (atcOpen) renderAtc(vp); else renderChat();

    // reading the chat on screen marks it read
    if (expanded && tab === "vpilot" && !notesOpen && !atcOpen) {
      for (var k = 0; k < chats.length; k++) {
        // (new frequency text for others counts too: it clears the icon's grey dot)
        var fresh = chats[k].unread || (activeChat === "FREQ" && state && state.quiet_vpilot);
        if (chats[k].name === activeChat && fresh && !ackPending[activeChat]) {
          ackPending[activeChat] = true;
          (function (chat) { act("ack", { chat: chat }, null, null, function () { delete ackPending[chat]; }); })(activeChat);
        }
      }
    }
  }

  function prefillInput(id, v) {
    var i = el(id);
    if (i && !i.value && v && document.activeElement !== i) i.value = v;
  }
  // like prefillInput, but keeps following its source while the field still holds the value it put there
  function autoInput(id, v) {
    var i = el(id);
    if (!i || !v || document.activeElement === i) return;
    var auto = i.getAttribute("data-auto");
    if (!i.value || (auto !== null && i.value === auto)) {
      if (i.value !== v) i.value = v;
      i.setAttribute("data-auto", v);
    }
  }

  // Grey status lines ("Connecting...", "Connected to Hoppie as ...") fade out 30 s after they arrive: they don't count
  // in the card's height, so left on screen they pushed real messages out of view. (In the panel only: the phone keeps
  // them.) Message times are in ms
  var SYS_SHOW_MS = 30000;
  function sysOld(m) { return Date.now() - (m.ts || 0) > SYS_SHOW_MS + 1000 ? " gone" : ""; }
  function fadeSysLines() {
    var lines = document.getElementsByClassName("cw-sys"), now = Date.now(), changed = false;
    for (var i = 0; i < lines.length; i++) {
      var age = now - (+lines[i].getAttribute("data-ts") || 0);
      if (age > SYS_SHOW_MS + 1000 && !lines[i].classList.contains("gone")) { lines[i].classList.add("gone"); changed = true; }
      else if (age > SYS_SHOW_MS && !lines[i].classList.contains("fading")) lines[i].classList.add("fading");
    }
    if (changed && expanded) placeCard();
  }

  function vpBubble(m) {
    var time = "<span class=\"cw-time\">" + utc(m.ts) + "</span>";
    if (m.kind === "vsys") return "<div class=\"cw-sys" + sysOld(m) + "\" data-ts=\"" + (m.ts || 0) + "\">" + esc(m.text) + "</div>";
    if (m.kind === "vinfo") return "<div class=\"cw-vinfo\"><div class=\"cw-meta\"><span class=\"cw-station\">" + esc(m.station) + "</span>" + time + "</div><div class=\"cw-pre\">" + esc(m.text) + "</div></div>";
    if (m.kind === "selcal") return "<div class=\"cw-valert selcal\"><b>SELCAL</b> " + esc(m.station) + " - " + esc(m.text) + "</div>";
    if (m.kind === "broadcast") return "<div class=\"cw-valert broadcast\"><b>Broadcast</b> " + esc(m.station) + ": " + esc(m.text) + "</div>";
    var out = m.dir === "out";
    var st = "";
    if (out && m.status === "sending") st = "Sending...";
    if (out && m.status === "failed") st = "Not delivered" + (m.error ? ": " + esc(m.error) : "");
    var who = out ? (m.station === "SUPERVISORS" ? "You to supervisors" : "You") : esc(m.station);
    return "<div class=\"cw-vmsg " + (out ? "out" : "in") + (m.mention ? " mention" : "") + (!out && !m.acked ? " unread" : "") + "\">" +
      "<div class=\"cw-meta\"><span class=\"cw-station\">" + who + "</span>" + (m.freq ? "<span class=\"cw-freq\">" + esc(m.freq) + "</span>" : "") + time + "</div>" +
      "<div class=\"cw-vtext\">" + esc(m.text) + "</div>" + (st ? "<div class=\"cw-state\">" + st + "</div>" : "") + "</div>";
  }

  function renderChat() {
    var box = el("cw-vp-chat");
    var msgs = vpMessages().filter(function (m) { return (m.chat || "FREQ") === activeChat; });
    var key = activeChat + ":" + msgs.map(function (m) { return m.id + m.status + (m.acked ? 1 : 0); }).join(",");
    if (key === lastChatKey) return;
    lastChatKey = key;
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = msgs.length ? msgs.slice(-60).map(vpBubble).join("")
      : "<div class=\"cw-empty\">" + (activeChat === "FREQ" ? "Frequency text and controller info appear here." : "No messages with " + esc(activeChat) + " yet.") + "<br/>Type .help for commands.</div>";
    if (nearBottom || !box.getAttribute("data-scrolled")) { box.scrollTop = box.scrollHeight; box.setAttribute("data-scrolled", "1"); }
  }

  // ATC list (1.4.0): filter chips by type (only the types online), two columns, Prim / Stby / Chat on each.
  // The type is the callsign's last part (LFMN_NO_APP = APP); a ramp (RMP) counts as ground
  var ATC_TYPES = ["ATIS", "DEL", "GND", "TWR", "APP", "DEP", "CTR", "FSS"];
  var atcFilter = "ALL";
  function atcType(cs) {
    var t = String(cs).toUpperCase().split("_").pop();
    if (t === "RMP") t = "GND";
    return ATC_TYPES.indexOf(t) >= 0 ? t : "";
  }
  function atcInfoHtml(c) {
    var body = c.info && c.info.length ? esc(c.info.join("\n"))
      : (c.info_pending || !c.info ? "Requesting information..." : "No controller information.");
    // top right: the controller's name as they show it on VATSIM (full name, first name or CID)
    return "<div class=\"cw-atc-info wide\" data-for=\"" + esc(c.callsign) + "\"><span class=\"cw-atc-who\">" + esc(c.callsign) + (c.name ? " · " + esc(c.name) : "") + "</span>" + body + "</div>";
  }
  // The chip row with the ATC list open (ATC, its filters, the frequency tab): when it doesn't fit on one line, the
  // frequency tab drops its frequency and shows only the radio icon
  function fitChips() {
    var row = el("cw-vp-chips"), fq = row.querySelector('.cw-chip-tab[data-chat="FREQ"]');
    if (!fq) return;
    fq.classList.remove("compact");
    var first = row.firstChild;
    if (atcOpen && first && fq.offsetTop > first.offsetTop + first.offsetHeight / 2) fq.classList.add("compact");
  }
  // the filter chips (on the vPilot chip row, next to ATC): All, then only the types online. A filter whose type went
  // offline falls back to All
  function atcFiltersHtml(list) {
    var online = {};
    list.forEach(function (c) { var t = atcType(c.callsign); if (t) online[t] = (online[t] || 0) + 1; });
    if (atcFilter !== "ALL" && !online[atcFilter]) atcFilter = "ALL";
    if (!list.length) return "";
    var html = "<div class=\"cw-atc-f" + (atcFilter === "ALL" ? " on" : "") + "\" data-atcf=\"ALL\">All</div>";
    ATC_TYPES.forEach(function (t) {
      if (online[t]) html += "<div class=\"cw-atc-f" + (atcFilter === t ? " on" : "") + "\" data-atcf=\"" + t + "\">" + t + "</div>";
    });
    return html;
  }
  // after a controller is opened: scroll its information into view (again when it arrives, for a few seconds)
  var atcReveal = { cs: "", until: 0 };
  function revealAtcInfo() {
    if (!atcReveal.cs || Date.now() > atcReveal.until || !atcOpenRows[atcReveal.cs]) return;
    var box = el("cw-vp-atc"), info = box.querySelector('.cw-atc-info[data-for="' + atcReveal.cs + '"]');
    var cell = box.querySelector('.cw-atc-top[data-atc="' + atcReveal.cs + '"]');
    if (!info || !cell) return;
    var b = box.getBoundingClientRect(), top = cell.getBoundingClientRect().top - b.top, bottom = info.getBoundingClientRect().bottom - b.top;
    if (bottom > box.clientHeight) box.scrollTop += Math.min(bottom - box.clientHeight + 4, top);   // never past the cell
    else if (top < 0) box.scrollTop += top;
  }
  function renderAtc(vp) {
    var list = (vp.controllers || []).slice();
    if (!list.length) {
      el("cw-vp-atc").innerHTML = "<div class=\"cw-empty\">" + (vp.connected ? "No controllers in range." : "Connect vPilot to see nearby controllers.") + "</div>";
      return;
    }
    var rank = function (c) { var i = ATC_TYPES.indexOf(atcType(c.callsign)); return i < 0 ? 99 : i; };
    list.sort(function (a, b) { return rank(a) - rank(b) || (a.callsign < b.callsign ? -1 : a.callsign > b.callsign ? 1 : 0); });
    var html = "<div class=\"cw-atc-grid\">";
    var shown = list.filter(function (c) { return atcFilter === "ALL" || atcType(c.callsign) === atcFilter; });
    var c1 = com || {}, vc = state && state.vpilot && state.vpilot.com;
    if (!com && vc && vc.com1 && vc.com2) {      // outside the sim: the radios Clearway knows (as txFreq)
      c1 = { com1: vc.com1.active, com1_stby: vc.com1.standby, com1_tx: vc.com1.tx,
             com2: vc.com2.active, com2_stby: vc.com2.standby, com2_tx: vc.com2.tx };
    }
    var txCom2 = !!(c1.com2_tx && !c1.com1_tx);
    var actF = txCom2 ? c1.com2 : c1.com1, stbyF = txCom2 ? c1.com2_stby : c1.com1_stby;
    for (var i = 0; i < shown.length; i += 2) {
      var pair = shown.slice(i, i + 2), infos = "";
      pair.forEach(function (c) {
        var open = !!atcOpenRows[c.callsign], f = String(c.frequency || "");
        var isAct = f && actF === Number(f).toFixed(3), isStby = f && stbyF === Number(f).toFixed(3);
        html += "<div class=\"cw-atc-cell" + (open ? " open" : "") + "\">" +
          "<div class=\"cw-atc-top\" data-atc=\"" + esc(c.callsign) + "\" title=\"Show controller information\">" +
          "<span class=\"cw-atc-cs\">" + esc(c.callsign) + "</span><span class=\"cw-atc-arrow\"></span></div>" +
          "<div class=\"cw-atc-bot\"><span class=\"cw-freq\">" + esc(f) + "</span>" +
          "<span class=\"cw-atc-acts\">" +
          "<span class=\"cw-link cw-tune" + (isAct ? " set" : "") + "\" data-tune=\"pri\" data-f=\"" + esc(f) + "\" title=\"Set as active frequency\">Prim</span>" +
          "<span class=\"cw-link cw-tune" + (isStby ? " set" : "") + "\" data-tune=\"stby\" data-f=\"" + esc(f) + "\" title=\"Set as standby frequency\">Stby</span>" +
          "<span class=\"cw-link\" data-chatwith=\"" + esc(c.callsign) + "\">Chat</span></span></div></div>";
        if (open) infos += atcInfoHtml(c);
      });
      html += infos;      // the information of an open controller: full width, under its row
    }
    el("cw-vp-atc").innerHTML = html + "</div>";
  }

  // Tune the radio you transmit on (COM1, or COM2 when only COM2 transmits): active or standby frequency
  function tuneCom(which, freq) {
    var hz = Math.round(parseFloat(freq) * 1000) * 1000;
    if (!hz || typeof SimVar === "undefined") return;
    var two = !!(com && com.com2_tx && !com.com1_tx);
    var ev = which === "pri" ? (two ? "K:COM2_RADIO_SET_HZ" : "K:COM_RADIO_SET_HZ") : (two ? "K:COM2_STBY_RADIO_SET_HZ" : "K:COM_STBY_RADIO_SET_HZ");
    try { SimVar.SetSimVarValue(ev, "Hz", hz); } catch (e) { return; }
    setTimeout(function () { readCom(); renderVpilot(); }, 300);
  }

  // expand/collapse a controller; fetch their information when it's missing or older than 5 minutes
  function toggleAtc(callsign) {
    atcOpenRows[callsign] = !atcOpenRows[callsign];
    if (atcOpenRows[callsign]) {
      var list = (state && state.vpilot && state.vpilot.controllers) || [], c = null;
      for (var i = 0; i < list.length; i++) if (list[i].callsign === callsign) c = list[i];
      if (!c || !c.info || c.info_age === null || c.info_age > 300) act("vp/atis", { callsign: callsign, quiet: true }, null);
      atcReveal = { cs: callsign, until: Date.now() + 4000 };
    }
    renderVpilot();
    placeCard();
  }

  function openChat(c) {
    c = String(c).toUpperCase();
    if (c !== "FREQ" && openedChats.indexOf(c) < 0) { openedChats.push(c); save("CLEARWAY_CHATS", openedChats); }
    if (closedChats[c] !== undefined) { delete closedChats[c]; save("CLEARWAY_CLOSED", closedChats); }
    activeChat = c; atcOpen = false; lastChatKey = "";
    renderVpilot();
    el("cw-vp-input").focus();
  }

  function closeChat(c) {
    if (c === "FREQ") return;
    var msgs = vpMessages().filter(function (m) { return m.chat === c; });
    closedChats[c] = msgs.length ? msgs[msgs.length - 1].id : 0;
    var names = Object.keys(closedChats);                       // keep the saved list small
    while (names.length > 50) delete closedChats[names.shift()];
    openedChats = openedChats.filter(function (x) { return x !== c; });
    save("CLEARWAY_CHATS", openedChats); save("CLEARWAY_CLOSED", closedChats);
    if (activeChat === c) activeChat = "FREQ";
    lastChatKey = "";
    renderVpilot();
  }

  function sendVp() {
    var input = el("cw-vp-input");
    var text = input.value.replace(/\s+/g, " ").trim();   // vPilot messages are one line
    if (!text) return;
    var vpS = (state && state.vpilot) || {};
    if (vpS.connected && vpS.observer && activeChat === "FREQ" && text.charAt(0) !== ".") {
      return hint("Observers can't transmit on the frequency: open a private chat (ATC list > Chat, or .chat CALLSIGN).", true, "cw-vp-hint");
    }
    act("vp/command", { text: text, chat: activeChat }, "", "cw-vp-hint", function (ok, data) {
      if (!ok) return;
      input.value = "";
      autoGrow(input);
      input.focus();   // keep typing after Send (clicking the button took the focus away)
      if (data.open) openChat(data.open);
      if (data.close) closeChat(activeChat);
      if (data.copy) hint("Copy isn't available in the sim; use the phone or PC page.", true, "cw-vp-hint");
    });
  }

  // ------------------------------------------------------------ render: CPDLC
  // Hoppie: green tick when Clearway is connected to Hoppie with your code, red cross otherwise (no code, wrong
  // code, offline). Click to type or paste the code (hidden field).
  var hopOpen = false;
  function renderHoppie() {
    var set = !!(state && state.settings && state.settings.hoppie_logon_set);
    var ok = !!(state && reachable && set && state.status === "online" && !state.error);
    var b = el("cw-hop");
    b.className = "cw-hop " + (ok ? "ok" : "bad") + (hopOpen ? " open" : "");
    el("cw-hop-ic").innerHTML = ok ? TICK_ICON : X_ICON;
    b.title = !reachable ? "Clearway not running" : !set ? "No Hoppie logon code yet: click to enter it"
      : ok ? "Connected to Hoppie (click to change the code)" : "Not connected to Hoppie" + (state && state.error ? ": " + plain(state.error) : "") + " (click to change the code)";
    el("cw-hop-row").classList.toggle("hidden", !hopOpen);
  }
  function saveHoppie() {
    var code = el("cw-hop-in").value.trim();
    if (!code) return hint("Type or paste your Hoppie logon code.", true, "cw-hop-hint");
    act("settings", { hoppie_logon: code }, "", "cw-hop-hint", function (ok) {
      if (!ok) return;
      el("cw-hop-in").value = "";
      releaseKeyboard();
      hopOpen = false;
      var on = state && (state.status === "online" || state.status === "connecting");
      // reconnect with the new code
      if (on) act("disconnect", {}, null, null, function () { act("connect", {}, null); });
      else act("connect", {}, null);
      renderHoppie(); placeCard();
    });
  }

  function renderCpdlc() {
    renderHoppie();
    var dot = el("cw-dot");
    dot.className = "cw-dot " + (!reachable ? "error" : state ? (state.status === "online" && state.error ? "connecting" : state.status) : "");
    el("cw-callsign").textContent = !reachable ? "Clearway not running" : state && state.callsign ? state.callsign : "CPDLC";
    var unit = el("cw-unit");
    if (state && reachable && (state.current_unit || state.pending_logon)) {
      unit.className = "cw-pill" + (state.current_unit ? "" : " pending");
      unit.textContent = state.current_unit || (state.pending_logon + "...");
    } else {
      unit.className = "cw-pill hidden";
    }
    var notice = el("cw-notice");
    if (!reachable) {
      notice.innerHTML = "Start <b>Clearway</b> on this PC to use CPDLC.";
      notice.classList.remove("hidden");
    } else if (state && state.status !== "online") {
      // (1.5.0) one short line; a longer error is cut with "...", its full text on hover
      notice.innerHTML = state.error ? esc(state.error) : "Hoppie not connected &middot; Clearway Settings &rsaquo; <b>Connect</b>";
      notice.title = state.error ? plain(state.error) : "Not connected to Hoppie. Open Clearway's Settings and press Connect.";
      notice.classList.remove("hidden");
    } else {
      notice.classList.add("hidden");
    }
    updateSendLabel();
    renderList();
  }

  function renderList() {
    var list = el("cw-list");
    if (!state || !reachable) { list.innerHTML = ""; return; }
    var msgs = state.messages.filter(function (m) { return !VP[m.kind]; }).slice(-30).reverse();
    if (!msgs.length) { list.innerHTML = "<div class=\"cw-empty\">No CPDLC messages yet.</div>" + trashHtml(); return; }
    var html = "";
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.dir === "sys") { html += "<div class=\"cw-sys" + sysOld(m) + "\" data-ts=\"" + (m.ts || 0) + "\">" + esc(m.text) + " <span class=\"cw-del\" data-del=\"" + m.id + "\">" + X_ICON + "</span></div>"; continue; }
      var unread = m.dir === "in" && !m.acked;
      var label = m.tag || { cpdlc: "CPDLC", telex: "TELEX" }[m.kind] || "INFO";
      var actions = "";
      // required answers (options), or an optional ROGER for ATC text that needs no answer (quick)
      var answers = m.options.length ? m.options : (m.quick || []);
      for (var j = 0; j < answers.length; j++) {
        actions += "<div class=\"cw-btn " + answers[j] + "\" data-reply=\"" + answers[j] + "\" data-id=\"" + m.id + "\">" + answers[j] + "</div>";
      }
      var st = "";
      if (m.dir === "in" && m.reply) st = "Answered " + esc(m.reply);
      if (m.dir === "in" && m.status === "standby") st = "STANDBY sent";
      if (m.dir === "out" && m.status === "awaiting") st = "Awaiting reply...";
      if (m.dir === "out" && m.status === "answered") st = "ATC: " + esc(String(m.reply).replace(/@/g, ""));
      if (m.dir === "out" && m.status === "failed") st = "Not delivered" + (m.error ? ": " + esc(m.error) : "");
      html += "<div class=\"cw-msg " + m.dir + (unread ? " unread" : "") + (m.collapsed ? " collapsed" : "") + "\" data-msg=\"" + m.id + "\">" +
        "<div class=\"cw-bar-l\"></div>" +
        "<div class=\"cw-meta\"><span class=\"cw-chip " + m.kind + " tag-" + label + "\">" + label + "</span>" +
        "<span class=\"cw-station\">" + (m.dir === "out" ? "to " : "") + esc(m.station) + "</span>" +
        "<span class=\"cw-time\">" + utc(m.ts) + "</span>" +
        (unread && !m.options.length ? "<span class=\"cw-tick\" data-ack=\"" + m.id + "\" title=\"Mark as read\">" + TICK_ICON + "</span>" : "") +
        "<span class=\"cw-fold\" data-fold=\"" + m.id + "\" title=\"" + (m.collapsed ? "Expand" : "Collapse") + "\"></span>" +
        "<span class=\"cw-del\" data-del=\"" + m.id + "\" title=\"Delete\">" + X_ICON + "</span></div>" +
        "<div class=\"cw-text\">" + fmt(m.text) + "</div>" +
        (st ? "<div class=\"cw-state\">" + st + "</div>" : "") +
        (actions ? "<div class=\"cw-actions\">" + actions + "</div>" : "") + "</div>";
    }
    list.innerHTML = html + trashHtml();
  }

  // CPDLC messages deleted this session (kept by the companion until it quits)
  var trashOpen = false;
  function trashHtml() {
    var t = ((state && state.trash) || []).filter(function (m) { return !VP[m.kind]; });
    if (!t.length) { trashOpen = false; return ""; }
    var html = "<div class=\"cw-trash-bar\"><span>" + t.length + " deleted</span><span class=\"cw-link\" data-trash-toggle=\"1\">" + (trashOpen ? "Hide" : "Show") + "</span></div>";
    if (trashOpen) {
      for (var i = 0; i < t.length && i < 15; i++) {
        html += "<div class=\"cw-trash-row\"><span class=\"cw-trash-text\">" + esc((t[i].dir === "out" ? "to " : "") + t[i].station + " - " + String(t[i].text).replace(/@/g, "")) +
          "</span><span class=\"cw-link\" data-restore=\"" + t[i].id + "\">Restore</span></div>";
      }
      html += "<div class=\"cw-trash-all\"><span class=\"cw-link\" data-restore-all=\"1\">Restore all</span></div>";
    }
    return html;
  }

  // ------------------------------------------------------------ CPDLC request forms
  var FORMS = {
    // lb: the label shown inside the box on the left (1.5.0); ph: the hint while it's empty
    logon: [{ k: "station", lb: "STATION", ph: "ATC unit, e.g. EGGX" }],
    level: [{ k: "fl", lb: "LEVEL", ph: "Flight level, e.g. 370" }],
    direct: [{ k: "fix", lb: "DIRECT TO", ph: "Waypoint" }],
    text: [{ k: "text", ph: "Free text to current ATC" }],
    pdc: [
      { k: "station", lb: "STATION", ph: "e.g. EGLL", half: true }, { k: "type", lb: "AIRCRAFT", ph: "B77W", half: true },
      { k: "dep", lb: "FROM", ph: "", half: true }, { k: "arr", lb: "TO", ph: "", half: true },
      { k: "stand", lb: "STAND", ph: "", half: true }, { k: "atis", lb: "ATIS", ph: "", half: true }
    ],
    // (1.5.0 user) three columns, with destination, max level, route and TMI
    oceanic: [
      { k: "station", lb: "STATION", ph: "EGGX", w: "third" }, { k: "entry", lb: "ENTRY", ph: "point", w: "third" },
      { k: "eta", lb: "ETA", ph: "1430", w: "third" },
      { k: "mach", lb: "MACH", ph: "84", w: "third" }, { k: "fl", lb: "ENTRY FL", ph: "370", w: "third" },
      { k: "maxfl", lb: "MAX FL", ph: "390", w: "third" },
      { k: "route", lb: "ROUTE", ph: "NAT track or random route", w: "two" }, { k: "tmi", lb: "TMI", ph: "330", w: "third" },
      { k: "dest", lb: "DEST", ph: "ICAO", w: "third" }, { k: "rmk", lb: "REMARKS", ph: "optional", w: "two" }
    ],
    telex: [{ k: "station", lb: "TO", ph: "Station or callsign" }, { k: "text", ph: "Message" }],
    wx: [{ k: "icao", lb: "AIRPORT", ph: "ICAO, e.g. EGLL" }]
  };
  var formVals = {};

  function prefill(kind) {
    var f = (state && state.flight) || {};
    var v = formVals[kind] || (formVals[kind] = {});
    if (kind === "pdc") {
      if (!v.station && f.departure) v.station = f.departure;
      var vpType = state && state.vpilot && state.vpilot.last ? state.vpilot.last.type : "";
      if (!v.type && (vpType || f.aircraft)) v.type = vpType || f.aircraft;
      if (!v.dep && f.departure) v.dep = f.departure;
      if (!v.arr && f.arrival) v.arr = f.arrival;
    }
    if (kind === "oceanic" && !v.fl && f.cruise) v.fl = String(f.cruise).replace(/^FL/i, "").slice(0, 3);
    if (kind === "oceanic" && !v.dest && f.arrival) v.dest = f.arrival;      // destination from your flight plan
    return v;
  }

  function renderFields() {
    var vals = prefill(reqKind), fields = FORMS[reqKind], html = "";
    for (var i = 0; i < fields.length; i++) {
      var fd = fields[i];
      if (fd.k === "text") {
        html += "<textarea id=\"cw-f-text\" data-k=\"text\" rows=\"1\" class=\"cw-input cw-field cw-grow\" placeholder=\"" + fd.ph + "\">" + esc(vals.text || "") + "</textarea>";
        continue;
      }
      html += "<div class=\"rq-f" + (fd.half ? " half" : fd.w ? " " + fd.w : "") + "\">" + (fd.lb ? "<label>" + fd.lb + "</label>" : "") +
        "<input id=\"cw-f-" + fd.k + "\" data-k=\"" + fd.k + "\" class=\"cw-input cw-field" + (fd.lb ? " lb" : "") +
        "\" type=\"text\" placeholder=\"" + fd.ph + "\" value=\"" + esc(vals[fd.k] || "") + "\"/></div>";
    }
    var box = el("cw-fields");
    if (keyboardOwner && keyboardOwner.indexOf("cw-f-") === 0) releaseKeyboard();
    box.innerHTML = html;
    var inputs = box.querySelectorAll("input, textarea");
    for (var j = 0; j < inputs.length; j++) wireInput(inputs[j], send);
    // (1.5.0) each box leaves just enough room for its own label (narrow 3-column boxes keep space for the value)
    var labs = box.querySelectorAll(".rq-f > label");
    for (var li = 0; li < labs.length; li++) {
      var inp = labs[li].nextElementSibling;
      if (inp && labs[li].offsetWidth) inp.style.paddingLeft = (labs[li].offsetLeft + labs[li].offsetWidth + 7) + "px";
    }
    // every request type the same row height: remember a field's height, and give the free-text box and the WX row
    // exactly that (they changed the card's height by a few pixels, 1.5.0 test)
    var anyF = box.querySelector(".rq-f");
    if (anyF && anyF.offsetHeight) fieldH = anyF.offsetHeight;
    var grow = el("cw-f-text"); if (grow) { grow.style.minHeight = fieldH ? fieldH + "px" : ""; autoGrow(grow); }
    var sub = el("cw-wx-kind"), subBtns = sub.children;
    for (var si = 0; si < subBtns.length; si++) subBtns[si].style.height = fieldH ? fieldH + "px" : "";
    placeCard();
  }
  var fieldH = 0;   // a request field's height in px (the first form shown sets it)

  // (1.5.0) the request view in place of the message list (and the card resizes to fit it)
  function setReqOpen(on) {
    reqOpen = on;
    if (!on) reqHoldH = 0;                                // closed: the card goes back to its usual height
    el("cw-req").classList.toggle("hidden", !on);
    el("cw-pane-cpdlc").classList.toggle("rq-on", on);
    el("rq-open").classList.toggle("on", on);
    save("CLEARWAY_REQ_OPEN", on);
    if (!on && keyboardOwner && keyboardOwner.indexOf("cw-f-") === 0) releaseKeyboard();
    if (on && reqKind) renderFields();                     // measured now that it shows (labels, row height)
    placeCard();
  }
  function setReqKind(v) {
    reqKind = v;
    var btns = el("cw-req-kind").children;
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("on", attr(btns[i], "data-v") === v);
    el("cw-wx-kind").classList.toggle("hidden", v !== "wx");
    renderFields();
    updateSendLabel();
    hint("", false, "cw-hint");
  }

  function updateSendLabel() {
    var logged = state && reachable && (state.current_unit || state.pending_logon);
    el("cw-send").textContent = { logon: logged ? "Log off" : "Log on", wx: "Get", pdc: "Request", oceanic: "Request" }[reqKind] || "Send";
  }

  function field(k) {
    var input = el("cw-f-" + k);
    return input ? input.value.replace(/\s+/g, " ").trim().toUpperCase() : "";
  }

  // textareas grow with their text, up to ~4 lines, then scroll
  function autoGrow(ta) {
    ta.style.height = "auto";
    var lineH = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    var max = lineH * 4 + 16, min = parseFloat(ta.style.minHeight) || 0;
    ta.style.height = Math.max(min, Math.min(ta.scrollHeight, max)) + "px";
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }

  function send() {
    var cs = state ? state.callsign : "";
    var logged = state && (state.current_unit || state.pending_logon);
    var clear = [], H = "cw-hint";
    if (reqKind === "logon") {
      var st = field("station");
      if (logged && !st) return act("logoff", {}, "Logged off", H);
      if (!st) return hint("Enter a station", true, H);
      act("logon", { station: st }, "Logon request sent to " + st, H);
    } else if (reqKind === "level") {
      var fl = field("fl").replace(/\D/g, "");
      if (!fl) return hint("Enter a flight level", true, H);
      act("cpdlc", { text: "REQUEST FL" + fl }, "Request sent", H);
    } else if (reqKind === "direct") {
      if (!field("fix")) return hint("Enter a waypoint", true, H);
      act("cpdlc", { text: "REQUEST DIRECT TO " + field("fix") }, "Request sent", H);
    } else if (reqKind === "text") {
      if (!field("text")) return hint("Type a message", true, H);
      act("cpdlc", { text: field("text"), ra: "Y" }, "Sent", H);
      clear = ["text"];
    } else if (reqKind === "pdc") {
      if (!field("station") || !field("type") || !field("dep") || !field("arr") || !field("stand") || !field("atis")) return hint("Fill in all clearance fields", true, H);
      act("telex", { station: field("station"), text: "REQUEST PREDEP CLEARANCE " + cs + " " + field("type") + " TO " + field("arr") +
        " AT " + field("dep") + " STAND " + field("stand") + " ATIS " + field("atis") }, "Clearance requested", H);
    } else if (reqKind === "oceanic") {
      if (!field("station") || !field("entry") || !field("eta") || !field("mach") || !field("fl")) return hint("Fill in station, entry, ETA, Mach and entry FL", true, H);
      // the optional parts only when filled in (max level, destination, route, TMI)
      var maxfl = field("maxfl").replace(/\D/g, ""), tmi = field("tmi").replace(/\D/g, "");
      act("telex", { station: field("station"), text: "OCEANIC CLEARANCE REQUEST CALLSIGN: " + cs + " ENTRY POINT: " + field("entry") +
        " AT: " + field("eta") + " REQ: M." + field("mach").replace(/\D/g, "") + " FL" + field("fl").replace(/\D/g, "") +
        (maxfl ? " MAX FL" + maxfl : "") + (field("dest") ? " DEST: " + field("dest") : "") +
        (field("route") ? " ROUTE: " + field("route") : "") + (tmi ? " TMI: " + tmi : "") +
        " RMKS: " + (field("rmk") || "NIL") }, "Oceanic clearance requested", H);
    } else if (reqKind === "telex") {
      if (!field("station") || !field("text")) return hint("Enter a station and a message", true, H);
      act("telex", { station: field("station"), text: field("text") }, "Telex sent", H);
      clear = ["text"];
    } else if (reqKind === "wx") {
      if (field("icao").length !== 4) return hint("Enter a 4-letter ICAO", true, H);
      act("inforeq", { what: wxKind, icao: field("icao") }, "Requested", H);
    }
    for (var i = 0; i < clear.length; i++) {
      var input = el("cw-f-" + clear[i]);
      if (input) input.value = "";
      if (formVals[reqKind]) formVals[reqKind][clear[i]] = "";
    }
  }

  // ------------------------------------------------------------ notepad
  var notesTimer = null, notesDirty = false;
  function renderNotes() {
    var ta = el("cw-notes-text");
    if (state && !notesDirty && document.activeElement !== ta && ta.value !== (state.notes || "")) ta.value = state.notes || "";
    var cs = myCallsign(), h = el("cw-notes-cs");
    if (h.textContent !== cs) h.textContent = cs;
    // in its own window the row only holds the callsign (the detach button is hidden there): no empty row without one
    el("cw-notes-head").classList.toggle("hidden", notesDetached && !cs);
    renderOfpBlock();
  }

  // (1.5.0) your SimBrief flight under the notes: "DEP - ARR - ALT - FL370", then the route with its SID first and STAR
  // last (added when the route text leaves them out). Departure side in teal, arrival side in amber
  var ofpKey = "";
  function renderOfpBlock() {
    var sb = state && reachable && state.selcal && state.selcal.simbrief, box = el("cn-ofp");
    if (!box) return;
    // "Saved" sits left of the reload button when the flight block shows (saves a line), else under the notes
    var stl = el("cw-notes-state"), shown = !!(sb && sb.departure && sb.arrival);
    if (shown && stl.parentNode !== el("cn-ofp-l1").parentNode) el("cn-ofp-l1").parentNode.insertBefore(stl, el("cn-ofp-rl"));
    else if (!shown && stl.parentNode !== el("cw-notes-body")) el("cw-notes-body").appendChild(stl);
    stl.classList.toggle("in-ofp", shown);
    el("cw-nw-body").classList.toggle("ofp-shown", shown);   // the window keeps no room under the box for it then
    if (!shown) { box.classList.add("hidden"); ofpKey = ""; return; }
    var key = [sb.departure, sb.arrival, sb.alternate, sb.cruise, sb.route, sb.sid, sb.star].join("|");
    box.classList.remove("hidden");
    if (key === ofpKey) return;
    ofpKey = key;
    var l1 = ["<span class=\"dep\">" + esc(sb.departure) + "</span>", "<span class=\"arr\">" + esc(sb.arrival) + "</span>"];
    if (sb.alternate) l1.push(esc(sb.alternate));
    if (sb.cruise) l1.push(sb.cruise >= 18000 ? "FL" + Math.round(sb.cruise / 100) : sb.cruise + " ft");
    el("cn-ofp-l1").innerHTML = l1.join("&nbsp; - &nbsp;");
    var w = String(sb.route || "").split(/\s+/).filter(Boolean);
    if (sb.sid && w[0] !== sb.sid) w.unshift(sb.sid);
    if (sb.star && w[w.length - 1] !== sb.star) w.push(sb.star);
    w = w.map(esc);
    if (w.length) { w[0] = "<span class=\"dep\">" + w[0] + "</span>"; if (w.length > 1) w[w.length - 1] = "<span class=\"arr\">" + w[w.length - 1] + "</span>"; }
    el("cn-ofp-l2").innerHTML = w.join(" ");
    el("cn-ofp-l2").classList.toggle("hidden", !w.length);
  }
  // my callsign: the one vPilot is connected with, else the CPDLC one
  function myCallsign() {
    if (!state) return "";
    return String((state.vpilot && state.vpilot.connected && state.vpilot.callsign) || state.callsign ||
      (state.vpilot && state.vpilot.callsign) || "").toUpperCase();
  }

  // ------------------------------------------------------------ render: SELCAL
  // Generate standard / extended codes that no one on VATSIM uses or has prefiled, read the code of
  // the latest SimBrief flight plan, and keep codes for 24 hours (shared with the phone).
  var airlines = {};             // ICAO -> [IATA, name], loaded once from Clearway
  var scSavedOpen = false, scUserOpen = false;
  function airlineFor(cs) {
    var m = /^([A-Z]{3})(\d[A-Z0-9]*)?$/.exec(cs || "");
    if (!m || !airlines[m[1]]) return null;
    return { iata: airlines[m[1]][0], name: airlines[m[1]][1] };
  }
  function scCallsign() { return el("cw-sc-callsign").value.toUpperCase().replace(/[^A-Z0-9]/g, ""); }
  function fillTile(tile, cs) {
    if (attr(tile, "data-cs") === cs) return;
    tile.setAttribute("data-cs", cs);
    var airline = airlineFor(cs);
    tile.textContent = cs.slice(0, 3) || "-";
    tile.classList.remove("logo");
    if (!airline) return;
    var img = new Image();
    img.onload = function () {
      if (attr(tile, "data-cs") !== cs) return;
      tile.textContent = "";
      tile.classList.add("logo");
      tile.appendChild(img);
    };
    img.src = "https://pics.avs.io/120/60/" + airline.iata + ".png";
  }
  function usedText(list, id) {
    var u = el(id);
    if (!u) return;
    if (list === null || list === undefined) { u.className = "cw-sc-used"; u.textContent = "Not checked on VATSIM"; return; }
    if (!list.length) { u.className = "cw-sc-used free"; u.textContent = "Free on VATSIM"; return; }
    u.className = "cw-sc-used taken";
    u.textContent = "Used by " + list[0].callsign + (list[0].where === "prefiled" ? " (prefiled)" : "") +
      (list.length > 1 ? " +" + (list.length - 1) : "");
  }
  function isExtended(code) { return /[T-Z1-9]/.test(String(code || "").replace("-", "")); }
  function left(s) {
    var m = Math.floor(s / 60), h = Math.floor(m / 60);
    return m < 1 ? "under a minute left" : h ? h + "h " + (m % 60) + "m left" : m + "m left";
  }

  function renderSelcal() {
    var sc = (state && reachable && state.selcal) || null;
    var feed = el("cw-sc-feed");
    if (!sc) { feed.textContent = reachable ? "" : "Clearway not running"; feed.className = "cw-sc-feed err"; return; }
    var v = sc.vatsim || {};
    feed.textContent = v.error || "";            // only a problem is worth showing (the count of plans checked was noise)
    feed.title = v.checked ? v.count + " VATSIM flight plans checked" : "";   // still there on hover
    feed.className = "cw-sc-feed" + (v.checked ? " ok" : v.error ? " err" : "");
    // SimBrief: the saved username sits in the bar; click it to change it
    var name = el("cw-sc-sbname");
    name.textContent = sc.simbrief_user ? "******" : "";          // kept private on screen
    name.classList.toggle("hidden", !sc.simbrief_user);
    name.classList.toggle("on", scUserOpen);
    el("cw-sc-sbuser").classList.toggle("hidden", !scUserOpen);
    prefillInput("cw-sc-sbuser-in", sc.simbrief_user);
    var ofp = sc.simbrief, box = el("cw-sc-ofp");
    // no SELCAL in the SimBrief plan: the one in your VATSIM flight plan (by your CID), else the one vPilot connected
    // to VATSIM with, if any
    var vpNow = state.vpilot || {}, vpSel = vpNow.connected && !vpNow.observer && vpNow.last ? fmtSelcal(vpNow.last.selcal || "") : "";
    var vfp = sc.vatsim_fp, vfpSel = vfp && vfp.selcal ? fmtSelcal(vfp.selcal) : "";
    if (!ofp && vfp) {
      // no SimBrief plan: your VATSIM flight plan instead
      var vroute = [vfp.departure && vfp.arrival ? vfp.departure + "-" + vfp.arrival : "", vfp.type].join(" ").trim();
      box.innerHTML = "<div class=\"cw-sc-ofp-top\"><span class=\"cw-sc-ofp-tag\">VATSIM</span>" +
        "<span class=\"cw-sc-ofp-cs\">" + esc(vfp.callsign || "-") + "</span><span class=\"cw-sc-ofp-route\">" + esc(vroute) + "</span></div>" +
        (vfpSel
          ? "<div class=\"cw-sc-ofp-code\"><b>" + esc(vfpSel) + "</b><span class=\"cw-sc-used\">In your VATSIM flight plan</span></div>"
          : "<div class=\"cw-sc-ofp-code\"><span class=\"cw-sc-used\">No SELCAL in your VATSIM flight plan.</span></div>");
      box.classList.remove("hidden");
    } else if (ofp) {
      var route = [ofp.departure && ofp.arrival ? ofp.departure + "-" + ofp.arrival : "", ofp.aircraft].join(" ").trim();
      box.innerHTML = "<div class=\"cw-sc-ofp-top\"><span class=\"cw-sc-ofp-tag\">SIMBRIEF</span>" +
        "<span class=\"cw-sc-ofp-cs\">" + esc(ofp.callsign || "-") + "</span><span class=\"cw-sc-ofp-route\">" + esc(route) + "</span></div>" +
        (ofp.selcal
          ? "<div class=\"cw-sc-ofp-code\"><b>" + esc(ofp.selcal) + "</b><span class=\"cw-sc-used\" id=\"cw-sc-ofp-used\"></span>" +
            (isExtended(ofp.selcal) ? "" : "<span class=\"cw-mini\" data-sc-ofp=\"use\">Use in vPilot</span>") +
            "<span class=\"cw-mini\" data-sc-ofp=\"save\">Save</span></div>"
          : vfpSel
          ? "<div class=\"cw-sc-ofp-code\"><b>" + esc(vfpSel) + "</b><span class=\"cw-sc-used\">Not in SimBrief: the SELCAL in your VATSIM flight plan</span></div>"
          : vpSel.replace("-", "").length === 4
          ? "<div class=\"cw-sc-ofp-code\"><b>" + esc(vpSel) + "</b><span class=\"cw-sc-used\">Not in the flight plan: the SELCAL you connected to VATSIM with</span></div>"
          : "<div class=\"cw-sc-ofp-code\"><span class=\"cw-sc-used\">No SELCAL in this flight plan. Generate one below and add it in SimBrief.</span></div>");
      box.classList.remove("hidden");
      if (ofp.selcal) usedText(ofp.used_by, "cw-sc-ofp-used");
    } else box.classList.add("hidden");
    // generator
    var cur = sc.current, vp = state.vpilot || {};
    prefillInput("cw-sc-callsign", (cur && cur.callsign) || (vp.connected && vp.callsign) || (ofp && ofp.callsign) || state.callsign);
    fillTile(el("cw-sc-tile"), scCallsign());
    var al = airlineFor(scCallsign());
    el("cw-sc-airline").textContent = al ? al.name : "";
    el("cw-sc-std").textContent = cur ? cur.std : "-- --";
    el("cw-sc-ext").textContent = cur ? cur.ext : "-- --";
    usedText(cur ? cur.std_used : null, "cw-sc-std-used");
    usedText(cur ? cur.ext_used : null, "cw-sc-ext-used");
    if (!cur) { el("cw-sc-std-used").textContent = ""; el("cw-sc-ext-used").textContent = ""; }
    // code typed by hand
    var chk = sc.checked, res = el("cw-sc-check-res");
    if (chk) {
      res.innerHTML = "<b>" + esc(chk.code) + "</b><span class=\"cw-sc-used\" id=\"cw-sc-chk-used\"></span>" +
        (isExtended(chk.code) ? "" : "<span class=\"cw-mini\" data-sc-chk=\"use\">Use in vPilot</span>") +
        "<span class=\"cw-mini\" data-sc-chk=\"save\">Save</span>";
      res.classList.remove("hidden");
      usedText(chk.used_by, "cw-sc-chk-used");
    } else res.classList.add("hidden");
    el("cw-sc-save").classList.toggle("disabled", !cur);
    el("cw-sc-use").classList.toggle("disabled", !cur);
    // saved codes
    var saved = sc.saved || [];
    el("cw-sc-saved-title").textContent = "Saved" + (saved.length ? " (" + saved.length + ")" : "") + " - kept 24 hours";
    el("cw-sc-saved").classList.toggle("hidden", !scSavedOpen);
    el("cw-sc-saved-chev").classList.toggle("closed", !scSavedOpen);
    if (scSavedOpen) {
      el("cw-sc-saved").innerHTML = saved.length ? saved.map(function (e) {
        var codes = (e.std ? "<div><i>STD</i>" + esc(e.std) + "</div>" : "") + (e.ext ? "<div><i>EXT</i>" + esc(e.ext) + "</div>" : "");
        return "<div class=\"cw-sc-row\"><div class=\"cw-sc-tile\" data-tile=\"" + esc(e.callsign) + "\"></div>" +
          "<div class=\"cw-sc-who\"><b>" + esc(e.callsign) + "</b><span>" + esc([e.airline && e.airline.name, left(e.left)].filter(Boolean).join(" - ")) + "</span></div>" +
          "<div class=\"cw-sc-rcodes\">" + codes + "</div>" +
          "<span class=\"cw-del\" data-sc-del=\"" + esc(e.callsign) + "|" + e.generated + "\" title=\"Remove\">" + X_ICON + "</span></div>";
      }).join("") : "<div class=\"cw-empty\">Nothing saved in the last 24 hours.</div>";
      var tiles = el("cw-sc-saved").querySelectorAll("[data-tile]");
      for (var i = 0; i < tiles.length; i++) fillTile(tiles[i], attr(tiles[i], "data-tile"));
    }
  }

  function scGenerate() {
    act("selcal/generate", { callsign: scCallsign() }, "", "cw-sc-hint");
  }
  // SELCAL always written AB-CD: the dash appears by itself after the second tone
  function fmtSelcal(v) {
    var s = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    return s.length > 2 ? s.slice(0, 2) + "-" + s.slice(2) : s;
  }

  // vPilot connect form: small availability line under the SELCAL field
  var vpScTimer = null, vpScSeq = 0;
  function vpSelcalCheck(delay) {
    clearTimeout(vpScTimer);
    var st = el("cw-vp-sc-st");
    var code = el("cw-vp-selcal-in").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4 || el("cw-vp-connect").classList.contains("hidden")) { st.classList.add("hidden"); vpScSeq++; return; }
    st.className = "cw-vp-sc-st";
    st.innerHTML = "<span class=\"cw-spin\"></span>check. avail...";
    var seq = ++vpScSeq;
    vpScTimer = setTimeout(function () {
      request("POST", "/api/selcal/check", { code: code, remember: false, exclude: el("cw-vp-cs-in").value }, function (ok, data) {
        if (seq !== vpScSeq) return;            // the field changed meanwhile
        if (!ok) { st.className = "cw-vp-sc-st bad"; st.textContent = reachable ? "invalid code" : ""; return; }
        var used = data.used_by;
        if (used === null || used === undefined) { st.className = "cw-vp-sc-st"; st.textContent = "not checked"; }
        else if (!used.length) { st.className = "cw-vp-sc-st free"; st.textContent = "avail."; }
        else {
          st.className = "cw-vp-sc-st taken";
          st.textContent = "taken by " + used[0].callsign + (used.length > 1 ? " +" + (used.length - 1) : "");
        }
      });
    }, delay === undefined ? 500 : delay);
  }

  // vPilot connect form: "SB: CALLSIGN" from the latest SimBrief flight plan, to compare with what's typed
  var sbBusy = false;
  function renderVpSimbrief() {
    var sc = state && reachable && state.selcal, sb = el("cw-vp-sb");
    var ofp = sc && sc.simbrief, typed = el("cw-vp-cs-in").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (sbBusy) { sb.className = "cw-vp-sb"; sb.textContent = "SB: fetching..."; return; }
    if (!sc) { sb.className = "cw-vp-sb"; sb.textContent = ""; return; }
    if (!sc.simbrief_user) { sb.className = "cw-vp-sb"; sb.textContent = "SB: set up in the SELCAL tab"; return; }
    if (!ofp || !ofp.callsign) { sb.className = "cw-vp-sb"; sb.textContent = sc.simbrief_error ? "SB: " + sc.simbrief_error : "SB: -"; return; }
    sb.innerHTML = "SB: <b>" + esc(ofp.callsign) + "</b>";
    // green when the typed callsign matches the flight plan, amber when it doesn't
    sb.className = "cw-vp-sb" + (!typed ? "" : typed === ofp.callsign ? " match" : " differ");
  }
  function vpSimbriefRefresh() {
    var sc = state && state.selcal;
    if (!sc || !sc.simbrief_user) { showTab("selcal"); scUserOpen = true; renderSelcal(); placeCard(); return; }
    if (sbBusy) return;
    sbBusy = true;
    el("cw-vp-sb-ref").classList.add("spinning"); el("cn-ofp-rl").classList.add("spinning");
    renderVpSimbrief();
    act("selcal/simbrief", {}, null, null, function () {
      sbBusy = false;
      el("cw-vp-sb-ref").classList.remove("spinning"); el("cn-ofp-rl").classList.remove("spinning");
      renderVpSimbrief(); ofpKey = ""; renderOfpBlock();
    });
  }

  function scUseInVpilot(code) {
    act("selcal/use", { code: code }, "", "cw-sc-hint", function (ok, data) {
      if (!ok) return;
      el("cw-vp-selcal-in").value = fmtSelcal(data.code || code);
      vpSelcalCheck(0);
      hint(data.code + " is set in the vPilot connect form", false, "cw-sc-hint");
    });
  }
  function scFetchSimbrief(user) {
    hint("Fetching your latest SimBrief flight plan...", false, "cw-sc-hint");
    var body = user === undefined ? {} : { user: user };
    act("selcal/simbrief", body, "", "cw-sc-hint", function (ok) {
      if (ok) { scUserOpen = false; releaseKeyboard(); hint("SimBrief flight plan loaded", false, "cw-sc-hint"); }
      else scUserOpen = true;
      renderSelcal();
      placeCard();
    });
  }

  function wireSelcal() {
    request("GET", "/api/selcal/airlines", null, function (ok, data) {
      if (ok && data.airlines) { airlines = data.airlines; el("cw-sc-tile").removeAttribute("data-cs"); if (state) renderSelcal(); }
    });
    scSavedOpen = load("CLEARWAY_SC_SAVED", false);
    var cs = el("cw-sc-callsign");
    wireInput(cs, scGenerate);
    cs.addEventListener("input", function () {
      fillTile(el("cw-sc-tile"), scCallsign());
      var al = airlineFor(scCallsign());
      el("cw-sc-airline").textContent = al ? al.name : "";
    });
    wireInput(el("cw-sc-sbuser-in"), function () { scFetchSimbrief(el("cw-sc-sbuser-in").value.trim()); });
    el("cw-sc-sbuser-go").addEventListener("click", function () { scFetchSimbrief(el("cw-sc-sbuser-in").value.trim()); });
    // the generator section folds like CPDLC's Request; closed when the panel starts
    var setScGen = function (open) {
      el("cw-sc-genbox").classList.toggle("hidden", !open);
      el("cw-sc-gen-chev").classList.toggle("closed", !open);
    };
    el("cw-sc-gen-toggle").addEventListener("click", function () {
      setScGen(el("cw-sc-genbox").classList.contains("hidden"));
      placeCard();
    });
    el("cw-sc-sb").addEventListener("click", function () {
      setScGen(true);                       // SimBrief fills the generator: show it
      var sc = state && state.selcal;
      if (sc && sc.simbrief_user && !scUserOpen) scFetchSimbrief();
      else { scUserOpen = !scUserOpen || !(sc && sc.simbrief_user); renderSelcal(); placeCard(); if (scUserOpen) el("cw-sc-sbuser-in").focus(); }
    });
    el("cw-sc-sbname").addEventListener("click", function () {
      var sc = state && state.selcal;
      scUserOpen = !scUserOpen;
      if (scUserOpen) {
        el("cw-sc-sbuser-in").value = (sc && sc.simbrief_user) || "";   // start from the current one
        renderSelcal(); placeCard();
        el("cw-sc-sbuser-in").focus();
        el("cw-sc-sbuser-in").select();
      } else { releaseKeyboard(); renderSelcal(); placeCard(); }
    });
    el("cw-sc-gen").addEventListener("click", scGenerate);
    el("cw-sc-save").addEventListener("click", function () {
      var cur = state && state.selcal && state.selcal.current;
      if (!cur) return;
      act("selcal/save", { callsign: scCallsign() || cur.callsign, generated: cur.generated, std: cur.std, ext: cur.ext }, "Saved for 24 hours", "cw-sc-hint");
    });
    el("cw-sc-use").addEventListener("click", function () {
      var cur = state && state.selcal && state.selcal.current;
      if (cur) scUseInVpilot(cur.std);
    });
    el("cw-sc-ofp").addEventListener("click", function (e) {
      var what = pick(e.target, "data-sc-ofp"), ofp = state && state.selcal && state.selcal.simbrief;
      if (!what || !ofp || !ofp.selcal) return;
      if (what === "use") return scUseInVpilot(ofp.selcal);
      var body = { callsign: ofp.callsign, generated: ofp.fetched };
      body[isExtended(ofp.selcal) ? "ext" : "std"] = ofp.selcal;
      act("selcal/save", body, "Saved for 24 hours", "cw-sc-hint");
    });
    function scCheck() {
      var v = el("cw-sc-check-in").value.trim();
      if (!v) return;
      act("selcal/check", { code: v, exclude: scCallsign() }, "", "cw-sc-hint", function (ok, data) {
        if (ok) { el("cw-sc-check-in").value = data.code; releaseKeyboard(); }
        placeCard();
      });
    }
    wireInput(el("cw-sc-check-in"), scCheck);
    el("cw-sc-check-go").addEventListener("click", scCheck);
    el("cw-sc-check-res").addEventListener("click", function (e) {
      var what = pick(e.target, "data-sc-chk"), chk = state && state.selcal && state.selcal.checked;
      if (!what || !chk) return;
      if (what === "use") return scUseInVpilot(chk.code);
      var body = { callsign: scCallsign(), generated: chk.ts };
      body[isExtended(chk.code) ? "ext" : "std"] = chk.code;
      act("selcal/save", body, "Saved for 24 hours", "cw-sc-hint");
    });
    el("cw-sc-saved-toggle").addEventListener("click", function () {
      scSavedOpen = !scSavedOpen;
      save("CLEARWAY_SC_SAVED", scSavedOpen);
      renderSelcal();
      placeCard();
    });
    el("cw-sc-saved").addEventListener("click", function (e) {
      var d = pick(e.target, "data-sc-del");
      if (!d) return;
      var parts = d.split("|");
      act("selcal/remove", { callsign: parts[0], generated: +parts[1] }, null);
    });
  }

  // ------------------------------------------------------------ layout: icon + card
  var scale = 1;
  function applyScale() {
    scale = (window.innerHeight || 1080) / 1080;
    el("cw-root").style.fontSize = (12.5 * scale) + "px";
    var pos = load("CLEARWAY_POS", null) || { x: 0.03, y: 0.25 };
    placeBubble(pos.x * window.innerWidth, pos.y * window.innerHeight, false);
    if (radarDetached) placeRadarWindow(load("CLEARWAY_RADAR_WIN", null));
  }

  // (1.5.0) Settings > "Reset panel positions": the icon back to the right side, half-way down (the right edge of the
  // panel's area is always on screen), the radar and notepad windows back to their default places. Seen as a change of
  // state.panel_reset; the first value after the panel starts is only remembered (no reset on load)
  var resetSeen = null;
  function checkPanelReset() {
    var v = state && state.panel_reset;
    if (v === undefined) return;
    if (resetSeen === null) { resetSeen = v; return; }
    if (v === resetSeen) return;
    resetSeen = v;
    var size = el("cw-bubble").offsetWidth || 48;
    placeBubble(window.innerWidth - size - 24 * scale, window.innerHeight * 0.45, true);
    save("CLEARWAY_RADAR_WIN", null); if (radarDetached) placeRadarWindow(null);
    save("CLEARWAY_NOTES_WIN", null); if (notesDetached) placeNotesWindow(null);
    resetNotesGrow();
    placeCard();
  }
  function placeBubble(x, y, persist) {
    var b = el("cw-bubble"), size = b.offsetWidth || 48;
    x = Math.max(4, Math.min(window.innerWidth - size - 4, x));
    y = Math.max(4, Math.min(window.innerHeight - size - 4, y));
    b.style.left = x + "px";
    b.style.top = y + "px";
    if (persist) save("CLEARWAY_POS", { x: x / window.innerWidth, y: y / window.innerHeight });
    placeCard();
  }

  // The card opens towards the middle of the screen: right or left of the icon, and downwards
  // from a top-half icon or upwards from a bottom-half icon. The lock button freezes the direction.
  var placementLock = null;   // null, or { right: bool, down: bool }
  function cardDirection() {
    if (placementLock) return placementLock;
    var b = el("cw-bubble"), bs = b.offsetWidth || 48;
    return { right: b.offsetLeft + bs / 2 < window.innerWidth / 2, down: b.offsetTop + bs / 2 < window.innerHeight / 2 };
  }

  // One card height for every tab but the Radar: as tall as the taller of the vPilot and CPDLC tabs needs (so it
  // starts small, the empty vPilot tab, and grows with their messages) up to CARD_MAX (the vPilot tab with a
  // 6-controller ATC list), whichever tab is shown, so switching tabs doesn't make the card jump. The Radar tab keeps
  // its own fixed size (CSS). Sizes in em: they scale with the screen like the rest of the panel.
  // the card's height in em: at least the header, the vPilot bar, the chip row, one row of ATC cards and the message
  // box (so an empty chat never leaves the ATC list a sliver); at most 21.7 em, then lists scroll
  var CARD_MIN = 17, CARD_MAX = 21.7, REQ_MAX = 28, reqHoldH = 0;   // reqHoldH: the request view's height (em), kept while it's open
  function naturalHeight(p) {
    // how tall a tab would be with all its content: laid out on its own for a moment, invisibly
    var wasHidden = p.classList.contains("hidden"), keep = p.getAttribute("style") || "";
    // laid out at full height, the message lists have nothing to scroll and lose their position (the list
    // jumped back to the top): remember every scrolled box and put it back afterwards
    var all = p.getElementsByTagName("*"), scrolled = [];
    for (var k = 0; k < all.length; k++) if (all[k].scrollTop > 0) scrolled.push([all[k], all[k].scrollTop]);
    p.classList.remove("hidden");
    p.style.cssText = keep + ";position:absolute;visibility:hidden;left:0;right:0;top:0;height:auto;max-height:none;flex:none;";
    var h = p.offsetHeight;
    // grey status lines ("Connecting...", "Connected to VATSIM", "Connected to Hoppie"...) don't make the card taller:
    // only real messages do. They still show, and scroll with the rest
    var sys = p.getElementsByClassName("cw-sys");
    for (var i = 0; i < sys.length; i++) {
      var cs = window.getComputedStyle(sys[i]);
      h -= sys[i].offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    }
    p.setAttribute("style", keep);
    if (wasHidden) p.classList.add("hidden");
    for (var s = 0; s < scrolled.length; s++) scrolled[s][0].scrollTop = scrolled[s][1];
    return h;
  }
  function sizeCard() {
    var c = el("cw-card");
    if (!c || c.classList.contains("hidden")) return;
    if (c.classList.contains("radar")) { c.style.height = ""; return; }
    var em = parseFloat(window.getComputedStyle(c).fontSize) || 14;
    // the height follows the messages: with the ATC list open (it takes the chat's place), measure the chat anyway,
    // so opening the list doesn't change the card's height (a long list scrolls inside)
    var chat = el("cw-vp-chat"), atc = el("cw-vp-atc"), atcTop = atc.scrollTop;
    if (atcOpen) { chat.classList.remove("hidden"); atc.classList.add("hidden"); }
    var need = Math.max(naturalHeight(el("cw-pane-vpilot")), naturalHeight(el("cw-pane-cpdlc")));
    if (atcOpen) { chat.classList.add("hidden"); atc.classList.remove("hidden"); atc.scrollTop = atcTop; }
    // with the ATC list open, the card grows to show the whole list (and an open controller's information), up to the
    // maximum height; it never shrinks below the chat's height, so a list shorter than the chat doesn't move it
    if (atcOpen) need = Math.max(need, naturalHeight(el("cw-pane-vpilot")));
    var headPx = el("cw-head").offsetHeight + 2;            // + the card's border
    var h = (headPx + need) / em;
    h = Math.max(CARD_MIN, Math.min(CARD_MAX, h));
    // (1.5.0) the CPDLC request view: the card grows if a request needs more room (up to REQ_MAX), so Send is never cut
    // off. While the view stays open the card keeps that height, on every tab and for every request type (no small
    // jumps when switching; user, 1.5.0 test); closing the view lets it come back down
    if (reqOpen) {
      if (tab === "cpdlc" && !notesOpen) reqHoldH = Math.max(reqHoldH, Math.min(REQ_MAX, (headPx + naturalHeight(el("cw-pane-cpdlc"))) / em));
      h = Math.max(h, reqHoldH);
    }
    // (1.5.0) the notepad made bigger with its grip: the extra size on top of the normal one
    var grown = notesOpen && !notesDetached && (notesGrow.w || notesGrow.h);
    if (grown) {
      h += notesGrow.h;
      c.style.width = "";
      var wv = (c.offsetWidth / em + notesGrow.w).toFixed(2) + "em";
      c.style.width = wv;
    } else if (c.style.width) c.style.width = "";
    var v = h.toFixed(2) + "em";
    if (c.style.height !== v) c.style.height = v;
    if (grown) return;
    // the request view: Send must sit inside the card, checked on the real layout (the measured height can come out a
    // few pixels short); the card grows by what's missing, up to REQ_MAX, and keeps it while the view is open
    if (reqOpen && tab === "cpdlc" && !notesOpen) {
      var sb = el("cw-send").getBoundingClientRect(), cb = c.getBoundingClientRect();
      var missR = sb.bottom - cb.bottom + 0.6 * em;
      if (sb.height && missR > 0) {
        reqHoldH = Math.min(REQ_MAX, h + missR / em);
        h = Math.max(h, reqHoldH);
        c.style.height = h.toFixed(2) + "em";
      }
    }
    // the ATC list always shows at least one whole controller card: checked on the real layout (the sim can measure
    // the list's natural height short), and the card grows by what's missing, up to its maximum
    if (atcOpen) {
      var cell = atc.querySelector(".cw-atc-cell");
      if (cell) {
        var miss = cell.getBoundingClientRect().bottom - atc.getBoundingClientRect().bottom + 0.4 * em;
        if (miss > 0) {
          var h2 = Math.min(CARD_MAX, h + miss / em), v2 = h2.toFixed(2) + "em";
          if (c.style.height !== v2) c.style.height = v2;
        }
      }
      revealAtcInfo();
    }
  }

  function placeCard() {
    sizeCard();
    var b = el("cw-bubble"), c = el("cw-card");
    var bx = b.offsetLeft, by = b.offsetTop, bs = b.offsetWidth || 48;
    var cw = c.offsetWidth || 350, ch = c.offsetHeight || 300, gap = 10 * scale;
    var d = cardDirection();
    var x = d.right ? bx + bs + gap : bx - cw - gap;
    var y = d.down ? by : by + bs - ch;            // upwards: bottom of the card level with the icon
    x = Math.max(4, Math.min(window.innerWidth - cw - 4, x));
    y = Math.max(4, Math.min(window.innerHeight - ch - 4, y));
    c.style.left = x + "px";
    c.style.top = y + "px";
    placedKey = layoutKey();
    if (peekMsg) placePeek();
  }

  // The card's content (messages, chat, request form) often arrives or changes size after the card
  // was placed, and the panel window can change size after the toolbar panel reopens. A card that
  // opens upwards from a bottom icon then grew past the screen edge until the icon was moved.
  // So while the card (or the peek) is open, re-place it whenever any of these sizes change.
  var placedKey = "";
  function layoutKey() {
    var b = el("cw-bubble"), c = el("cw-card"), p = el("cw-peek");
    return [window.innerWidth, window.innerHeight, b.offsetLeft, b.offsetTop, b.offsetWidth,
      c.offsetWidth, c.offsetHeight, p.offsetWidth, p.offsetHeight].join(",");
  }
  function watchLayout() {
    if (!expanded && !peekMsg) return;
    if (layoutKey() === placedKey) return;
    if (window.innerHeight && Math.abs((window.innerHeight / 1080) - scale) > 0.001) applyScale();
    else placeCard();
  }

  // ------------------------------------------------------------ right click on the icon: peek
  // Shows the latest unread message (vPilot first, then CPDLC) and marks it read. With nothing
  // unread, the latest received message is marked unread again instead.
  var PEEK_MS = 8000;
  var peekTimer = null, peekMsg = null, lastPeekAt = 0;
  function peekable(m) { return m.dir === "in" && m.kind !== "vinfo"; }

  function peek() {
    var now = Date.now();
    if (now - lastPeekAt < 350) return;      // mousedown + contextmenu fire for the same click
    lastPeekAt = now;
    if (!state || !reachable) return;
    // what a right click shows, in order: an unread message (for you or CPDLC), new frequency text for others (the
    // grey dot), then during the start-up window (TSAT -5 to +6) its countdown, else the last message again
    var msgs = state.messages.filter(peekable), vp = null, cp = null, quiet = null, last = null;
    for (var i = msgs.length - 1; i >= 0; i--) {
      var m = msgs[i];
      if (!last) last = m;
      if (!m.acked && ackPending[m.id] === undefined) {
        if (VP[m.kind]) { if (!vp) vp = m; } else if (!cp) cp = m;
      } else if (m.quiet && !quiet && ackPending[m.id] === undefined) quiet = m;
    }
    var target = vp || cp || quiet;
    if (target) {
      ackPending[target.id] = 1;
      target.acked = true;
      target.quiet = false;
      act("ack", { id: target.id }, null, null, function () { delete ackPending[target.id]; });
      showPeek(target, false);
    } else if (tsatWindowOpen()) {
      showTsatPeek();
    } else if (last) {
      last.acked = false;
      act("unack", { id: last.id }, null);
      showPeek(last, true);
    }
  }

  // Right click on the icon during the start-up window (TSAT -5 to +6, full green icon or countdown ring), when no
  // message is waiting: "Start-up window" and a live countdown to its end, ticking every second while it's shown, in
  // the countdown's colour. A click on it opens the card
  function tsatWindowOpen() {
    var t = tsatNow(), now = Date.now();
    return !!t && now >= t.tsat_ms - 300000 && now < t.tsat_ms + 360000;
  }
  // the countdown's colour as the window runs out: mint green, then yellow, orange and red (left = 1 .. 0)
  var WINDOW_STOPS = [[0, [239, 68, 68]], [0.2, [249, 115, 22]], [0.5, [253, 224, 71]], [1, [134, 239, 172]]];
  function windowColor(left, alpha) {
    left = Math.max(0, Math.min(1, left));
    var a = WINDOW_STOPS[0], b = WINDOW_STOPS[WINDOW_STOPS.length - 1];
    for (var i = 1; i < WINDOW_STOPS.length; i++) if (left <= WINDOW_STOPS[i][0]) { a = WINDOW_STOPS[i - 1]; b = WINDOW_STOPS[i]; break; }
    var f = (left - a[0]) / ((b[0] - a[0]) || 1), c = [];
    for (var k = 0; k < 3; k++) c.push(Math.round(a[1][k] + (b[1][k] - a[1][k]) * f));
    return "rgba(" + c.join(", ") + ", " + (alpha == null ? 1 : alpha) + ")";
  }
  var tsatPeekTimer = null;
  function showTsatPeek() {
    var t = tsatNow(), p = el("cw-peek");
    if (!t) return;
    peekMsg = null;
    p.className = "tsat";
    function draw() {
      var ms = t.tsat_ms + 360000 - Date.now(), s = Math.max(0, Math.floor(ms / 1000));
      var col = windowColor(ms / 660000);
      p.style.borderLeftColor = col;
      p.innerHTML = "<div class=\"cw-peek-head\"><span class=\"cw-peek-kind\" style=\"color:" + col + "\">TSAT</span>" +
        "<span class=\"cw-station\">" + esc(t.airport || "") + "</span>" +
        "<span class=\"cw-time\">" + (t.suggested ? "TOBT " + esc(t.tobt) : "TSAT " + esc(t.tsat)) + "z</span></div>" +
        "<div class=\"cw-peek-text\">Start-up window</div>" +
        "<div class=\"cw-peek-big\" style=\"color:" + col + "\">" + pad2(Math.floor(s / 60)) + ":" + pad2(s % 60) + " left</div>";
    }
    draw();
    clearInterval(tsatPeekTimer);
    tsatPeekTimer = setInterval(function () {
      if (p.classList.contains("hidden") || !p.classList.contains("tsat")) { clearInterval(tsatPeekTimer); return; }
      draw();
    }, 1000);
    placePeek();
    armPeekClose(PEEK_MS);
  }

  // (1.5.0) urgent messages open their peek by themselves, ahead of everything, and stay until clicked:
  // 1 = a controller's "contact me" (vPilot colour), 2 = a SELCAL alert (amber). Not while notifications are muted
  var urgentShown = {};
  function checkUrgent() {
    if (!state || paused) return;
    var best = null;
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      if (!m.urgent || m.acked || urgentShown[m.id] || ackPending[m.id] !== undefined) continue;
      if (Date.now() - m.ts > 10 * 60000) continue;                  // old: just the usual unread counters
      if (!best || m.urgent < best.urgent || (m.urgent === best.urgent && m.ts > best.ts)) best = m;
    }
    if (!best) return;
    if (peekMsg && peekMsg.urgent && peekMsg.urgent <= best.urgent && !el("cw-peek").classList.contains("hidden")) return;
    if (peekReplyOpen) return;                                       // never yank a reply being typed
    urgentShown[best.id] = 1;
    showPeek(best, false, true);
  }

  function showPeek(m, markedUnread, urgent) {
    var isVp = !!VP[m.kind], p = el("cw-peek");
    var label = isVp ? ({ pm: "Private", radio: "Frequency", broadcast: "Broadcast", selcal: "SELCAL" }[m.kind] || "vPilot")
      : (m.tag || { cpdlc: "CPDLC", telex: "TELEX" }[m.kind] || "INFO");
    if (m.urgent === 1) label = "Contact me";
    closePeekReply(true);
    var text = plain(m.text || "");
    if (text.length > 320) text = text.slice(0, 317) + "...";
    var foot = markedUnread ? "<div class=\"cw-peek-foot unread\">Marked as unread</div>" : "";
    var peekAnswers = isVp ? [] : (m.options && m.options.length ? m.options : (m.quick || []));
    if (peekAnswers.length) {                                  // answer straight from the peek
      var btns = "";
      for (var j = 0; j < peekAnswers.length; j++) {
        btns += "<div class=\"cw-btn " + peekAnswers[j] + "\" data-peek-reply=\"" + peekAnswers[j] + "\">" + peekAnswers[j] + "</div>";
      }
      foot += "<div class=\"cw-actions\">" + btns + "</div><div class=\"cw-peek-foot\" id=\"cw-peek-state\"></div>";
    }
    if (urgent) foot += "<div class=\"cw-peek-foot\">Stays until you click it</div>";
    // quick reply (1.5.0): a pen on private messages and frequency text, at the end of the message's last line
    var canReply = m.kind === "pm" || m.kind === "radio";
    p.className = (isVp ? "vp" : "") + (m.kind === "selcal" ? " sc" : "");
    p.style.borderLeftColor = "";                          // the start-up window peek colours it while it counts down
    p.innerHTML = "<div class=\"cw-peek-head\"><span class=\"cw-peek-kind\">" + esc(label) + "</span>" +
      "<span class=\"cw-station\">" + esc(m.station) + "</span>" +
      (m.freq ? "<span class=\"cw-freq\">" + esc(m.freq) + "&nbsp;</span>" : "") +
      "<span class=\"cw-time\">" + utc(m.ts) + "</span></div>" +
      "<div class=\"cw-peek-text" + (isVp ? "" : " mono") + (canReply ? " pr-text" : "") + "\">" + (isVp ? esc(text) : fmt(text)) +
      (canReply ? "<span class=\"pr-pen\" data-pen=\"1\" title=\"Quick reply\">" + PEN_ICON + "</span>" : "") + "</div>" +
      "<div class=\"pr-box hidden\" id=\"cw-peek-reply\"></div>" + foot;
    peekMsg = m;
    peekUrgent = !!urgent;
    placePeek();
    if (urgent) clearTimeout(peekTimer); else armPeekClose(PEEK_MS);
  }

  // ---- quick reply from the peek: a private message is answered privately, frequency text on the frequency
  var PEN_ICON = "<svg viewBox=\"0 0 24 24\"><path d=\"M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4z\"/><path d=\"M13.5 6.5l4 4\"/></svg>";
  var peekReplyOpen = false, peekUrgent = false;
  function openPeekReply() {
    var m = peekMsg, box = el("cw-peek-reply");
    if (!m || !box) return;
    var to = m.kind === "pm" ? "Reply to " + esc(m.station) : "Reply on " + esc(m.freq || "the frequency");
    box.innerHTML = "<div class=\"pr-to\"><span>" + to + "</span><span class=\"k\">· Enter sends, Esc cancels</span>" +
      "<span class=\"pr-pen on\" data-pen=\"1\" title=\"Close the quick reply\">" + PEN_ICON + "</span></div>" +
      "<div class=\"pr-row\"><input id=\"cw-peek-in\" class=\"cw-input\" type=\"text\"/><div class=\"cw-btn primary\" data-peek-send=\"1\">Send</div></div>" +
      "<div class=\"cw-peek-foot\" id=\"cw-peek-rstate\"></div>";
    box.classList.remove("hidden");
    var pen = el("cw-peek").querySelector(".pr-text > .pr-pen");
    if (pen) pen.classList.add("hidden");
    peekReplyOpen = true;
    clearTimeout(peekTimer);                                         // no timeout while typing
    var input = el("cw-peek-in");
    wireInput(input, sendPeekReply);
    placePeek();
    input.focus();
  }
  function closePeekReply(silent) {
    if (!peekReplyOpen) return;
    peekReplyOpen = false;
    var box = el("cw-peek-reply"), pen = el("cw-peek").querySelector(".pr-text > .pr-pen");
    if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
    if (pen) pen.classList.remove("hidden");
    if (silent) return;
    releaseKeyboard();
    placePeek();
    if (!peekUrgent) armPeekClose(PEEK_MS);
  }
  function sendPeekReply() {
    var m = peekMsg, input = el("cw-peek-in");
    if (!m || !input) return;
    var text = input.value.replace(/\s+/g, " ").trim();
    if (!text) return;
    var chat = m.kind === "pm" ? String(m.chat || m.station).toUpperCase() : "FREQ";
    var st = el("cw-peek-rstate");
    if (st) { st.className = "cw-peek-foot"; st.textContent = "Sending..."; }
    act("vp/command", { text: text, chat: chat }, null, null, function (ok, data) {
      var s = el("cw-peek-rstate");
      if (!ok) { if (s) { s.className = "cw-peek-foot unread"; s.textContent = plain((data && data.error) || "Not sent"); } return; }
      if (m && !m.acked) { m.acked = true; act("ack", { id: m.id }, null); }
      peekReplyOpen = false;
      releaseKeyboard();
      if (s) { s.className = "cw-peek-foot sent"; s.textContent = "Sent"; }
      var inp = el("cw-peek-in"); if (inp) inp.disabled = true;
      peekUrgent = false;
      armPeekClose(1500);
    });
  }

  // closes after a while, but never while the mouse is over it (the timer restarts on leaving)
  var peekHover = false;
  function armPeekClose(ms) {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(function () { if (!peekHover) hidePeek(); }, ms);
  }

  function hidePeek() {
    if (peekReplyOpen) closePeekReply(true);
    peekUrgent = false;
    clearTimeout(peekTimer);
    el("cw-peek").classList.add("hidden");
    peekMsg = null;
    peekHover = false;
  }

  // Scrollbars: MSFS draws none for panel lists, so the mouse wheel was the only way to scroll. Each scrolling area
  // gets a thin bar on its right, laid over it in its parent: drag the thumb, or click the track to jump there.
  var sbars = [];
  function setupScrollbars() {
    ["cw-vp-chat", "cw-vp-atc", "cw-list", "cw-pane-selcal", "cw-notes-text"].forEach(function (id) {
      var host = el(id);
      if (!host || !host.parentNode) return;
      var par = host.parentNode;
      if (window.getComputedStyle(par).position === "static") par.style.position = "relative";
      var bar = document.createElement("div"), thumb = document.createElement("div");
      bar.className = "cw-sbar hidden"; thumb.className = "cw-sthumb";
      bar.appendChild(thumb);
      par.appendChild(bar);
      var sb = { host: host, bar: bar, thumb: thumb, drag: null };
      sbars.push(sb);
      host.addEventListener("scroll", function () { updateScrollbar(sb); });
      thumb.addEventListener("mousedown", function (e) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        sb.drag = { y: e.clientY, top: host.scrollTop };
      });
      bar.addEventListener("mousedown", function (e) {            // click on the track: jump there
        if (e.button !== 0 || e.target === thumb) return;
        e.preventDefault(); e.stopPropagation();
        var r = bar.getBoundingClientRect(), th = thumb.offsetHeight;
        var f = Math.max(0, Math.min(1, (e.clientY - r.top - th / 2) / Math.max(1, r.height - th)));
        host.scrollTop = f * (host.scrollHeight - host.clientHeight);
        sb.drag = { y: e.clientY, top: host.scrollTop };
      });
    });
    document.addEventListener("mousemove", function (e) {
      for (var i = 0; i < sbars.length; i++) {
        var sb = sbars[i];
        if (!sb.drag) continue;
        var range = sb.host.scrollHeight - sb.host.clientHeight, track = sb.bar.clientHeight - sb.thumb.offsetHeight;
        sb.host.scrollTop = sb.drag.top + (e.clientY - sb.drag.y) * range / Math.max(1, track);
      }
    });
    document.addEventListener("mouseup", function () { for (var i = 0; i < sbars.length; i++) sbars[i].drag = null; });
    setInterval(function () { for (var i = 0; i < sbars.length; i++) updateScrollbar(sbars[i]); }, 300);
  }
  // Mouse wheel over the card, peek, radar window or icon: marked as used here (the list under the mouse is scrolled
  // by hand), so MSFS has less reason to pass it on to the cockpit, e.g. while the camera is moving. The radar zooms
  // with its own wheel handler first and marks the event itself.
  function swallowWheel(root) {
    if (!root) return;
    root.addEventListener("wheel", function (e) {
      e.stopPropagation();
      if (e.defaultPrevented) return;                 // already used (radar zoom)
      var t = e.target;
      while (t && t.nodeType === 1) {
        var oy = window.getComputedStyle(t).overflowY;
        if ((oy === "auto" || oy === "scroll") && t.scrollHeight > t.clientHeight + 1) break;
        if (t === root) { t = null; break; }
        t = t.parentNode;
      }
      if (t && t.nodeType === 1) {
        var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? t.clientHeight : 1);
        // the sim's wheel steps are large: one notch moves about two and a half lines, glided over a few frames
        var em = parseFloat(window.getComputedStyle(t).fontSize) || 14, notch = 3.2 * em;
        if (Math.abs(dy) > notch) dy = dy > 0 ? notch : -notch;
        smoothScroll(t, dy);
      }
      e.preventDefault();
    }, false);
  }
  // glide a box's scroll towards a target: each wheel notch adds to the target, the box eases there
  var raf = window.requestAnimationFrame ? function (f) { window.requestAnimationFrame(f); } : function (f) { setTimeout(f, 16); };
  function smoothScroll(t, dy) {
    var a = t.cwGlide || (t.cwGlide = { active: false, target: 0 });
    var max = Math.max(0, t.scrollHeight - t.clientHeight);
    if (!a.active) a.target = t.scrollTop;
    a.target = Math.max(0, Math.min(max, a.target + dy));
    if (a.active) return;
    a.active = true;
    (function step() {
      var cur = t.scrollTop, d = a.target - cur;
      if (Math.abs(d) < 2) { t.scrollTop = a.target; a.active = false; return; }
      var move = d * 0.3;
      if (Math.abs(move) < 1.5) move = d > 0 ? 1.5 : -1.5;
      t.scrollTop = cur + move;
      if (t.scrollTop === cur) { a.active = false; return; }    // at an end (or the box can't move)
      raf(step);
    })();
  }
  function setupWheel() {
    ["cw-card", "cw-peek", "cw-radar-win", "cw-bubble"].forEach(function (id) { swallowWheel(el(id)); });
  }
  function updateScrollbar(sb) {
    var h = sb.host, ch = h.clientHeight, sh = h.scrollHeight;
    var show = h.offsetParent !== null && ch > 0 && sh > ch + 1;
    sb.bar.classList.toggle("hidden", !show);
    if (!show) return;
    sb.bar.style.top = (h.offsetTop + 3) + "px";
    sb.bar.style.height = Math.max(10, ch - 6) + "px";
    var track = ch - 6, th = Math.max(Math.round(track * ch / sh), 24);
    sb.thumb.style.height = th + "px";
    sb.thumb.style.top = Math.round((track - th) * h.scrollTop / Math.max(1, sh - ch)) + "px";
  }

  function onPeekClick(e) {
    if (el("cw-peek").classList.contains("tsat")) { hidePeek(); if (!expanded) setExpanded(true); return; }
    if (pick(e.target, "data-pen")) { if (peekReplyOpen) closePeekReply(); else openPeekReply(); return; }
    if (pick(e.target, "data-peek-send")) return sendPeekReply();
    if (up(e.target, "#cw-peek-reply")) return;                       // clicks in the reply box stay there
    var r = pick(e.target, "data-peek-reply");
    if (!r) return openPeeked();
    var m = peekMsg;
    if (!m) return;
    var btns = el("cw-peek").getElementsByClassName("cw-actions")[0];
    if (btns) btns.style.display = "none";
    var stateEl = el("cw-peek-state");
    if (stateEl) stateEl.textContent = "Sending " + r + "...";
    act("reply", { id: m.id, text: r }, null, null, function (ok, data) {
      var s = el("cw-peek-state");
      if (s) { s.textContent = ok ? r + " sent" : plain(data.error || "Failed"); s.className = "cw-peek-foot" + (ok ? " sent" : " unread"); }
      if (!ok && btns) btns.style.display = "";
      armPeekClose(ok ? 2000 : PEEK_MS);
    });
  }

  // next to the icon, on the side the card opens (the other side while the card is open)
  function placePeek() {
    var b = el("cw-bubble"), p = el("cw-peek");
    var bx = b.offsetLeft, by = b.offsetTop, bs = b.offsetWidth || 48, gap = 10 * scale;
    var pw = p.offsetWidth || 300, ph = p.offsetHeight || 100;
    var d = cardDirection(), right = d.right;
    if (expanded) {                       // other side if there is room, else briefly over the card
      var ox = d.right ? bx - pw - gap : bx + bs + gap;
      if (ox >= 4 && ox + pw <= window.innerWidth - 4) right = !d.right;
    }
    var x = right ? bx + bs + gap : bx - pw - gap;
    var y = d.down ? by : by + bs - ph;
    p.style.left = Math.max(4, Math.min(window.innerWidth - pw - 4, x)) + "px";
    p.style.top = Math.max(4, Math.min(window.innerHeight - ph - 4, y)) + "px";
  }

  // clicking the peek opens the card on that message
  function openPeeked() {
    var m = peekMsg;
    hidePeek();
    if (!m) return;
    if (VP[m.kind]) {
      var c = String(m.chat || "FREQ").toUpperCase();
      if (c !== "FREQ" && openedChats.indexOf(c) < 0) { openedChats.push(c); save("CLEARWAY_CHATS", openedChats); }
      if (closedChats[c] !== undefined) { delete closedChats[c]; save("CLEARWAY_CLOSED", closedChats); }
      activeChat = c; atcOpen = false; lastChatKey = "";
    }
    notesOpen = false;
    showTab(VP[m.kind] ? "vpilot" : "cpdlc");
    if (!expanded) setExpanded(true);
  }

  function toggleLock() {
    placementLock = placementLock ? null : cardDirection();
    save("CLEARWAY_LOCK", placementLock);
    updateLockButton();
    placeCard();
  }

  function updateLockButton() {
    var btn = el("cw-lock");
    btn.classList.toggle("on", !!placementLock);
    btn.title = placementLock ? "Card direction locked (click to unlock)" : "Lock where the card opens";
  }

  // ------------------------------------------------------------ Radar tab / detached radar window
  // The radar (radar.js) lives in the card's Radar tab. Its detach button moves the same element into a
  // separate window over the screen that can be moved and resized and stays open while the card is closed;
  // the dock button (or "Put it back here" in the tab) returns it. The radar pauses by itself whenever it
  // is not visible (other tab, card closed), so nothing is downloaded or drawn then.
  var radarDetached = false;
  // compact (the card's size, like the other tabs) or big (the expand button: twice as wide and taller), remembered
  var radarBig = !!load("CLEARWAY_RADAR_BIG", false);
  function toggleRadarBig() {
    radarBig = !radarBig;
    save("CLEARWAY_RADAR_BIG", radarBig);
    applyRadarBig(true);
  }
  function applyRadarBig(resizeWindow) {
    var r = document.getElementById("rd-radar"), x = document.getElementById("rd-expand");
    if (r) r.classList.toggle("big", radarBig);
    if (x) x.title = radarBig ? "Smaller radar" : "Bigger radar";
    if (radarDetached && resizeWindow) {
      // the window jumps to the matching size; it can still be resized freely with its corner grip
      var w = el("cw-radar-win"), em = parseFloat(window.getComputedStyle(w).fontSize) || 14;
      var ww = (radarBig ? 53.2 : 25.8) * em, wh = (radarBig ? 26.9 : CARD_MAX * 0.8) * em;
      ww = Math.min(window.innerWidth - 8, ww); wh = Math.min(window.innerHeight - 8, wh);
      w.style.width = ww + "px"; w.style.height = wh + "px";
      w.style.left = Math.max(4, Math.min(window.innerWidth - ww - 4, w.offsetLeft)) + "px";
      w.style.top = Math.max(4, Math.min(window.innerHeight - wh - 4, w.offsetTop)) + "px";
      saveRadarWindow();
    }
    showTab(tab);
  }
  function startRadar() {
    if (typeof ClearwayRadar === "undefined") return;
    ClearwayRadar.mount({ api: API, container: el("cw-radar-dock"), capture: el("cw-capture"), onDetach: toggleRadarWindow,
                         onExpand: toggleRadarBig, wireInput: wireInput,
                         // your arrival for the radar's line when your network flight plan has none: the SimBrief one
                         myArrival: function () { var sb = state && state.selcal && state.selcal.simbrief; return (sb && sb.arrival) || ""; } });
    applyRadarBig(false);
    var w = el("cw-radar-win");
    makeWindowDraggable(el("cw-rw-head"), w);
    makeWindowResizable(el("cw-rw-grip"), w);
    el("cw-rw-dock").addEventListener("click", function () { setRadarDetached(false); });
    el("cw-radar-back").addEventListener("click", function () { setRadarDetached(false); });
    setRadarDetached(!!load("CLEARWAY_RADAR_DETACHED", false));
  }
  function toggleRadarWindow() { setRadarDetached(!radarDetached); }
  function setRadarDetached(on) {
    var r = document.getElementById("rd-radar");
    if (!r) return;
    radarDetached = on;
    save("CLEARWAY_RADAR_DETACHED", on);
    (on ? el("cw-rw-body") : el("cw-radar-dock")).appendChild(r);   // the radar's listeners move with it
    r.classList.toggle("detached", on);
    var d = document.getElementById("rd-detach");
    if (d) d.title = on ? "Put the radar back in the Clearway card" : "Open the radar in its own window";
    el("cw-radar-win").classList.toggle("hidden", !on);
    el("cw-radar-dock").classList.toggle("hidden", on);
    el("cw-radar-away").classList.toggle("hidden", !on);
    if (on) placeRadarWindow(load("CLEARWAY_RADAR_WIN", null));
    showTab(tab);
  }
  // saved as fractions of the screen so it survives resolution / window changes
  function placeRadarWindow(g) {
    var w = el("cw-radar-win"), sw = window.innerWidth, sh = window.innerHeight;
    g = g || { x: 0.25, y: 0.2, w: 0.45, h: 0.5 };
    var ww = Math.max(18 * 12.5 * scale, Math.min(sw - 8, g.w * sw)), wh = Math.max(12 * 12.5 * scale, Math.min(sh - 8, g.h * sh));
    var x = Math.max(4, Math.min(sw - ww - 4, g.x * sw)), y = Math.max(4, Math.min(sh - wh - 4, g.y * sh));
    w.style.left = x + "px"; w.style.top = y + "px"; w.style.width = ww + "px"; w.style.height = wh + "px";
  }
  function saveRadarWindow() {
    var w = el("cw-radar-win"), sw = window.innerWidth || 1, sh = window.innerHeight || 1;
    save("CLEARWAY_RADAR_WIN", { x: w.offsetLeft / sw, y: w.offsetTop / sh, w: w.offsetWidth / sw, h: w.offsetHeight / sh });
  }
  // drag helpers for the radar and notepad windows (and the card's notepad grip): the capture layer keeps the drag
  // going outside the window. w: the element moved / resized (the radar window by default); onEnd: saves its place
  function windowDrag(handle, onMove, skip, w, onEnd) {
    w = w || el("cw-radar-win");
    onEnd = onEnd || saveRadarWindow;
    handle.addEventListener("mousedown", function (e) {
      if (e.button !== 0 || (skip && skip(e))) return;
      var sx = e.clientX, sy = e.clientY, cap = el("cw-capture");
      var o = { x: w.offsetLeft, y: w.offsetTop, w: w.offsetWidth, h: w.offsetHeight };
      cap.classList.add("on");
      function move(ev) { onMove(o, ev.clientX - sx, ev.clientY - sy); }
      function upHandler() {
        cap.classList.remove("on");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", upHandler);
        onEnd();
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", upHandler);
      e.preventDefault();
      e.stopPropagation();
    });
  }
  function makeWindowDraggable(handle, w, onEnd) {
    windowDrag(handle, function (o, dx, dy) {
      w.style.left = Math.max(4, Math.min(window.innerWidth - o.w - 4, o.x + dx)) + "px";
      w.style.top = Math.max(4, Math.min(window.innerHeight - o.h - 4, o.y + dy)) + "px";
    }, function (e) { return !!up(e.target, ".cw-icon-btn"); }, w, onEnd);
  }
  function makeWindowResizable(grip, w, onEnd, minEm) {
    windowDrag(grip, function (o, dx, dy) {
      var minW = (minEm ? minEm[0] : 18) * 12.5 * scale, minH = (minEm ? minEm[1] : 12) * 12.5 * scale;
      w.style.width = Math.max(minW, Math.min(window.innerWidth - o.x - 4, o.w + dx)) + "px";
      w.style.height = Math.max(minH, Math.min(window.innerHeight - o.y - 4, o.h + dy)) + "px";
    }, null, w, onEnd);
  }

  // ------------------------------------------------------------ Chemtrail: the notepad's hidden game (1.5.0)
  // A faint cloud in the notes box's bottom-right corner starts it; a faint "exit" there brings the notes back
  // untouched (they are only hidden meanwhile). Fly a plane on a grid with the arrows or WASD; every waypoint of your
  // SimBrief route (departure, fixes, arrival, then back) makes the chemtrail longer. Crossing it, leaving the field
  // or hitting traffic ends the flight; inside a thunderstorm the trail shrinks by the echo's colour.
  // In the sim the arrows reach the game through the panel's keyboard capture (keyboardOwner = CG_OWNER), so they
  // don't move the camera. Losing focus (Esc, a click elsewhere, leaving the notepad) pauses it.
  var CG_OWNER = "cg-canvas", CG = null;
  var CG_CLOUD = "<svg viewBox='0 0 24 24'><path d='M7.5 18.5h9.2a3.8 3.8 0 0 0 .4-7.6 5.3 5.3 0 0 0-10.2-1.2A4.4 4.4 0 0 0 7.5 18.5z'/></svg>";
  var CG_FIXES = ["ALPHA", "BRAVO", "KILOS", "NIKEL", "ROMEO", "SIERA", "TANGO", "VICTR", "WHSKY", "XRAYS"];
  var CG_KEYS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0], z: [0, -1], q: [-1, 0] };
  function cgRoute() {
    var sb = state && state.selcal && state.selcal.simbrief;
    if (sb && sb.departure && sb.arrival) {
      var fx = (sb.fixes || []).filter(function (f) { return f && f !== sb.departure && f !== sb.arrival; });
      return { route: [sb.departure].concat(fx.length ? fx : CG_FIXES, [sb.arrival]), cs: myCallsign() || sb.callsign || "" };
    }
    return { route: ["DEPT"].concat(CG_FIXES, ["ARRV"]), cs: myCallsign() || "" };
  }
  function cgPlaceCloud() {
    var cl = el("cg-cloud"), ta = el("cw-notes-text"), body = el("cw-notes-body");
    if (!cl || CG || !ta.offsetHeight) return;
    var a = ta.getBoundingClientRect(), b = body.getBoundingClientRect();
    cl.style.right = Math.max(4, b.right - a.right + 5) + "px";
    cl.style.bottom = Math.max(0, b.bottom - a.bottom + 5) + "px";
  }
  function cgKey(k) {                                  // a key for the game (native or captured)
    if (!CG) return;
    var G = CG.G, d = CG_KEYS[k] || CG_KEYS[(k || "").toLowerCase()];
    if (d && G.state === "playing" && !(d[0] === -G.dir[0] && d[1] === -G.dir[1])) G.next = d;
    if ((k === " " || k === "Spacebar") && G.state === "over") { CG.reset(); G.state = "playing"; G.last = 0; G.acc = 0; }
  }
  // the sim sends key events with an empty .key (1.5.0 test): fall back to the key code
  var CG_CODES = { 37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown", 32: " ", 87: "w", 65: "a", 83: "s", 68: "d", 90: "z", 81: "q" };
  function cgKeyOf(e) { return e.key || CG_CODES[e.keyCode || e.which] || ""; }
  function cgPause() { if (CG && CG.G.state === "playing") CG.G.state = "paused"; }
  function cgHoldKeys(on) {                            // the panel's keyboard capture, for the arrows
    if (on) {
      keyboardOwner = CG_OWNER; clearTimeout(idleTimer); clearTimeout(keysOffTimer);
      if (!keysWanted) wantKeys(true);
    } else if (keyboardOwner === CG_OWNER) {
      keyboardOwner = null;
      clearTimeout(keysOffTimer);
      keysOffTimer = setTimeout(function () { if (!keyboardOwner && keysWanted) wantKeys(false); }, 120);
    }
  }
  function cgExit() {
    if (!CG) return;
    cgHoldKeys(false);
    if (CG.off) CG.off();
    CG.cv.parentNode.removeChild(CG.cv); CG.ex.parentNode.removeChild(CG.ex);
    CG = null;
    el("cw-notes-text").style.display = ""; el("cg-cloud").style.display = "";
    notesLocked = false; updateCardGrip();
    el("cw-notes-body").classList.remove("cg-on");
    cgPlaceCloud();
  }
  function cgStart() {
    if (CG) return;
    var ta = el("cw-notes-text"), body = el("cw-notes-body");
    var dpr = typeof Coherent !== "undefined" ? 1 : (window.devicePixelRatio || 1);   // the sim shows a canvas at its pixel size
    // the game's box (#cg-canvas) holds stacked canvases used in turn: in the sim a canvas repainted in place stays on
    // its old picture, and a new picture reaches the screen a few frames late (like the radar). So every frame draws on
    // the next canvas underneath, and the one drawn LAG frames ago comes to the front: a new picture every frame
    // (smooth movement), each shown once the sim has it ready. In a browser: one canvas would do, two are used
    // LAG + 2 canvases: the one on screen (drawn LAG frames ago), the LAG still on their way, and the one drawn next
    var IN_SIM = typeof Coherent !== "undefined", LAG = IN_SIM ? 3 : 0, NBUF = LAG + 2;
    var cv = document.createElement("div");
    cv.id = "cg-canvas"; cv.tabIndex = 0;
    var bufs = [], ctxs = [], drawn = 0;                 // drawn: pictures drawn so far (picture n is on bufs[n % NBUF])
    for (var bi0 = 0; bi0 < Math.max(2, NBUF); bi0++) { bufs.push(document.createElement("canvas")); bufs[bi0].className = "cg-buf"; cv.appendChild(bufs[bi0]); ctxs.push(bufs[bi0].getContext("2d")); }
    NBUF = bufs.length;
    ta.parentNode.insertBefore(cv, ta);
    ta.style.display = "none"; el("cg-cloud").style.display = "none";
    notesLocked = true; updateCardGrip();               // the card's size is locked while playing
    body.classList.add("cg-on");
    var ex = document.createElement("div"); ex.id = "cg-exit"; ex.textContent = "exit"; body.appendChild(ex);
    var rt = cgRoute(), ROUTE = rt.route, SEQ = ROUTE.concat(ROUTE.slice(1, -1).reverse());
    function isAirport(n) { return n === ROUTE[0] || n === ROUTE[ROUTE.length - 1]; }
    var ctx = ctxs[0], frontB = -1;
    var C = {}, r = { w: 0, h: 0 }, em, cell, top, cols, rows, F, ox, oy;
    // one frame: draw the next picture underneath, bring the one drawn LAG frames ago to the front
    function present() {
      var nb = drawn % NBUF;
      ctx = ctxs[nb]; draw(); drawn++;
      var show = drawn - 1 - LAG;
      if (show < 0) return;
      var fb = show % NBUF;
      if (fb === frontB) return;
      if (frontB >= 0) bufs[frontB].className = "cg-buf";
      bufs[fb].className = "cg-buf front"; frontB = fb;
    }
    // (1.5.0 user) the board is always very dark, whatever the theme, so the game reads well: fixed dark colours
    function colours() {
      C = { bg: "#0b0d10", text: "#e6e9f0", muted: "#a7afc2", vp: "#00d8d4", amber: "#f8c067", line: "#2a3340", rose: "#ff8a8a" };
    }
    function fit() {
      var b = cv.getBoundingClientRect();
      if (Math.abs(b.width - r.w) < 0.5 && Math.abs(b.height - r.h) < 0.5) return;
      r = { w: b.width, h: b.height };
      for (var bi = 0; bi < NBUF; bi++) {
        bufs[bi].width = Math.round(r.w * dpr); bufs[bi].height = Math.round(r.h * dpr); ctxs[bi].setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      em = parseFloat(window.getComputedStyle(body).fontSize) || 12.6;
      // (1.5.0 user: fit the card better at the top and bottom) "exit" sits in the title row, so only a thin margin
      // is kept under the board
      cell = Math.round(em * 1.05); top = Math.round(em * 1.6);
      cols = Math.max(8, Math.floor((r.w - em) / cell)); rows = Math.max(6, Math.floor((r.h - top - em * 0.45) / cell));
      F = function (k, wgt) { return (wgt || 700) + " " + (em * k).toFixed(1) + "px Selawik, 'Roboto-Regular', Roboto, 'Segoe UI', Arial, sans-serif"; };
      ox = Math.round((r.w - cols * cell) / 2); oy = top;
      colours();
    }
    // "exit" at the right end of the title row (after the scores, which leave room for it), lined up with the
    // board's right edge. Followed every frame: the flight block under the canvas can arrive or change after the game
    // opened (it sat in the wrong place, 1.5.0 test)
    var exKey = "";
    function placeExit() {
      var b = cv.getBoundingClientRect(), bb = body.getBoundingClientRect();
      var right = Math.round(bb.right - b.right + (r.w - ox - cols * cell)), topPx = Math.round(b.top - bb.top + top / 2), k = right + "," + topPx;
      if (k === exKey) return;
      exKey = k; ex.style.right = right + "px"; ex.style.top = topPx + "px"; ex.style.bottom = "auto";
    }
    fit();
    var G = { state: "ready", trail: [], dir: [1, 0], next: [1, 0], wp: null, score: 0, best: +(load("CLEARWAY_CHEMTRAIL_BEST", 0) || 0), speed: 2, acc: 0, last: 0 };
    function rnd(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
    function key(x, y) { return x + "," + y; }
    function reset() {
      var cx = Math.floor(cols / 3), cy = Math.floor(rows / 2);
      G.trail = [[cx, cy], [cx - 1, cy], [cx - 2, cy]]; G.dir = [1, 0]; G.next = [1, 0]; G.score = 0; G.speed = 2; G.leg = 0; G.gotWp = null; G.acc = 0; placeWp();
      G.time = 0; G.traffic = []; G.storms = []; G.nextTraffic = 8 + Math.random() * 8; G.nextStorm = 25 + Math.random() * 15; G.drain = 0;
    }
    function spawnTraffic() {
      var h = G.trail[0], horiz = Math.random() < 0.5, t;
      for (var tries = 0; tries < 10; tries++) {
        if (horiz) { var y = rnd(1, rows - 2), dx = Math.random() < 0.5 ? 1 : -1; t = { x: dx > 0 ? 0 : cols - 1, y: y, dir: [dx, 0] }; }
        else { var x = rnd(1, cols - 2), dy = Math.random() < 0.5 ? 1 : -1; t = { x: x, y: dy > 0 ? 0 : rows - 1, dir: [0, dy] }; }
        if (Math.abs(t.x - h[0]) + Math.abs(t.y - h[1]) > 7) break;     // never right on top of you
      }
      // small and slow (1 square, half your speed), or big (2 squares: middle and nose) at three quarters of your speed
      // (1.5.0 user: the big one was 5 squares, drawn 3 wide, at your speed: too big and a bit too fast)
      t.big = Math.random() < 0.5; t.rate = t.big ? 0.75 : 0.5; t.acc = 0;
      G.traffic.push(t);
    }
    function trafficCells(t) {
      if (!t.big) return [[t.x, t.y]];
      return [[t.x, t.y], [t.x + t.dir[0], t.y + t.dir[1]]];
    }
    // smooth random noise (values 0..1 on a grid every L squares, blended in between): makes the echo ragged
    function mkNoise(L) {
      var g = {};
      function v(i, j) { var k = i + "," + j; return g[k] === undefined ? (g[k] = Math.random()) : g[k]; }
      return function (x, y) {
        x /= L; y /= L;
        var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
        var a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * fx, b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * fx;
        return a + (b - a) * fy;
      };
    }
    // radar echo colours, weakest to strongest. The drain bands stay: green 0, yellow/orange 1, red 2, magenta 3
    var RAMP = [[0, "#3f8a8c"], [0.1, "#27b04b"], [0.19, "#17843a"], [0.28, "#f2df3a"], [0.4, "#f39a26"],
                [0.52, "#e5362b"], [0.63, "#a91d1d"], [0.74, "#d93fb5"], [0.87, "#f2a8e6"]];
    function rampIndex(v) { var i = 0; while (i + 1 < RAMP.length && v >= RAMP[i + 1][0]) i++; return i; }
    // a thunderstorm drawn like a weather radar (1.5.0 user: round cells looked weird): a ragged echo in small pixels
    // (a third of a square) with speckled edges, a ninth to a sixth of the field. Each square's strength for the
    // game is the average of its pixels, so what you see is what drains you.
    function buildStorm(cx, cy, frac) {
      var S = 4, target = cols * rows * frac, blobs = [], b, grow, i, px = [], cells = {}, kk;
      var n1 = mkNoise(2.4), n2 = mkNoise(1), n3 = mkNoise(0.45);
      for (b = 0; b < 5; b++) {
        var ang = Math.random() * Math.PI;
        blobs.push({ x: cx + rnd(-3, 3) + Math.random(), y: cy + rnd(-2, 2) + Math.random(), r: 1 + Math.random(),
                     sq: 0.55 + Math.random() * 0.7, ca: Math.cos(ang), sa: Math.sin(ang), k: 0.75 + Math.random() * 0.4 });
      }
      for (grow = 0; grow < 40; grow++) {
        px = []; cells = {};
        var sums = {}, n = 0;
        for (var gx = 0; gx < cols * S; gx++) for (var gy = 0; gy < rows * S; gy++) {
          var x = (gx + 0.5) / S, y = (gy + 0.5) / S, base = 0, near = 9;
          for (b = 0; b < blobs.length; b++) {
            var o = blobs[b], dx = x - o.x, dy = y - o.y, u = dx * o.ca + dy * o.sa, w = (dy * o.ca - dx * o.sa) / o.sq,
                dd = Math.sqrt(u * u + w * w) / o.r;
            if (dd < near) near = dd;
            if (dd < 1) base += o.k * Math.pow(1 - dd, 1.3);   // added up, so neighbouring cells merge (no bullseyes)
          }
          if (near > 1.35) continue;
          // the noise scales the echo (breaks up the rings) and adds grain, like a real radar return
          // (added strength saturates softly: one cell peaks around red, magenta only where cells pile up)
          var inten = base ? 0.95 * (1 - Math.exp(-1.3 * base)) * (0.7 + 0.6 * n1(x, y)) + 0.2 * (n2(x, y) - 0.5) +
                             0.12 * (n3(x, y) - 0.5) + 0.06 * (Math.random() - 0.5) : 0;
          if (inten < 0.04) {                              // the speckled fringe around the echo
            if (near < 1.25 && Math.random() < (near < 1 ? 0.5 : 0.16)) inten = 0.02 + Math.random() * 0.07; else continue;
          }
          inten = Math.min(1, inten);
          px.push([gx, gy, inten]);
          kk = key(Math.floor(gx / S), Math.floor(gy / S)); sums[kk] = (sums[kk] || 0) + inten;
        }
        for (kk in sums) { var avg = sums[kk] / (S * S); if (avg > 0.03) { cells[kk] = avg; n++; } }
        if (n >= target) break;
        for (b = 0; b < blobs.length; b++) blobs[b].r += 0.25 + Math.random() * 0.2;
      }
      var groups = RAMP.map(function () { return []; });
      px.forEach(function (p) { groups[rampIndex(p[2])].push(p); });
      var list = Object.keys(cells), core = list.filter(function (k) { return cells[k] > 0.3; }), bolts = [];
      if (!core.length) core = list;
      for (i = 0; i < Math.max(2, Math.round(list.length / 11)); i++) bolts.push(core[rnd(0, core.length - 1)].split(",").map(Number));
      return { cells: cells, groups: groups, S: S, bolts: bolts, born: G.time, warm: 5, life: 5 + 10 + Math.random() * 10 };   // 5 s fading in (harmless), then 10-20 s
    }
    function spawnStorm() {
      var h = G.trail[0], cx, cy;
      for (var tries = 0; tries < 20; tries++) { cx = rnd(3, cols - 4); cy = rnd(2, rows - 3); if (Math.abs(cx - h[0]) + Math.abs(cy - h[1]) > 9) break; }
      G.storms.push(buildStorm(cx, cy, 1 / 9 + Math.random() * (1 / 6 - 1 / 9)));
    }
    // puffs lost per second where you are, by the echo's colour: green 0, yellow 1, red 2, magenta 3
    function stormRate(p) {
      var inten = 0;
      G.storms.forEach(function (s) { if (G.time - s.born >= s.warm) inten = Math.max(inten, s.cells[key(p[0], p[1])] || 0); });
      return inten >= 0.74 ? 3 : inten >= 0.52 ? 2 : inten >= 0.28 ? 1 : 0;
    }
    function hitTraffic() {
      var h = G.trail[0];
      return G.traffic.some(function (t) { return trafficCells(t).some(function (c) { return c[0] === h[0] && c[1] === h[1]; }); });
    }
    function placeWp() {
      var p;
      do { p = [1 + Math.floor(Math.random() * (cols - 2)), 1 + Math.floor(Math.random() * (rows - 2))]; }
      while (G.trail.some(function (s) { return s[0] === p[0] && s[1] === p[1]; }));
      var k = (G.leg++) % SEQ.length;
      G.wp = { x: p[0], y: p[1], name: SEQ[k], back: k >= ROUTE.length };
    }
    function over(why) {
      G.state = "over"; G.why = why;
      if (G.score > G.best) { G.best = G.score; save("CLEARWAY_CHEMTRAIL_BEST", G.best); }
    }
    function step() {
      G.dir = G.next;
      var h = G.trail[0], n = [h[0] + G.dir[0], h[1] + G.dir[1]];
      if (n[0] < 0 || n[1] < 0 || n[0] >= cols || n[1] >= rows) return over("Left the airspace");
      if (G.trail.some(function (s, i) { return i < G.trail.length - 1 && s[0] === n[0] && s[1] === n[1]; })) return over("Chemtrail crossed");
      G.trail.unshift(n);
      G.gotWp = null;
      if (n[0] === G.wp.x && n[1] === G.wp.y) { G.gotWp = G.wp; G.score++; G.speed = Math.min(14, G.speed + (isAirport(G.wp.name) ? 1 : 0.5)); placeWp(); }
      else G.trail.pop();
      G.time += 1 / G.speed;                              // traffic and storms are timed in real seconds
      if (hitTraffic()) return over("Traffic collision");
      G.traffic.forEach(function (t) { t.acc += t.rate; while (t.acc >= 1) { t.acc -= 1; t.x += t.dir[0]; t.y += t.dir[1]; } });
      G.traffic = G.traffic.filter(function (t) { return t.x >= -2 && t.y >= -2 && t.x < cols + 2 && t.y < rows + 2; });
      if (hitTraffic()) return over("Traffic collision");
      if (G.time >= G.nextTraffic && G.traffic.length < 3) { spawnTraffic(); G.nextTraffic = G.time + 8 + Math.random() * 8; }
      G.storms = G.storms.filter(function (s) {           // the 25-40 s wait for the next storm starts when one ends
        if (G.time - s.born < s.life) return true;
        G.nextStorm = G.time + 25 + Math.random() * 15; return false;
      });
      if (!G.storms.length && G.time >= G.nextStorm) { spawnStorm(); G.nextStorm = Infinity; }
      var rate = stormRate(n);
      if (rate) { G.drain += rate / G.speed; while (G.drain >= 1) { G.drain -= 1; if (G.trail.length > 2) G.trail.pop(); } }
      else G.drain = 0;
    }
    function plane(x, y, dir, col, sc) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(dir[1], dir[0])); if (sc) ctx.scale(sc, sc);
      ctx.fillStyle = col || C.vp; ctx.beginPath();
      ctx.moveTo(7, 0); ctx.lineTo(3, -1.3); ctx.lineTo(0.5, -6.5); ctx.lineTo(-1.5, -6.5); ctx.lineTo(-0.3, -1.4); ctx.lineTo(-4.5, -1.2);
      ctx.lineTo(-6, -3.6); ctx.lineTo(-7, -3.6); ctx.lineTo(-6.2, 0); ctx.lineTo(-7, 3.6); ctx.lineTo(-6, 3.6); ctx.lineTo(-4.5, 1.2);
      ctx.lineTo(-0.3, 1.4); ctx.lineTo(-1.5, 6.5); ctx.lineTo(0.5, 6.5); ctx.lineTo(3, 1.3); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    function center(p) { return [ox + p[0] * cell + cell / 2, oy + p[1] * cell + cell / 2]; }
    function draw() {
      ctx.clearRect(0, 0, r.w, r.h);
      // an opaque board (the theme's background without its glass transparency): the canvas being drawn underneath
      // must not show through the one in front
      ctx.fillStyle = String(C.bg).replace(/rgba\(\s*([^,]+),\s*([^,]+),\s*([^,]+),[^)]*\)/, "rgb($1, $2, $3)"); ctx.fillRect(0, 0, r.w, r.h);
      ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.strokeRect(ox - 0.5, oy - 0.5, cols * cell + 1, rows * cell + 1);
      ctx.font = F(0.85); ctx.textBaseline = "middle"; ctx.textAlign = "left";
      ctx.fillStyle = C.text; ctx.fillText("CHEMTRAIL", ox, top / 2);
      var tw = ctx.measureText("CHEMTRAIL  ").width;
      ctx.font = F(0.78, 600); ctx.fillStyle = C.muted;
      var back = G.wp && G.wp.back, a0 = ROUTE[0], a1 = ROUTE[ROUTE.length - 1];
      ctx.fillText((rt.cs ? rt.cs + "  " : "") + (back ? a1 + "-" + a0 : a0 + "-" + a1), ox + tw, top / 2);
      ctx.font = F(0.85); ctx.textAlign = "right";
      ctx.fillText("Waypoints " + G.score + "   Best " + G.best, ox + cols * cell - (ex.offsetWidth || em * 1.6) - em * 0.8, top / 2); ctx.textAlign = "left";
      (G.storms || []).forEach(function (s) {
        var age = G.time - s.born, fade = Math.max(0, Math.min(1, age / s.warm) * Math.min(1, (s.life - age) / 1.5));
        // pixels on whole screen pixels, edge to edge (no seams or overlaps), one path per colour
        var sub = cell / s.S;
        ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, cols * cell, rows * cell); ctx.clip();   // never past the board's edge
        ctx.globalAlpha = 0.9 * fade;
        s.groups.forEach(function (grp, gi) {
          if (!grp.length) return;
          ctx.fillStyle = RAMP[gi][1]; ctx.beginPath();
          grp.forEach(function (p) {
            var x0 = Math.round(ox + p[0] * sub), y0 = Math.round(oy + p[1] * sub);
            ctx.rect(x0, y0, Math.round(ox + (p[0] + 1) * sub) - x0, Math.round(oy + (p[1] + 1) * sub) - y0);
          });
          ctx.fill();
        });
        ctx.globalAlpha = (age < s.warm ? 0.45 : 1) * fade; ctx.fillStyle = "#ffffff";
        s.bolts.forEach(function (b) {
          var x = ox + b[0] * cell + cell / 2, y = oy + b[1] * cell + cell / 2, k = cell / 15;
          ctx.beginPath(); ctx.moveTo(x + 1.5 * k, y - 6 * k); ctx.lineTo(x - 3.5 * k, y + 1 * k); ctx.lineTo(x - 0.2 * k, y + 1 * k);
          ctx.lineTo(x - 1.5 * k, y + 6 * k); ctx.lineTo(x + 3.5 * k, y - 1 * k); ctx.lineTo(x + 0.2 * k, y - 1 * k); ctx.closePath(); ctx.fill();
        });
        ctx.restore();
        ctx.globalAlpha = 1;
      });
      // smooth movement (1.5.0 user: a 60 fps feel). Everything is drawn a QUARTER of a move behind the game: a plane is
      // on the middle of its square a quarter of the way through each step (1.5.0 user: a whole move ahead turned a
      // square early, a whole move behind lagged too much, half a move still a little). A key pressed while the plane
      // comes into a square turns it there. Paused keeps its place; a finished flight shows the plane on its last square.
      var LAGF = 0.25;
      var al0 = G.state === "over" ? LAGF : Math.max(0, Math.min(1, (G.acc || 0) / (1000 / G.speed)));
      [G.state === "playing" && al0 < LAGF ? G.gotWp : null, G.wp].forEach(function (wp) {   // the one just reached stays until the plane is there
        if (!wp) return;                                    // a fix: a triangle; an airport: a ring with a runway
        var q = center([wp.x, wp.y]);
        ctx.strokeStyle = C.amber; ctx.lineWidth = 1.6; ctx.beginPath();
        if (isAirport(wp.name)) { ctx.arc(q[0], q[1], 5, 0, Math.PI * 2); ctx.moveTo(q[0] - 3.5, q[1] + 3.5); ctx.lineTo(q[0] + 3.5, q[1] - 3.5); }
        else { ctx.moveTo(q[0], q[1] - 5); ctx.lineTo(q[0] + 5, q[1] + 4); ctx.lineTo(q[0] - 5, q[1] + 4); ctx.closePath(); }
        ctx.stroke();
        ctx.font = F(0.72, 600); ctx.fillStyle = C.amber;
        var tx = q[0] + 8, nameW = ctx.measureText(wp.name).width;
        if (tx + nameW > ox + cols * cell) tx = q[0] - 8 - nameW;
        ctx.fillText(wp.name, tx, q[1] - 6);
      });
      for (var i = G.trail.length - 1; i >= 1; i--) {      // the chemtrail: white puffs fading towards the tail (none under the plane)
        var c = center(G.trail[i]), al = 0.85 - 0.6 * (i / Math.max(1, G.trail.length - 1));
        ctx.globalAlpha = Math.max(0.18, al); ctx.fillStyle = C.text;
        ctx.beginPath(); ctx.arc(c[0], c[1], cell * 0.36, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      (G.traffic || []).forEach(function (t) {
        var f = t.acc + t.rate * (al0 - LAGF), p = center([t.x, t.y]);
        // the big one: about 1.35 squares long (1.5.0 user: 2 squares was still too big), centred towards its nose square
        if (t.big) f += 0.3;
        plane(p[0] + t.dir[0] * f * cell, p[1] + t.dir[1] * f * cell, t.dir, C.rose, t.big ? 1.35 * cell / 14 : 0);
      });
      // your plane (1.5.0 user: turns pivot on the TAIL). P, its middle, glides along the path; the tail is a little
      // behind it ON the path, so at a corner the tail stays on the old line while the nose swings round
      // first half of a step: coming into its square along the last move; second half: leaving it towards the next
      // move (a turn pressed then eases it onto the new line)
      var a = center(G.trail[1]), b = center(G.trail[0]), P;
      if (al0 < LAGF) P = [a[0] + (b[0] - a[0]) * (al0 + 1 - LAGF), a[1] + (b[1] - a[1]) * (al0 + 1 - LAGF)];
      else P = [b[0] + G.next[0] * (al0 - LAGF) * cell, b[1] + G.next[1] * (al0 - LAGF) * cell];
      if (!G.pv || G.state !== "playing") G.pv = P;
      else {
        var ex2 = P[0] - G.pv[0], ey2 = P[1] - G.pv[1];
        if (ex2 * ex2 + ey2 * ey2 > cell * cell * 0.09) { G.pv = [G.pv[0] + ex2 * 0.4, G.pv[1] + ey2 * 0.4]; } else G.pv = P;
      }
      P = G.pv;
      var pts = [P].concat(G.trail.slice(al0 < LAGF ? 1 : 0, 4).map(center)), need = cell * 0.35, tx2 = P[0], ty2 = P[1];
      for (var j = 1; j < pts.length && need > 0; j++) {
        var sx = pts[j][0] - tx2, sy = pts[j][1] - ty2, sl = Math.sqrt(sx * sx + sy * sy);
        if (sl < 0.001) continue;
        if (sl >= need) { tx2 += sx / sl * need; ty2 += sy / sl * need; need = 0; }
        else { tx2 = pts[j][0]; ty2 = pts[j][1]; need -= sl; }
      }
      var hdv = al0 < LAGF ? G.dir : G.next, want = Math.atan2(hdv[1], hdv[0]);
      if (G.ang === undefined || G.state !== "playing") G.ang = want;
      else {
        var da = want - G.ang;
        da = Math.atan2(Math.sin(da), Math.cos(da));         // the short way round
        G.ang = Math.abs(da) < 0.02 ? want : G.ang + da * 0.35;
      }
      var hd = [Math.cos(G.ang), Math.sin(G.ang)];
      G.vis = [tx2, ty2];
      plane(tx2 + hd[0] * 6.5, ty2 + hd[1] * 6.5, hd);      // the drawing's tail is 6.5 px behind its middle
      var msg = null, sub = null;
      if (G.state === "ready") { msg = "Chemtrail"; sub = "Arrows or WASD to fly your route. Click to take off"; }
      if (G.state === "paused") { msg = "Paused"; sub = "Click to resume"; }
      if (G.state === "over") { msg = G.why; sub = G.score + " waypoints. Click or Space to fly again"; }
      if (msg) {
        ctx.fillStyle = C.bg; ctx.globalAlpha = 0.72; ctx.fillRect(ox, oy, cols * cell, rows * cell); ctx.globalAlpha = 1;
        ctx.textAlign = "center"; ctx.fillStyle = C.text; ctx.font = F(1.35);
        ctx.fillText(msg, r.w / 2, oy + rows * cell / 2 - 10);
        ctx.fillStyle = C.muted; ctx.font = F(0.85, 600); ctx.fillText(sub, r.w / 2, oy + rows * cell / 2 + 12);
        ctx.textAlign = "left";
      }
    }
    var me = CG = { G: G, cv: cv, ex: ex, reset: reset };
    var colourTick = 0;
    // one tick: moves the game on by the real time gone since the last one. Driven by the frame callback and, as a
    // backup, a timer (the sim may call frames rarely while the mouse is still)
    var lastTick = 0;
    function tick() {
      if (CG !== me) return;
      lastTick = Date.now();
      // the clock: the sim's frame timestamp only moved while the mouse was dragging (1.5.0 test), so use our own
      var t = (window.performance && performance.now) ? performance.now() : Date.now();
      placeExit();
      // hidden (another tab, card closed): paused. Measured on screen: the sim may report a canvas's offsetWidth as 0
      var vis = cv.getBoundingClientRect();
      if (!(vis.width > 0 && vis.height > 0)) { cgPause(); cgHoldKeys(false); return; }
      fit();
      if (++colourTick % 60 === 0) colours();               // follows a theme change (7700 included)
      if (G.state === "playing") {
        G.acc += Math.min(200, t - (G.last || t)); var ms = 1000 / G.speed;
        while (G.acc >= ms && G.state === "playing") { G.acc -= ms; step(); }
        // a text field took the keyboard: pause. (Not on any loss of it: in the sim the keyboard was let go right after
        // the take-off click, which paused at once. Esc and a click outside the panel pause it directly.)
        if (keyboardOwner && keyboardOwner !== CG_OWNER) G.state = "paused";
        else if (!keyboardOwner && keysWanted === false) cgHoldKeys(true);   // ask for the keyboard again (the arrows)
      }
      G.last = t;
      present();                                           // a new picture every frame (see the canvases above)
    }
    function loop() { if (CG !== me) return; tick(); window.requestAnimationFrame(loop); }
    var backup = setInterval(function () {
      if (CG !== me) { clearInterval(backup); return; }
      if (Date.now() - lastTick > 60) tick();
    }, 40);
    cv.addEventListener("keydown", function (e) {
      if (e.key === "Escape" || e.keyCode === 27) { cgPause(); cgHoldKeys(false); e.stopPropagation(); return; }
      cgKey(cgKeyOf(e)); e.preventDefault(); e.stopPropagation();
    });
    // the click that takes off / resumes. Listened for on the notes box around the canvas too: in the sim the canvas
    // itself didn't get the click (1.5.0 test). "exit" and the window's own buttons are left alone
    function takeOff(e) {
      if (CG !== me || (e.button !== undefined && e.button !== 0)) return;
      var t = e.target;
      if (t === ex || (t && t.closest && t.closest(".cw-icon-btn, #cw-notes-state, #cn-ofp"))) return;
      try { cv.focus(); } catch (err) { /* ignore */ }
      cgHoldKeys(true);
      if (G.state !== "playing") { if (G.state === "over") reset(); G.state = "playing"; G.last = 0; G.acc = 0; }
      e.stopPropagation();
    }
    cv.addEventListener("mousedown", takeOff);
    body.addEventListener("mousedown", takeOff);
    me.off = function () { body.removeEventListener("mousedown", takeOff); };
    // in a browser, losing focus pauses. Not in the sim: it never lets a canvas keep focus (1.5.0 test: the take-off
    // click was undone at once). There, Esc, a click outside the panel or a text field taking the keyboard pause it
    if (typeof Coherent === "undefined")
      cv.addEventListener("blur", function () { setTimeout(function () { if (document.activeElement !== cv) { cgPause(); cgHoldKeys(false); } }, 0); });
    ex.addEventListener("click", cgExit);
    reset();
    window.requestAnimationFrame(loop);
  }
  function startChemtrail() {
    var cl = document.createElement("div");
    cl.id = "cg-cloud"; cl.title = ""; cl.innerHTML = CG_CLOUD;
    el("cw-notes-body").appendChild(cl);
    cl.addEventListener("click", cgStart);
    // keys that reach the page itself (the sim may not focus a canvas): for the game while it holds the keyboard
    document.addEventListener("keydown", function (e) {
      if (!CG || (keyboardOwner && keyboardOwner !== CG_OWNER) || e.target === CG.cv) return;   // a text field has the keys
      if (e.key === "Escape" || e.keyCode === 27) { cgPause(); cgHoldKeys(false); return; }
      var k = cgKeyOf(e);
      cgKey(k); e.preventDefault();
    });
    setInterval(function () { if (notesOpen || notesDetached) cgPlaceCloud(); }, 300);   // follows the notes box when it changes size
  }

  // ------------------------------------------------------------ notepad window / bigger notepad (1.5.0)
  // The notepad's detach button moves its content into a window like the radar's: moved by its title bar, resized
  // from the corner, open with the card closed, its place remembered. In the card, the notepad has a corner grip
  // that makes the card bigger (never smaller than normal); leaving the notepad brings the card back to normal.
  var notesDetached = false, notesGrow = { w: 0, h: 0 }, notesLocked = false;   // locked: while the game runs
  function setNotesDetached(on) {
    notesDetached = on;
    save("CLEARWAY_NOTES_DETACHED", on);
    (on ? el("cw-nw-body") : el("cw-notes")).insertBefore(el("cw-notes-body"), on ? null : el("cw-notes-away"));
    el("cw-notes-win").classList.toggle("hidden", !on);
    el("cw-notes-away").classList.toggle("hidden", !on);
    el("cw-notes-detach").classList.toggle("hidden", on);
    if (on) placeNotesWindow(load("CLEARWAY_NOTES_WIN", null));
    renderNotes();
    showTab(tab);
  }
  function placeNotesWindow(g) {
    var w = el("cw-notes-win"), sw = window.innerWidth, sh = window.innerHeight;
    g = g || { x: 0.3, y: 0.25, w: 0.22, h: 0.3 };
    var ww = Math.max(14 * 12.5 * scale, Math.min(sw - 8, g.w * sw)), wh = Math.max(9 * 12.5 * scale, Math.min(sh - 8, g.h * sh));
    var x = Math.max(4, Math.min(sw - ww - 4, g.x * sw)), y = Math.max(4, Math.min(sh - wh - 4, g.y * sh));
    w.style.left = x + "px"; w.style.top = y + "px"; w.style.width = ww + "px"; w.style.height = wh + "px";
  }
  function saveNotesWindow() {
    var w = el("cw-notes-win"), sw = window.innerWidth || 1, sh = window.innerHeight || 1;
    save("CLEARWAY_NOTES_WIN", { x: w.offsetLeft / sw, y: w.offsetTop / sh, w: w.offsetWidth / sw, h: w.offsetHeight / sh });
  }
  // the card's grip: only with the notepad open in the card, not while playing. It sits in the card's corner away from
  // the icon (the card grows away from it), so dragging it outwards always makes the card bigger
  function updateCardGrip() {
    var g = el("cw-card-grip"), on = notesOpen && !notesDetached && !notesLocked;
    g.classList.toggle("hidden", !on);
    if (!on) return;
    var d = cardDirection();
    g.className = (d.right ? "r" : "l") + (d.down ? " b" : " t");
  }
  function resetNotesGrow() {
    if (!notesGrow.w && !notesGrow.h) return;
    notesGrow = { w: 0, h: 0 };
    el("cw-card").style.width = "";
  }
  function startNotesWindow() {
    var w = el("cw-notes-win");
    makeWindowDraggable(el("cw-nw-head"), w, saveNotesWindow);
    makeWindowResizable(el("cw-nw-grip"), w, saveNotesWindow, [14, 9]);
    el("cw-nw-dock").addEventListener("click", function () { setNotesDetached(false); });
    el("cw-notes-back").addEventListener("click", function () { setNotesDetached(false); });
    el("cw-notes-detach").addEventListener("click", function () { setNotesDetached(true); });
    swallowWheel(w);
    // the card's grip: the extra size in em, added to the card's normal size by sizeCard
    var grip = el("cw-card-grip"), c = el("cw-card");
    grip.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      var sx = e.clientX, sy = e.clientY, cap = el("cw-capture"), d = cardDirection();
      var em = parseFloat(window.getComputedStyle(c).fontSize) || 14, g0 = { w: notesGrow.w, h: notesGrow.h };
      var baseW = c.offsetWidth / em - g0.w, baseH = c.offsetHeight / em - g0.h;
      cap.classList.add("on");
      function move(ev) {
        var dx = (ev.clientX - sx) * (d.right ? 1 : -1), dy = (ev.clientY - sy) * (d.down ? 1 : -1);
        var maxW = (window.innerWidth - 8) / em - baseW, maxH = (window.innerHeight - 8) / em - baseH;
        notesGrow = { w: Math.max(0, Math.min(maxW, g0.w + dx / em)), h: Math.max(0, Math.min(maxH, g0.h + dy / em)) };
        placeCard();
      }
      function upHandler() {
        cap.classList.remove("on");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", upHandler);
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", upHandler);
      e.preventDefault(); e.stopPropagation();
    });
    setNotesDetached(!!load("CLEARWAY_NOTES_DETACHED", false));
  }

  // ------------------------------------------------------------ clock: UTC / sim time / local
  // 4th mode, only while Clearway has your TSAT (vIFF / VDGS): a countdown to the TSAT.
  // Yellow before the start-up window (TSAT -5 min), green inside it (to 0:00, then up to +5:59: the VDGS window ends at TSAT +6), red after.
  var CLOCK_MODES = ["utc", "sim", "local", "tsat"];
  var clockMode = "utc";
  var lastTsatKey = "";
  var tsatAlertOn = false;
  // the icon alert for an open start-up window, until you open the card or click the clock (or the window ends)
  function tsatAlert() {
    var t = tsatNow();
    if (!t || paused) return false;
    var raw = (Date.now() - t.tsat_ms) / 1000;
    return raw >= -300 && raw < 360 && load("CLEARWAY_TSAT_SEEN", "") !== t.callsign + "/" + t.tsat_ms;
  }
  function tsatSeen() {
    var t = tsatNow();
    if (t) save("CLEARWAY_TSAT_SEEN", t.callsign + "/" + t.tsat_ms);
    if (tsatAlertOn && state) render();
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  // once the flight is activated (off blocks) the start-up window no longer matters: no TSAT clock, alert or ring,
  // and the clock goes back to your usual one (before, it kept counting up in red while you taxied)
  function tsatNow() { return state && reachable && state.tsat && state.tsat.tsat_ms && !state.tsat.activated ? state.tsat : null; }
  function clockModes() { return tsatNow() ? CLOCK_MODES : CLOCK_MODES.slice(0, 3); }
  // a new or changed TSAT switches the clock to it; when it's gone the clock goes back to your usual one
  function checkTsat() {
    var t = tsatNow(), key = t ? t.callsign + "/" + t.tsat_ms : "";
    if (key && key !== lastTsatKey) clockMode = "tsat";
    if (!t && clockMode === "tsat") { clockMode = load("CLEARWAY_CLOCK", "utc"); if (clockMode === "tsat") clockMode = "utc"; }
    lastTsatKey = key;
    updateClock();
  }
  // yellow: time left until the start-up window opens (TSAT -5 min); green: -5:00 to 0:00 to TSAT, then up to
  // +5:59 (the VDGS window ends at TSAT +6); red: past the window (+6:00 and up, still from the TSAT)
  function tsatText(t) {
    var raw = Math.round((Date.now() - t.tsat_ms) / 1000), s = raw;
    var cls = raw < -300 ? "wait" : raw < 360 ? "go" : "late";   // window as the VDGS shows it: TSAT -5 to TSAT +6 (e.g. 2355-0006 for 0000)
    if (raw < -300) s = raw + 300;             // before the window: count down to its opening
    var a = Math.abs(s);
    var body = a >= 3600 ? Math.floor(a / 3600) + ":" + pad2(Math.floor(a / 60) % 60) + ":" + pad2(a % 60)
      : Math.floor(a / 60) + ":" + pad2(a % 60);
    return { text: (s < 0 ? "-" : "+") + body + " TSAT", cls: cls };
  }
  // TSAT ring on the icon, once the start-up window alert is cleared and while the flight isn't activated (off
  // blocks): a yellow-green arc from 12 o'clock that retracts counterclockwise as the window (TSAT -5 to +6 min)
  // runs out, then a full electric-orange ring once the window has expired
  // Drawn on a canvas (MSFS ignores SVG dash patterns and draws SVG coarsely).
  var ringDrawn = "";
  function updateTsatRing() {
    var b = el("cw-bubble"), cv = el("cw-tring-cv"), t = tsatNow(), now = Date.now();
    var on = !tsatAlertOn && t && !t.activated && now >= t.tsat_ms - 300000;
    var late = on && now >= t.tsat_ms + 360000;
    b.classList.toggle("tsat-ring", !!on && !late);
    b.classList.toggle("tsat-late", !!late);
    if (!on) { ringDrawn = ""; return; }
    var left = late ? 1 : Math.max(0, Math.min(1, (t.tsat_ms + 360000 - now) / 660000));
    // one canvas pixel per screen pixel, like the radar: MSFS shows a canvas at its own pixel size and ignores a CSS
    // size, so a larger (supersampled) canvas came out too big. The CSS size is set to match, in px.
    var size = Math.round(b.offsetWidth || 48);        // the icon including its border
    var key = size + (late ? "L" : "") + left.toFixed(4);
    if (key === ringDrawn) return;
    ringDrawn = key;
    if (cv.width !== size) {
      cv.width = size; cv.height = size;
      cv.style.width = size + "px"; cv.style.height = size + "px";
      cv.style.left = cv.style.top = (-(size - (b.clientWidth || size)) / 2) + "px";   // over the border
    }
    var ctx = cv.getContext("2d"), c = size / 2, lw = size * 0.042, r = size * 0.475;
    ctx.clearRect(0, 0, size, size);
    ctx.lineWidth = lw;
    if (!late) {                                   // faint track under the arc
      ctx.strokeStyle = windowColor(left, 0.18);
      ctx.beginPath(); ctx.arc(c, c, r, 0, 2 * Math.PI); ctx.stroke();
    }
    if (left <= 0) return;
    // from 12 o'clock clockwise for what's left: the end retracts counterclockwise towards 12 as time runs out, and its
    // colour fades from mint green through yellow and orange to red; electric orange once the window has expired
    ctx.strokeStyle = late ? "#ff7a00" : windowColor(left);
    ctx.lineCap = late ? "butt" : "round";
    ctx.beginPath(); ctx.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * left); ctx.stroke();
  }

  function updateClock() {
    updateTsatRing();
    if (expanded) updateRadioBtn();          // the header radio icon (its amber "new text" glow ends after 4 s)
    var text, d = new Date(), extra = "", c = el("cw-clock"), t = tsatNow();
    if (clockMode === "tsat" && !t) clockMode = "utc";
    var win = fmtHm(t ? t.tsat_ms - 300000 : 0) + "-" + fmtHm(t ? t.tsat_ms + 360000 : 0) + "z";
    c.title = !t ? "" : t.suggested
      ? "Suggested start-up window " + win + " from your TOBT " + t.tobt + "z (no CDM controller online, so no TSAT)  - click for other clocks"
      : "TSAT " + t.tsat + "z (start-up window " + win + ")" +
        (t.tobt ? "  TOBT " + t.tobt : "") + (t.ttot ? "  TTOT " + t.ttot : "") + (t.ctot ? "  CTOT " + t.ctot : "") + "  - click for other clocks";
    if (clockMode === "tsat") {
      var r = tsatText(t);
      text = r.text; extra = " " + r.cls;
    } else if (clockMode === "utc") {
      text = pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds()) + "z";
    } else if (clockMode === "local") {
      // the real time now where the aircraft is: the real UTC time (PC clock) plus the time zone of the aircraft's spot.
      // The sim only gives the zone: its local time minus its UTC time, which doesn't depend on the time of day set in
      // the sim. Outside the sim: the PC's own local time
      var zone = null;
      try {
        if (typeof SimVar !== "undefined") {
          var lt = SimVar.GetSimVarValue("E:LOCAL TIME", "seconds"), zt = SimVar.GetSimVarValue("E:ZULU TIME", "seconds");
          if (typeof lt === "number" && typeof zt === "number" && !isNaN(lt) && !isNaN(zt) && (lt || zt)) {
            zone = lt - zt;
            while (zone > 14 * 3600) zone -= 86400;          // across midnight
            while (zone < -12 * 3600) zone += 86400;
            zone = Math.round(zone / 900) * 900;            // zones are whole quarter hours
          }
        }
      } catch (e) { zone = null; }
      if (zone !== null) {
        var lsec = ((Math.floor(d.getTime() / 1000) + zone) % 86400 + 86400) % 86400;
        text = pad2(Math.floor(lsec / 3600)) + ":" + pad2(Math.floor(lsec / 60) % 60) + ":" + pad2(lsec % 60) + " LT";
      } else {
        text = pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()) + " LT";
      }
    } else {
      var secs = null;
      try { if (typeof SimVar !== "undefined") secs = SimVar.GetSimVarValue("E:ZULU TIME", "seconds"); } catch (e) { secs = null; }
      if (typeof secs === "number" && !isNaN(secs)) {
        secs = Math.floor(secs) % 86400;
        text = pad2(Math.floor(secs / 3600)) + ":" + pad2(Math.floor(secs / 60) % 60) + ":" + pad2(secs % 60) + " SIM";
      } else {
        text = "--:--:-- SIM";
      }
    }
    c.textContent = text;
    c.className = "cw-clock " + clockMode + extra;
    if (state && tsatAlert() !== tsatAlertOn) render();   // the window just opened (or ended): update the icon
  }
  function fmtHm(ms) { var d = new Date(ms); return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()); }

  function setExpanded(v) {
    if (!v) { cgPause(); releaseKeyboard(); }
    expanded = v;
    el("cw-card").classList.toggle("hidden", !expanded);
    save("CLEARWAY_EXPANDED", expanded);
    if (expanded) tsatSeen();                  // opening the card counts as seeing the start-up window alert
    el("cw-bubble").classList.toggle("idle", !expanded && !(lastVp || lastCp) && !tsatAlertOn);
    el("cw-bubble").classList.toggle("q-faint", !expanded && !paused && !!(lastVp || lastCp) && !tsatAlertOn);
    if (expanded) { lastChatKey = ""; placeCard(); poll(true); }
  }

  function makeDraggable(handle, onClick) {
    var startX, startY, originX, originY, moved;
    handle.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      if (up(e.target, ".cw-icon-btn") || up(e.target, ".cw-tab") || up(e.target, ".cw-clock")) return;
      var b = el("cw-bubble");
      startX = e.clientX; startY = e.clientY;
      originX = b.offsetLeft; originY = b.offsetTop;
      moved = false;
      var cap = el("cw-capture");
      cap.classList.add("on");
      function move(ev) {
        var dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        moved = true;
        placeBubble(originX + dx, originY + dy, false);
      }
      function upHandler() {
        cap.classList.remove("on");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", upHandler);
        if (moved) placeBubble(el("cw-bubble").offsetLeft, el("cw-bubble").offsetTop, true);
        else if (onClick) onClick();
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", upHandler);
      e.preventDefault();
    });
  }

  // Text fields never take the keyboard away from MSFS: taking it (FOCUS_INPUT_FIELD) makes the sim
  // pause every aircraft input, controllers included. Instead Clearway holds the keyboard while a
  // field has the cursor (see "keyboard capture" below), so typed keys don't reach sim bindings.
  // To stop later sim key presses from landing in a forgotten text box (or a stray Enter sending
  // them), a field gives up its cursor after IDLE_BLUR_MS without typing, and on Esc, when
  // collapsing/switching tabs, and on any mouse press outside the panel (mousePressOutsideView).
  var IDLE_BLUR_MS = 15000;
  var keyboardOwner = null;   // id of the text field that currently has the cursor
  var idleTimer = null;
  function releaseKeyboard() {
    var a = document.activeElement;
    // Esc in the peek's quick reply closes the reply box (without sending)
    if (a && a.id === "cw-peek-in" && peekReplyOpen) { peekReplyOpen = false; setTimeout(function () { peekReplyOpen = true; closePeekReply(); }, 0); }
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && up(a, "#cw-root")) a.blur();
    keyboardOwner = null;
    clearTimeout(idleTimer);
  }

  // ------------------------------------------------------------ focus debug (test builds)
  // Answers: when you type in a field and then click in the cockpit, does the sim tell the panel
  // anything? Shows focus state, every DOM event type the page receives (with counts and the last
  // target), attribute changes on the panel frame, and engine (Coherent) events.
  function startFocusDebug() {
    var box = document.createElement("div");
    box.id = "cw-debug";
    el("cw-root").appendChild(box);
    var t0 = Date.now(), counts = {}, last = {}, log = [], mouse = { x: -1, y: -1, n: 0 }, lastEv = null;
    function stamp() { return ((Date.now() - t0) / 1000).toFixed(1); }
    function name(t) {
      if (!t || !t.tagName) return t === window ? "window" : t === document ? "document" : "?";
      return t.tagName.toLowerCase() + (t.id ? "#" + t.id : "");
    }
    function note(text) { log.unshift(stamp() + "  " + text); if (log.length > 14) log.pop(); }
    function seen(type, target) {
      counts[type] = (counts[type] || 0) + 1;
      last[type] = stamp() + " " + target;
    }
    var TYPES = ["mousedown", "mouseup", "click", "contextmenu", "wheel", "mouseover", "mouseout", "mouseleave",
      "mouseenter", "pointerdown", "pointerup", "pointerleave", "focus", "blur", "focusin", "focusout",
      "visibilitychange", "keydown", "keyup", "resize"];
    TYPES.forEach(function (type) {
      [window, document].forEach(function (target) {
        target.addEventListener(type, function (e) {
          if (e === lastEv) return;           // the same event, caught again on document
          lastEv = e;
          seen(type, (target === window ? "w:" : "d:") + name(e.target));
          if (type !== "mouseover" && type !== "mouseout" && type !== "keydown" && type !== "keyup") note(type + " on " + name(e.target));
        }, true);
      });
    });
    document.addEventListener("mousemove", function (e) { mouse.x = e.clientX; mouse.y = e.clientY; mouse.n++; mouse.t = name(e.target); }, true);
    // the panel frame may change classes or attributes when it gains or loses focus
    var frame = document.querySelector("ingame-ui");
    if (frame && window.MutationObserver) {
      new MutationObserver(function (list) {
        list.forEach(function (m) { note("frame " + m.attributeName + " = " + String(frame.getAttribute(m.attributeName)).slice(0, 40)); });
      }).observe(frame, { attributes: true });
      new MutationObserver(function () { note("body class = " + document.body.className.slice(0, 40)); })
        .observe(document.body, { attributes: true, attributeFilter: ["class"] });
    }
    // events dispatched by the sim's own panel scripts
    try {
      var orig = EventTarget.prototype.dispatchEvent;
      EventTarget.prototype.dispatchEvent = function (ev) {
        if (ev && ev.type && TYPES.indexOf(ev.type) < 0 && ev.type !== "input") note("dispatch " + ev.type + " on " + name(this));
        return orig.call(this, ev);
      };
    } catch (e) { note("no dispatch hook"); }
    // engine events registered from now on, plus a few guesses
    if (typeof Coherent !== "undefined" && Coherent.on) {
      var on = Coherent.on;
      Coherent.on = function (evName, cb) {
        return on.call(Coherent, evName, function () { seen("coh:" + evName, ""); return cb.apply(this, arguments); });
      };
      ["FOCUS_CHANGED", "OnFocusChanged", "SetFocus", "UNFOCUS_INPUT_FIELD", "FOCUS_INPUT_FIELD", "mousePressOutsideView",
        "OnMouseClick", "MOUSE_CLICK", "OnInteractionEvent", "ON_VIEW_FOCUS", "OnViewFocus", "OnViewBlur", "PanelFocused",
        "PanelUnfocused", "SetActive", "OnActivate", "OnDeactivate"].forEach(function (n) {
        on.call(Coherent, n, function () { seen("coh:" + n, ""); note("coherent " + n); });
      });
    }
    var lastFocus = null;
    setInterval(function () {
      var hf = document.hasFocus ? document.hasFocus() : "?";
      if (hf !== lastFocus) { note("hasFocus = " + hf); lastFocus = hf; }
      var a = document.activeElement;
      var lines = ["FOCUS DEBUG   (type in a field, then click in the cockpit)",
        "hasFocus " + hf + "   active " + name(a) + "   visibility " + document.visibilityState,
        "mouse " + Math.round(mouse.x) + "," + Math.round(mouse.y) + "  moves " + mouse.n + "  over " + (mouse.t || "-"),
        "---- event counts (last time, target)"];
      Object.keys(counts).sort().forEach(function (k) { lines.push(k + " x" + counts[k] + "   " + last[k]); });
      lines.push("---- log (newest first)");
      box.textContent = lines.concat(log).join("\n");
    }, 250);
    note("debug started");
  }

  function armIdleBlur() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(releaseKeyboard, IDLE_BLUR_MS);
  }

  // ------------------------------------------------------------ keyboard capture
  // MSFS runs its own key bindings before the panel sees a key, and ChasePlane reads the keyboard
  // by itself, so typed letters also fired sim commands / camera shortcuts. While a field has the
  // cursor, the panel asks Clearway (on this PC) to hold the keyboard: Clearway keeps the keys away
  // from every program and sends them here, and the panel types them into the field itself.
  // Without a Clearway that supports it, the sim delivers keys to the field as before.
  var inputEnter = {};          // field id -> its Enter action
  var keysWanted = false, keysOn = false, keysLoop = false, keysSeq = 0, keysOffTimer = null;
  var selAnchor = null;         // fixed end of a Shift+arrow selection

  function wantKeys(on) {
    keysWanted = on;
    request("POST", "/api/keys/capture", { on: on }, function (ok, data) {
      if (keysWanted !== on) return;            // superseded by a newer request
      keysOn = ok && !!data.active;
      if (keysOn) { keysSeq = data.seq || 0; keysPoll(); }
    });
  }

  function keysPoll() {
    if (keysLoop) return;
    keysLoop = true;
    (function next() {
      if (!keysOn) { keysLoop = false; return; }
      request("GET", "/api/keys?since=" + keysSeq, null, function (ok, data) {
        if (!ok) { keysOn = false; keysLoop = false; return; }
        var evs = data.events || [];
        keysSeq = data.seq || 0;
        for (var i = 0; i < evs.length; i++) applyKey(evs[i]);
        if (!keyboardOwner) { keysLoop = false; if (keysOn) { keysOn = false; wantKeys(false); } return; }
        if (!data.active) {                     // Clearway let go (it lost track of the panel): ask again
          keysOn = false; keysLoop = false;
          if (keysWanted) wantKeys(true);
          return;
        }
        next();
      });
    })();
  }

  function fireInput(input) {
    var ev;
    try { ev = new Event("input", { bubbles: true }); }
    catch (e) { ev = document.createEvent("Event"); ev.initEvent("input", true, false); }
    input.dispatchEvent(ev);
  }
  function edit(input, from, to, text) {
    var v = input.value;
    input.value = v.slice(0, from) + text + v.slice(to);
    var c = from + text.length;
    input.setSelectionRange(c, c);
    selAnchor = null;
    fireInput(input);
  }
  function lineStart(v, p) { return v.lastIndexOf("\n", p - 1) + 1; }
  function lineEnd(v, p) { var n = v.indexOf("\n", p); return n < 0 ? v.length : n; }
  function wordLeft(v, p) {
    while (p > 0 && /\s/.test(v.charAt(p - 1))) p--;
    while (p > 0 && !/\s/.test(v.charAt(p - 1))) p--;
    return p;
  }
  function wordRight(v, p) {
    while (p < v.length && !/\s/.test(v.charAt(p))) p++;
    while (p < v.length && /\s/.test(v.charAt(p))) p++;
    return p;
  }

  // Tab / Shift+Tab: the next / previous text box on screen in the card (wraps around)
  function focusNext(from, back) {
    var all = document.querySelectorAll("#cw-card input, #cw-card textarea"), list = [], i;
    for (i = 0; i < all.length; i++) {
      var f = all[i];
      if (f.type !== "checkbox" && !f.disabled && (f.offsetWidth || f.offsetHeight) && !up(f, ".hidden")) list.push(f);
    }
    if (!list.length) return;
    var at = list.indexOf(from);
    var next = list[((at < 0 ? -1 : at) + (back ? -1 : 1) + list.length) % list.length];
    if (next && next !== from) { next.focus(); try { next.setSelectionRange(0, next.value.length); } catch (e) { /* ignore */ } }
  }

  function applyKey(ev) {
    if (ev.t === "key" && ev.k === "Escape") { cgPause(); releaseKeyboard(); return; }
    if (keyboardOwner === CG_OWNER) { cgKey(ev.t === "text" ? ev.s : ev.k); return; }   // Chemtrail has the keyboard
    if (ev.t === "key" && ev.k === "Tab") { var cur = keyboardOwner ? el(keyboardOwner) : null; if (cur) focusNext(cur, ev.shift); return; }
    var input = keyboardOwner ? el(keyboardOwner) : null;
    if (!input || document.activeElement !== input) return;
    armIdleBlur();
    var v = input.value, s = input.selectionStart, e = input.selectionEnd;
    var multi = input.tagName === "TEXTAREA";
    if (ev.t === "text") { edit(input, s, e, multi ? ev.s : ev.s.replace(/[\r\n\t]+/g, " ")); return; }
    var k = ev.k;
    if (k === "Backspace") {
      if (s === e) { if (!s) return; s = ev.ctrl ? wordLeft(v, s) : s - 1; }
      return edit(input, s, e, "");
    }
    if (k === "Delete") {
      if (s === e) { if (e >= v.length) return; e = ev.ctrl ? wordRight(v, e) : e + 1; }
      return edit(input, s, e, "");
    }
    if (k === "Enter") {
      var go = inputEnter[input.id];
      if (go && !ev.shift) return go();
      if (multi) edit(input, s, e, "\n");
      return;
    }
    if (k === "SelectAll") { selAnchor = null; input.setSelectionRange(0, v.length); return; }
    // caret moves (Shift extends the selection)
    var focus = s;
    if (ev.shift && selAnchor !== null) focus = (selAnchor === s) ? e : s;
    else if (ev.shift) { selAnchor = s; focus = e; }
    var p = focus;
    if (k === "ArrowLeft") p = (!ev.shift && s !== e) ? s : (ev.ctrl ? wordLeft(v, focus) : Math.max(0, focus - 1));
    else if (k === "ArrowRight") p = (!ev.shift && s !== e) ? e : (ev.ctrl ? wordRight(v, focus) : Math.min(v.length, focus + 1));
    else if (k === "Home") p = (ev.ctrl || !multi) ? 0 : lineStart(v, focus);
    else if (k === "End") p = (ev.ctrl || !multi) ? v.length : lineEnd(v, focus);
    else if ((k === "ArrowUp" || k === "ArrowDown") && multi) {
      var ls = lineStart(v, focus), col = focus - ls;
      if (k === "ArrowUp") p = ls === 0 ? 0 : Math.min(lineStart(v, ls - 1) + col, ls - 1);
      else { var le = lineEnd(v, focus); p = le >= v.length ? v.length : Math.min(le + 1 + col, lineEnd(v, le + 1)); }
    } else return;                              // Tab, Page Up/Down, Insert: nothing to do
    if (ev.shift) input.setSelectionRange(Math.min(selAnchor, p), Math.max(selAnchor, p));
    else { selAnchor = null; input.setSelectionRange(p, p); }
  }

  function wireInput(input, onEnter) {
    if (onEnter) inputEnter[input.id] = onEnter;
    input.addEventListener("focus", function () {
      keyboardOwner = input.id;
      selAnchor = null;
      armIdleBlur();
      clearTimeout(keysOffTimer);
      if (!keysWanted) wantKeys(true);
    });
    input.addEventListener("blur", function () {
      if (keyboardOwner === input.id) { keyboardOwner = null; clearTimeout(idleTimer); }
      clearTimeout(keysOffTimer);
      // moving straight to another field keeps the keyboard
      keysOffTimer = setTimeout(function () { if (!keyboardOwner && keysWanted) wantKeys(false); }, 120);
    });
    input.addEventListener("input", armIdleBlur);
    var lastEnter = 0;
    function onKey(e) {
      if (e.key === "Escape" || e.keyCode === 27) { releaseKeyboard(); e.stopPropagation(); return; }
      if (e.key === "Tab" || e.keyCode === 9) {
        e.preventDefault(); e.stopPropagation();
        if (e.type === "keydown") focusNext(input, e.shiftKey);
        return;
      }
      armIdleBlur();
      var isEnter = e.key === "Enter" || e.keyCode === 13 || e.which === 13;
      if (isEnter && !e.shiftKey && onEnter) {
        e.preventDefault();
        var now = Date.now();
        if (now - lastEnter > 400) { lastEnter = now; onEnter(); }
      }
      e.stopPropagation();
    }
    input.addEventListener("keydown", onKey);
    input.addEventListener("keypress", onKey);
    input.addEventListener("keyup", onKey);
    if (input.tagName === "TEXTAREA" && input.classList.contains("cw-grow")) {
      input.addEventListener("input", function () { autoGrow(input); });
    }
  }

  // ------------------------------------------------------------ start
  function start() {
    if (started) return;
    started = true;

    // MSFS 2024 adds classes that hide custom toolbar panels; remove them.
    var frame = document.querySelector("ingame-ui");
    if (frame && frame.classList) { frame.classList.remove("hide"); frame.classList.remove("panelInvisible"); }

    openedChats = load("CLEARWAY_CHATS", []);
    closedChats = load("CLEARWAY_CLOSED", {});
    applyScale();
    window.addEventListener("resize", applyScale);

    makeDraggable(el("cw-bubble"), function () { hidePeek(); setExpanded(!expanded); });
    el("cw-bubble").addEventListener("mousedown", function (e) {
      if (e.button === 2) { e.preventDefault(); e.stopPropagation(); peek(); }
    });
    el("cw-bubble").addEventListener("contextmenu", function (e) { e.preventDefault(); peek(); });
    // MSFS 2024 sends the panel only the release of a right click (no mousedown, no contextmenu): peek on it too.
    // peek() ignores a second call within 350 ms, so a sim that sends both still peeks once.
    el("cw-bubble").addEventListener("mouseup", function (e) { if (e.button === 2) { e.preventDefault(); peek(); } });
    el("cw-peek").addEventListener("click", onPeekClick);
    // right click on the peek closes it and marks its message read (also one the peek brought back as unread)
    // (mousedown, contextmenu, or only the release in MSFS 2024)
    var closePeekRight = function (e) {
      if (e.type !== "contextmenu" && e.button !== 2) return;
      e.preventDefault(); e.stopPropagation();
      var m = peekMsg;
      if (m && !m.acked && ackPending[m.id] === undefined) {
        ackPending[m.id] = 1;
        m.acked = true;
        act("ack", { id: m.id }, null, null, function () { delete ackPending[m.id]; });
      }
      hidePeek();
    };
    el("cw-peek").addEventListener("mousedown", closePeekRight);
    el("cw-peek").addEventListener("mouseup", closePeekRight);
    el("cw-peek").addEventListener("contextmenu", closePeekRight);
    el("cw-peek").addEventListener("mouseover", function () { peekHover = true; clearTimeout(peekTimer); });
    el("cw-peek").addEventListener("mouseout", function (e) {
      if (e.relatedTarget && el("cw-peek").contains(e.relatedTarget)) return;   // moving between its children
      peekHover = false;
      if (peekUrgent || peekReplyOpen) return;                       // these stay until clicked / sent
      armPeekClose(3000);
    });
    makeDraggable(el("cw-head"), null);
    placementLock = load("CLEARWAY_LOCK", null);
    updateLockButton();
    el("cw-lock").addEventListener("click", toggleLock);
    paused = !!load("CLEARWAY_PAUSED", false);
    el("cw-pause").classList.toggle("paused", paused);
    el("cw-pause").title = paused ? "Notifications muted: click to turn them back on" : "Mute panel notifications";
    el("cw-pause").addEventListener("click", function () { setPaused(!paused); });
    clockMode = load("CLEARWAY_CLOCK", "utc");
    if (CLOCK_MODES.indexOf(clockMode) < 0 || clockMode === "tsat") clockMode = "utc";
    el("cw-clock").addEventListener("click", function () {
      var modes = clockModes();
      clockMode = modes[(modes.indexOf(clockMode) + 1) % modes.length];
      if (clockMode !== "tsat") save("CLEARWAY_CLOCK", clockMode);   // the TSAT clock comes back by itself
      tsatSeen();
      updateClock();
    });
    updateClock();
    setInterval(updateClock, 1000);
    setInterval(fadeSysLines, 1000);
    setInterval(watchLayout, 150);
    // the panel losing focus (a click in the cockpit, another window) gives the keyboard back;
    // moving the mouse alone does not
    window.addEventListener("blur", releaseKeyboard);
    if (FOCUS_DEBUG) startFocusDebug();
    document.addEventListener("visibilitychange", function () { if (document.hidden) { cgPause(); releaseKeyboard(); } });
    var uiFrame = document.querySelector("ingame-ui");
    if (uiFrame) uiFrame.addEventListener("panelInactive", function () { cgPause(); releaseKeyboard(); });
    // A click in the cockpit (or anywhere outside the panel) never reaches this page, but the engine
    // sends "mousePressOutsideView" for it (found with the focus debug build). The click itself still
    // goes to the sim. Guard: ignore it right after a mouse press on the panel itself.
    var lastPanelPress = 0;
    document.addEventListener("mousedown", function () { lastPanelPress = Date.now(); }, true);
    if (typeof Coherent !== "undefined" && Coherent.on) {
      try {
        Coherent.on("mousePressOutsideView", function () {
          setTimeout(function () {
            if (Date.now() - lastPanelPress > 250) { cgPause(); releaseKeyboard(); }   // (Chemtrail pauses too)
          }, 30);
        });
      } catch (e) { /* older sim: keep the idle / Esc behaviour */ }
    }
    el("cw-min").addEventListener("click", function () { setExpanded(false); });
    el("cw-head").addEventListener("click", function (e) {
      var t = up(e.target, ".cw-tab");
      if (t) { notesOpen = false; showTab(attr(t, "data-tab")); }
    });
    el("cw-notes-btn").addEventListener("click", function () { notesOpen = !notesOpen; showTab(tab); });

    // vPilot controls
    el("cw-vp-conn").addEventListener("click", function () {
      var vp = (state && state.vpilot) || {};
      if (!vp.active) return hint("vPilot not opened / plugin not found: start vPilot (with the Clearway plugin installed).", true, "cw-vp-hint");
      if (vp.connected) return act("vp/disconnect", {}, "Disconnecting...", "cw-vp-hint");
      el("cw-vp-connect").classList.toggle("hidden");
      vpSelcalCheck(0);
      // first time the form opens: fetch the SimBrief plan if there's none yet
      var sc = state && state.selcal;
      if (!el("cw-vp-connect").classList.contains("hidden") && sc && sc.simbrief_user && !sc.simbrief) vpSimbriefRefresh();
      placeCard();
    });
    el("cw-cw-run").addEventListener("click", startClearway);
    // vPilot power button: starts vPilot when it's closed; while it's open, asks first, then closes it like its X
    var closeAskTimer = null;
    function askCloseVpilot(show) {
      clearTimeout(closeAskTimer);
      var vp = (state && state.vpilot) || {};
      el("cw-vp-close-text").textContent = vp.connected ? "Close vPilot? You'll be disconnected from VATSIM." : "Close vPilot?";
      el("cw-vp-close-ask").classList.toggle("hidden", !show);
      if (show) closeAskTimer = setTimeout(function () { askCloseVpilot(false); placeCard(); }, 8000);   // not answered: gone
      placeCard();
    }
    el("cw-vp-run").addEventListener("click", function () {
      var vp = (state && state.vpilot) || {};
      if (vpClosingUntil) return hint("vPilot is closing...", false, "cw-vp-hint");
      if (vp.running) return askCloseVpilot(el("cw-vp-close-ask").classList.contains("hidden"));
      if (vp.starting) return hint("vPilot is starting...", false, "cw-vp-hint");
      act("vp/launch", {}, "Starting vPilot in the background...", "cw-vp-hint");
    });
    el("cw-vp-close-yes").addEventListener("click", function () {
      askCloseVpilot(false);
      vpClosingUntil = Date.now() + 20000;              // yellow until vPilot's process is gone (20 s at most)
      renderVpilot();
      act("vp/close", {}, "Closing vPilot...", "cw-vp-hint");
    });
    el("cw-vp-close-no").addEventListener("click", function () { askCloseVpilot(false); });
    el("cw-vp-sb-ref").addEventListener("click", vpSimbriefRefresh);
    el("cn-ofp-rl").addEventListener("click", vpSimbriefRefresh);      // the notepad's flight block: same SimBrief fetch
    // dice: a random SELCAL nobody on VATSIM is using (the SELCAL tab's generator), put in the field as if typed
    el("cw-vp-sc-rnd").addEventListener("click", function () {
      var b = el("cw-vp-sc-rnd");
      if (b.classList.contains("spinning")) return;
      b.classList.add("spinning");
      var cs = el("cw-vp-cs-in").value.trim() || myCallsign();
      act("selcal/generate", { callsign: cs }, null, null, function (ok, data) {
        b.classList.remove("spinning");
        var code = ok && data && data.current && data.current.std;
        if (!code) return hint((data && data.error) || "Couldn't make a SELCAL.", true, "cw-vp-hint");
        var i = el("cw-vp-selcal-in");
        i.value = fmtSelcal(code);
        i.removeAttribute("data-auto");                 // yours now: the flight plan's SELCAL won't replace it
        vpSelcalCheck(0);                               // shows "avail." next to it
      });
    });
    el("cw-vp-sb").addEventListener("click", function () {   // click the SimBrief callsign to use it
      var ofp = state && state.selcal && state.selcal.simbrief;
      if (!ofp || !ofp.callsign) return;
      el("cw-vp-cs-in").value = ofp.callsign;
      renderVpSimbrief();
      vpSelcalCheck(0);
    });
    el("cw-vp-cs-in").addEventListener("input", renderVpSimbrief);
    el("cw-vp-selcal-in").addEventListener("input", function () {
      var i = el("cw-vp-selcal-in"), f = fmtSelcal(i.value);
      if (f !== i.value) { i.value = f; try { i.setSelectionRange(f.length, f.length); } catch (e) { /* ignore */ } }
      vpSelcalCheck();
    });
    el("cw-vp-connect-go").addEventListener("click", function () {
      act("vp/connect", { callsign: el("cw-vp-cs-in").value, type_code: el("cw-vp-type-in").value, selcal: el("cw-vp-selcal-in").value,
        observer: !!observerTick }, observerTick ? "Connecting as observer..." : "Connecting...", "cw-vp-hint");
    });
    el("cw-vp-obs").addEventListener("click", function () { setObserverTick(!observerTick); });
    // the aircraft's transponder in the sim is set from renderVpilot (Clearway counts each request), see simTransponder
    el("cw-vp-sby").addEventListener("click", function () { act("vp/modec", { on: false }, "Standby", "cw-vp-hint"); });
    el("cw-vp-c").addEventListener("click", function () { act("vp/modec", { on: true }, "Mode C", "cw-vp-hint"); });
    el("cw-vp-id").addEventListener("click", function () {
      act("vp/ident", {}, "Ident", "cw-vp-hint", function (ok) {
        if (!ok) return;
        el("cw-vp-id").classList.add("on");
        setTimeout(function () { el("cw-vp-id").classList.remove("on"); }, 1500);
      });
    });
    el("cw-vp-chips").addEventListener("click", function (e) {
      var t = e.target;
      var x = pick(t, "data-closechat");
      if (x) return closeChat(x);
      var f = pick(t, "data-atcf");
      if (f) { atcFilter = f; el("cw-vp-atc").scrollTop = 0; renderVpilot(); return placeCard(); }
      var chip = up(t, ".cw-chip-tab");
      if (!chip) return;
      if (attr(chip, "data-atc-toggle")) { atcOpen = !atcOpen; lastChatKey = ""; renderVpilot(); return placeCard(); }
      activeChat = attr(chip, "data-chat"); atcOpen = false; lastChatKey = "";
      renderVpilot();
      placeCard();
    });
    el("cw-vp-atc").addEventListener("click", function (e) {
      var c = pick(e.target, "data-chatwith");
      if (c) return openChat(c);
      var tune = pick(e.target, "data-tune");
      if (tune) return tuneCom(tune, pick(e.target, "data-f"));
      var f = pick(e.target, "data-atcf");
      if (f) { atcFilter = f; renderVpilot(); return placeCard(); }
      var row = pick(e.target, "data-atc");
      if (row) toggleAtc(row);
    });
    el("cw-vp-send").addEventListener("click", sendVp);
    wireInput(el("cw-vp-input"), sendVp);
    el("cw-vp-input").addEventListener("input", function () { autoGrow(el("cw-vp-input")); });
    autoGrow(el("cw-vp-input"));   // start at one line
    ["cw-vp-cs-in", "cw-vp-type-in", "cw-vp-selcal-in"].forEach(function (id) { wireInput(el(id), null); });

    // CPDLC controls
    el("cw-clear").addEventListener("click", function () { act("clear", {}, null); });
    el("cw-hop").addEventListener("click", function () {
      hopOpen = !hopOpen;
      renderHoppie(); placeCard();
      if (hopOpen) el("cw-hop-in").focus(); else releaseKeyboard();
    });
    el("cw-hop-go").addEventListener("click", saveHoppie);
    wireInput(el("cw-hop-in"), saveHoppie);
    // (1.5.0) the Request button in the bar opens the request view (x or the button again goes back to the messages)
    el("rq-open").addEventListener("click", function () { setReqOpen(!reqOpen); });
    el("rq-x").addEventListener("click", function () { setReqOpen(false); });
    el("cw-req-kind").addEventListener("click", function (e) { var v = attr(e.target, "data-v"); if (v) setReqKind(v); });
    el("cw-fields").addEventListener("input", function (e) {
      var k = attr(e.target, "data-k");
      if (k) (formVals[reqKind] || (formVals[reqKind] = {}))[k] = e.target.value;
    });
    el("cw-wx-kind").addEventListener("click", function (e) {
      var v = attr(e.target, "data-v");
      if (!v) return;
      wxKind = v;
      var btns = el("cw-wx-kind").children;
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("on", btns[i] === e.target);
    });
    el("cw-send").addEventListener("click", send);
    el("cw-list").addEventListener("click", function (e) {
      var t = e.target, H = "cw-hint";
      var r = pick(t, "data-reply");
      if (r) return act("reply", { id: +pick(t, "data-id"), text: r }, r + " sent", H);
      var a = pick(t, "data-ack");
      if (a) return act("ack", { id: +a }, null);
      var d = pick(t, "data-del");
      if (d) return act("delete", { id: +d }, null);
      var fo = pick(t, "data-fold");
      if (fo) { var fm = findMsg(+fo); return act("collapse", { id: +fo, collapsed: !(fm && fm.collapsed) }, null); }
      if (pick(t, "data-trash-toggle")) { trashOpen = !trashOpen; renderList(); return placeCard(); }
      var rs = pick(t, "data-restore");
      if (rs) return act("restore", { id: +rs }, null);
      if (pick(t, "data-restore-all")) return act("restore", {}, null);
      var folded = up(t, ".cw-msg.collapsed");
      if (folded) return act("collapse", { id: +attr(folded, "data-msg"), collapsed: false }, null);
      var card = up(t, ".cw-msg.unread");
      if (card) { var m = findMsg(+attr(card, "data-msg")); if (m && !m.options.length) act("ack", { id: m.id }, null); }
    });

    // notepad
    var ta = el("cw-notes-text");
    wireInput(ta, null);
    ta.addEventListener("input", function () {
      notesDirty = true;
      el("cw-notes-state").textContent = "Saving...";
      clearTimeout(notesTimer);
      notesTimer = setTimeout(function () {
        act("notes", { text: ta.value }, null, null, function (ok) {
          notesDirty = !ok;
          el("cw-notes-state").textContent = ok ? "Saved" : "Not saved (is Clearway running?)";
        });
      }, 700);
    });

    wireSelcal();

    setReqOpen(!!load("CLEARWAY_REQ_OPEN", false));
    setReqKind("logon");
    // ?open=vpilot|cpdlc opens the card on that tab (used to take documentation screenshots in a browser)
    var openParam = /[?&]open=(vpilot|cpdlc|selcal|radar)/.exec(window.location.search || "");
    startRadar();
    startNotesWindow();
    startChemtrail();
    showTab(openParam ? openParam[1] : load("CLEARWAY_TAB", "vpilot"));
    setExpanded(openParam ? true : load("CLEARWAY_EXPANDED", false));
    // ?atc=CALLSIGN opens Nearby ATC with that controller expanded (documentation screenshots)
    var atcParam = /[?&]atc=([A-Z0-9_]+)/i.exec(window.location.search || "");
    if (atcParam) { atcOpen = true; setTimeout(function () { toggleAtc(atcParam[1].toUpperCase()); }, 600); }

    setupScrollbars();
    setupWheel();
    introUntil = Date.now() + 10000;
    setTimeout(render, 10100);   // back to the faint icon after the first 10 s
    render();
    poll(true);
    setInterval(function () { poll(false); }, POLL_MS);
    setInterval(sendPosition, POSITION_MS);
    setInterval(readCom, COM_MS);
    readCom();
    // hover the frequency tab, or the radio icon in the header (any tab), to see both radios
    el("cw-vp-chips").addEventListener("mouseover", function (e) {
      var chip = up(e.target, '.cw-chip-tab[data-chat="FREQ"]');
      if (chip) showComPop(chip);
    });
    el("cw-vp-chips").addEventListener("mouseout", function (e) {
      if (!up(e.relatedTarget, '.cw-chip-tab[data-chat="FREQ"]')) el("cw-com-pop").classList.add("hidden");
    });
    el("cw-radio-btn").addEventListener("mouseover", function () { showComPop(el("cw-radio-btn")); });
    el("cw-radio-btn").addEventListener("mouseout", function (e) {
      if (!up(e.relatedTarget, "#cw-radio-btn")) el("cw-com-pop").classList.add("hidden");
    });
  }

  // Register as a toolbar panel inside the sim; plain start in a normal browser.
  if (typeof TemplateElement !== "undefined" && window.customElements) {
    class ClearwayPanel extends TemplateElement {
      connectedCallback() {
        super.connectedCallback();
        start();
      }
    }
    window.customElements.define("ingamepanel-clearway", ClearwayPanel);
    if (typeof checkAutoload === "function") checkAutoload();
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
