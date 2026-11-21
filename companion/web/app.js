/* Clearway web app: phone + desktop UI for the local companion. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const REASONS = [
    ["", "No reason"],
    ["DUE TO WEATHER", "Due to weather"],
    ["DUE TO AIRCRAFT PERFORMANCE", "Due to performance"],
    ["DUE TO TURBULENCE", "Due to turbulence"],
  ];

  // ---------- pairing key (from ?k= in the QR link) ----------
  let key = "";
  try { key = localStorage.getItem("clearway.key") || ""; } catch (e) {}
  const params = new URLSearchParams(location.search);
  // The key stays in the address on purpose: an iPhone home-screen app keeps its own
  // storage, so "Add to Home Screen" must save the link including ?k=.
  if (params.get("k")) {
    key = params.get("k");
    try { localStorage.setItem("clearway.key", key); } catch (e) {}
  } else if (key && !["localhost", "127.0.0.1"].includes(location.hostname)) {
    history.replaceState(null, "", `${location.pathname}?k=${encodeURIComponent(key)}${location.hash}`);
  }

  // ---------- the PC's name instead of its IP ----------
  // The QR code holds the PC's IP, which can change from one day to the next (new DHCP lease, random Wi-Fi
  // hardware address), and a home-screen app saved with the old IP then can't connect. When this phone can
  // reach the same Clearway by the PC's name (http://<pc-name>.local), move there: that address stays valid.
  // Phones that can't resolve .local names stay on the IP. Tried once per page load, and not again for 6 h
  // after a failure.
  const movedHere = params.get("moved") === "1";
  if (movedHere && key) history.replaceState(null, "", `${location.pathname}?k=${encodeURIComponent(key)}${location.hash}`);
  if (movedHere) setTimeout(() => toast("Now using your PC's name: add this page to your home screen again, it keeps working when the PC's address changes.", false, 8000), 900);
  let nameTried = false;
  async function tryNameAddress(nameUrl) {
    if (nameTried || !nameUrl || !key || !/^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname)) return;
    nameTried = true;
    try { if (Date.now() - Number(localStorage.getItem("clearway.nameFail") || 0) < 6 * 3600e3) return; } catch (e) {}
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 3000);
    try {
      const r = await fetch(`${nameUrl}/api/hello?k=${encodeURIComponent(key)}`, { signal: ctl.signal, cache: "no-store" });
      const d = await r.json();
      if (d.app === "clearway" && d.paired) {
        location.replace(`${nameUrl}/?k=${encodeURIComponent(key)}&moved=1${location.hash}`);
        return;
      }
    } catch (e) { /* this phone can't resolve the name: keep the IP */ }
    finally { clearTimeout(timer); }
    try { localStorage.setItem("clearway.nameFail", String(Date.now())); } catch (e) {}
  }

  const VP = new Set(["pm", "radio", "broadcast", "selcal", "vinfo", "vsys"]);   // vPilot tab
  const KIND_LABEL = { cpdlc: "CPDLC", telex: "Telex", info: "Info", pm: "Message", radio: "Freq", broadcast: "Broadcast", selcal: "SELCAL" };
  let state = null;
  let version = 0;
  let firstLoad = true;
  let knownIds = new Set();
  let settingsDirty = false;

  // ---------- API ----------
  async function api(path, body) {
    const res = await fetch("/api/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Clearway-Key": key },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { $("pairBanner").hidden = false; throw new Error("This device isn't paired."); }
    if (!res.ok || data.ok === false) throw new Error(data.error || "Request failed");
    poll(true);
    return data;
  }

  async function act(path, body, okText) {
    try {
      await api(path, body);
      if (okText) toast(okText);
      return true;
    } catch (e) {
      toast(e.message, true);
      return false;
    }
  }

  // When Clearway closes, Windows' firewall usually drops the phone's requests silently instead of refusing them,
  // so a request would hang for a minute or more: give up after 5 s and show "not running"
  let polling = false, pollStarted = 0;
  async function poll(force) {
    if (polling && Date.now() - pollStarted < 6000) return;      // one request at a time
    polling = true;
    pollStarted = Date.now();
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 5000) : null;
    try {
      const res = await fetch(`/api/state?since=${force ? 0 : version}`,
        { headers: { "X-Clearway-Key": key }, cache: "no-store", signal: ctl ? ctl.signal : undefined });
      if (res.status === 401) { $("pairBanner").hidden = false; return; }
      $("pairBanner").hidden = true;
      const data = await res.json();
      if (data.unchanged) return;
      version = data.version;
      state = data;
      render();
      tryNameAddress(data.name_url);
    } catch (e) {
      setDot("error");
      $("sub").textContent = "Clearway not running on the PC";
      version = 0;                        // full state again when it's back
    } finally {
      clearTimeout(timer);
      polling = false;
    }
  }

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const utc = (ms) => { const d = new Date(ms); return String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0") + "z"; };
  // Hoppie marks variable fields with @…@; show them as soft highlights.
  const fmt = (t) => esc(t).replace(/@([^@\n]*)@/g, (_, v) => v.trim() ? `<span class="var">${v}</span>` : "").replace(/@/g, "\n");

  function toast(text, err, ms) {
    const t = $("toast");
    t.textContent = text;
    t.className = "toast" + (err ? " err" : "");
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), ms || 2800);
  }
  function setDot(s) { $("statusDot").className = "dot " + s; }

  // ---------- rendering ----------
  function render() {
    const s = state;
    setDot(s.status === "online" && s.error ? "connecting" : s.status);
    const route = s.flight && s.flight.departure ? ` · ${s.flight.departure}→${s.flight.arrival}` : "";
    $("sub").textContent = s.status === "online" ? s.callsign + route : s.status === "connecting" ? "Connecting…" : "Not connected";

    const pill = $("unitPill");
    if (s.current_unit) { pill.hidden = false; pill.className = "pill"; pill.textContent = s.current_unit; }
    else if (s.pending_logon) { pill.hidden = false; pill.className = "pill pending"; pill.textContent = s.pending_logon + "…"; }
    else pill.hidden = true;

    $("badge").hidden = !s.unacked_cpdlc;
    $("badge").textContent = s.unacked_cpdlc;
    $("vpBadge").hidden = !s.unacked_vpilot;
    $("vpBadge").textContent = s.unacked_vpilot;
    document.title = s.unacked ? `(${s.unacked}) Clearway` : "Clearway";

    renderMessages();
    renderRequests();
    renderSettings();
    hooks.forEach((h) => { try { h(s, firstLoad); } catch (e) { console.error(e); } });
    firstLoad = false;
  }

  function renderMessages() {
    const list = $("messageList");
    const msgs = state.messages.filter((m) => !VP.has(m.kind)).slice().reverse();
    $("emptyState").hidden = msgs.length > 0;
    $("emptyHint").textContent = state.status === "online"
      ? (state.current_unit ? `Logged on to ${state.current_unit}. Messages will appear here.` : "Connected. Log on to an ATC station from Requests.")
      : "Connect in Settings, then log on to an ATC station from Requests.";

    list.innerHTML = msgs.map((m) => {
      if (m.dir === "sys") return `<div class="sys">${esc(m.text)} · ${utc(m.ts)} <button class="del" data-del="${m.id}" aria-label="Delete">×</button></div>`;
      const unread = m.dir === "in" && !m.acked;
      const label = m.tag || KIND_LABEL[m.kind] || "Info";
      const arrow = m.dir === "out" ? "To" : "From";
      let foot = "";
      if (m.options.length || (m.dir === "in" && m.status !== "closed" && ["cpdlc", "telex", "pm", "radio"].includes(m.kind))) {
        // required answers, or an optional ROGER for ATC text that needs no answer
        const answers = m.options.length ? m.options : (m.quick || []);
        foot += answers.map((o) => `<button class="reply ${o}" data-reply="${o}" data-id="${m.id}">${o}</button>`).join("");
        if (m.kind === "cpdlc" && (m.status === "open" || m.status === "standby")) foot += `<button class="reply" data-free="${m.id}">Free text</button>`;
        if (["telex", "pm", "radio"].includes(m.kind)) foot += `<button class="reply" data-free="${m.id}">Reply</button>`;
      }
      let st = "";
      if (m.dir === "in" && m.reply) st = `Answered <b>${esc(m.reply)}</b>`;
      if (m.dir === "in" && m.status === "standby") st = `<b>STANDBY</b> sent, answer when ready`;
      if (m.dir === "out" && m.status === "awaiting") st = "Awaiting reply…";
      if (m.dir === "out" && m.status === "answered") st = `ATC replied <b>${esc(m.reply.replace(/@/g, ""))}</b>`;
      if (m.dir === "out" && m.status === "failed") st = `<span style="color:var(--rose)">Not delivered${m.error ? ": " + esc(m.error) : ""}</span>`;
      if (m.dir === "out" && m.status === "sending") st = "Sending through vPilot…";
      if (m.kind === "radio" && m.freq) st = (st ? st + " · " : "") + `on ${esc(m.freq)}`;
      return `<article class="msg ${m.dir} ${unread ? "unread" : ""} ${m.collapsed ? "collapsed" : ""}" id="m${m.id}" data-msg="${m.id}">
        <div class="msg-head"><span class="chip ${m.kind} tag-${label}">${label}</span><span>${arrow}</span><span class="msg-station">${esc(m.station)}</span><span class="msg-time">${utc(m.ts)}</span>${unread && !m.options.length ? `<button class="tick" data-ack="${m.id}" aria-label="Mark as read"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>` : ""}<button class="fold" data-fold="${m.id}" aria-label="${m.collapsed ? "Expand" : "Collapse"}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg></button><button class="del" data-del="${m.id}" aria-label="Delete">×</button></div>
        <div class="msg-text">${fmt(m.text)}</div>
        ${st || foot ? `<div class="msg-foot">${st ? `<span class="state">${st}</span>` : ""}${foot}</div>` : ""}
      </article>`;
    }).join("");
    renderTrash();

    // flash newly arrived inbound messages
    const ids = new Set(state.messages.map((m) => m.id));
    if (!firstLoad) {
      state.messages.filter((m) => m.dir === "in" && !knownIds.has(m.id)).forEach((m) => {
        const el = $("m" + m.id); if (el) el.classList.add("flash");
      });
    }
    knownIds = ids;

    if (firstLoad && location.hash.startsWith("#m")) {
      const el = document.querySelector(location.hash);
      if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); }
    }
  }

  let trashOpen = false;
  function renderTrash() {
    const t = state.trash || [];
    const box = $("trashBox");
    if (!t.length) { box.innerHTML = ""; trashOpen = false; return; }
    const label = t.length === 1 ? "1 deleted message" : `${t.length} deleted messages`;
    let html = `<div class="trash-bar"><span>${label} <span class="muted">· this session</span></span>
      <button class="ghost small" data-toggle>${trashOpen ? "Hide" : "Show"}</button></div>`;
    if (trashOpen) {
      html += `<div class="trash-list">` + t.map((m) => `<div class="trash-row">
          <span class="chip ${m.kind}">${KIND_LABEL[m.kind] || "Info"}</span>
          <span class="trash-text mono">${esc((m.dir === "out" ? "→ " : "") + m.station + " · " + m.text.replace(/@/g, ""))}</span>
          <button class="ghost small" data-restore="${m.id}">Restore</button></div>`).join("") +
        `<button class="ghost wide" data-restore-all>Restore all</button></div>`;
    }
    box.innerHTML = html;
  }

  function renderRequests() {
    const s = state;
    $("logonNote").textContent = s.current_unit ? `On ${s.current_unit}` : s.pending_logon ? `Pending ${s.pending_logon}` : "Not logged on";
    $("logoffBtn").hidden = !(s.current_unit || s.pending_logon);
    const f = s.flight || {};
    const fill = (id, v) => { const el = $(id); if (el && !el.value && v) el.value = v; };
    fill("pdcType", (s.vpilot && s.vpilot.last && s.vpilot.last.type) || f.aircraft); fill("pdcDep", f.departure); fill("pdcArr", f.arrival); fill("pdcStation", f.departure);
    fill("ocnLevel", (f.cruise || "").replace(/^FL/i, "").slice(0, 3));
  }

  // dark (navy, default), black or light
  function applyTheme(theme) {
    const t = theme === "light" || theme === "black" ? theme : "dark";
    if (t === "dark") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    $("themeColor").content = { dark: "#050e17", black: "#000000", light: "#f5f6fa" }[t];
    document.querySelectorAll("#setTheme button").forEach((b) => b.classList.toggle("on", b.dataset.theme === t));
    try { localStorage.setItem("clearway.theme", t); } catch (e) {}
  }

  function renderSettings() {
    const s = state, st = s.settings;
    applyTheme(st.theme);
    const titles = { offline: "Offline", connecting: "Connecting…", online: "Connected", error: "Couldn't connect" };
    $("statusTitle").textContent = titles[s.status] + (s.status === "online" ? ` as ${s.callsign}` : "");
    let detail = s.error || "Enter your details below, then connect.";
    if (s.status === "online" && !s.error) {
      const next = Math.max(0, Math.round((s.next_poll - Date.now()) / 1000));
      detail = `Checking Hoppie for messages · next check in ${next}s`;
      if (s.contracts.length) detail += ` · ADS-C: ${s.contracts.map((c) => c.station).join(", ")}`;
    }
    $("statusDetail").textContent = detail;
    const btn = $("connectBtn");
    const on = s.status === "online" || s.status === "connecting";
    btn.textContent = on ? "Disconnect" : "Connect";
    btn.classList.toggle("danger", on);

    if (!settingsDirty) {
      $("setLogon").placeholder = st.hoppie_logon_set ? `Saved (${st.hoppie_logon_hint})` : "From hoppie.nl/acars";
      $("setCid").value = st.vatsim_cid || "";
      $("setCallsign").value = st.callsign_override || "";
    }
    $("setNtfy").checked = st.ntfy_enabled;
    $("setMute").checked = st.mute_phone_when_panel_open;
    $("setAdsc").checked = st.adsc_enabled;
    $("setBrowser").checked = st.open_browser_on_start;
    $("setVpAuto").checked = st.vpilot_auto_connect;
    $("setVpAll").checked = st.vpilot_all_frequency;
    $("setTsat").checked = st.vdgs_tsat !== false;
    $("setQuitVp").checked = st.quit_with_vpilot !== false;
    $("setKeys").checked = st.panel_capture_keys;
    const vp = s.vpilot || {};
    $("vpStatus").textContent = !vp.active ? "vPilot not opened / plugin not found. Start vPilot, with the plugin installed."
      : vp.connected ? `Plugin running · vPilot connected as ${vp.callsign}` : "Plugin running · vPilot not connected to VATSIM";
    $("vpDot").className = "dot " + (!vp.active ? "" : vp.connected ? "online" : "connecting");
    $("vtextNote").textContent = vp.active && vp.connected ? `As ${vp.callsign}` : "vPilot offline";
    $("topic").textContent = st.ntfy_topic;
    $("panelState").textContent = s.panel_active ? "(panel open now)" : "";

    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    $("pairCard").hidden = !isLocal || !s.base_url;
    if (isLocal && s.base_url && typeof qrcode === "function") {
      // The pairing key only exists on the PC; ask the local API for it via the settings snapshot.
      renderPairQr(s.base_url);
    }
  }

  let lastQr = "";
  async function renderPairQr(base) {
    if (!renderPairQr.key) {
      try { const r = await fetch("/api/pair", { method: "POST" }); const d = await r.json(); renderPairQr.key = d.key; } catch (e) { return; }
    }
    const url = `${base}/?k=${renderPairQr.key}`;
    if (url === lastQr) return;
    lastQr = url;
    const qr = qrcode(0, "M");
    qr.addData(url); qr.make();
    $("pairQr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    $("pairUrl").textContent = url;
  }

  // ---------- events ----------
  // Main tabs: vPilot | CPDLC | Notes | Settings. CPDLC has two sub-views: Messages and Requests.
  let cpdlcSub = "messages";
  function showView(tab) {
    const view = tab === "cpdlc" ? cpdlcSub : tab;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x.dataset.view === tab));
    document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + view));
    document.body.dataset.tab = tab;
    try { localStorage.setItem("clearway.tab", tab); } catch (e) {}
    hooks.forEach((h) => { try { if (state) h(state, false, tab); } catch (e) {} });
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
  document.querySelectorAll(".subseg").forEach((seg) => seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    cpdlcSub = b.dataset.sub;
    document.querySelectorAll(".subseg button").forEach((x) => x.classList.toggle("on", x.dataset.sub === cpdlcSub));
    showView("cpdlc");
  }));

  $("messageList").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b && b.dataset.reply) return act("reply", { id: +b.dataset.id, text: b.dataset.reply }, `${b.dataset.reply} sent`);
    if (b && b.dataset.free) return openSheet(+b.dataset.free);
    if (b && b.dataset.ack) return act("ack", { id: +b.dataset.ack });
    if (b && b.dataset.del) return act("delete", { id: +b.dataset.del });
    if (b && b.dataset.fold) {
      const m = state.messages.find((x) => x.id === +b.dataset.fold);
      return act("collapse", { id: +b.dataset.fold, collapsed: !(m && m.collapsed) });
    }
    const folded = e.target.closest(".msg.collapsed");
    if (folded && !b) return act("collapse", { id: +folded.dataset.msg, collapsed: false });
    const card = e.target.closest(".msg.unread");
    if (card && !b) {
      const m = state.messages.find((x) => x.id === +card.dataset.msg);
      if (m && !m.options.length) act("ack", { id: m.id });
    }
  });
  $("ackAll").onclick = () => act("ack", { scope: "cpdlc" });
  $("trashBox").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.toggle !== undefined) { trashOpen = !trashOpen; return renderTrash(); }
    if (b.dataset.restoreAll !== undefined) return act("restore", {}, "Restored");
    if (b.dataset.restore) return act("restore", { id: +b.dataset.restore }, "Restored");
  });
  $("clearBtn").onclick = () => { if (confirm("Clear the message history? Messages still waiting for an answer are kept (delete those with ×).")) act("clear"); };

  // reply sheet
  let sheetId = null;
  function openSheet(id) {
    const m = state.messages.find((x) => x.id === id);
    if (!m) return;
    sheetId = id;
    $("sheetTitle").textContent = m.kind === "radio" ? "Reply on frequency" : `Reply to ${m.station}`;
    $("sheetText").classList.toggle("mono", !["pm", "radio"].includes(m.kind));   // vPilot text keeps its case
    $("sheetQuote").textContent = m.text.replace(/@/g, "");
    $("sheetText").value = "";
    $("sheet").hidden = false;
    setTimeout(() => $("sheetText").focus(), 50);
  }
  $("sheetClose").onclick = () => ($("sheet").hidden = true);
  $("sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") $("sheet").hidden = true; });
  $("sheetSend").onclick = async () => {
    const text = $("sheetText").value.trim();
    if (!text) return;
    if (await act("reply", { id: sheetId, text }, "Reply sent")) $("sheet").hidden = true;
  };

  // segmented controls
  document.querySelectorAll(".seg").forEach((seg) => seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    if (seg.id === "speedUnit") $("reqSpeed").placeholder = b.dataset.v === "M" ? ".84" : "280";
    if (seg.id === "textKind") $("vTo").hidden = b.dataset.v === "radio";
  }));
  const segVal = (id) => document.querySelector(`#${id} .on`).dataset.v;

  ["reqLevelReason", "reqDirectReason", "reqSpeedReason"].forEach((id) => {
    $(id).innerHTML = REASONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  });
  $("wcw").onchange = () => { $("wcwValue").hidden = !$("wcw").value.endsWith("FL"); };

  const val = (id) => $(id).value.trim().toUpperCase();
  const withReason = (text, id) => (val(id) ? `${text} ${val(id)}` : text);

  const senders = {
    level: () => { const fl = val("reqLevel").replace(/\D/g, ""); if (!fl) throw new Error("Enter a flight level."); return ["cpdlc", { text: withReason(`REQUEST FL${fl}`, "reqLevelReason") }]; },
    direct: () => { const fix = val("reqDirect"); if (!fix) throw new Error("Enter a waypoint."); return ["cpdlc", { text: withReason(`REQUEST DIRECT TO ${fix}`, "reqDirectReason") }]; },
    speed: () => {
      let v = val("reqSpeed").replace(/[^\d.]/g, ""); if (!v) throw new Error("Enter a speed.");
      const spd = segVal("speedUnit") === "M" ? "M" + v.replace(/^0?\./, "").replace(/^\./, "") : v + "KT";
      return ["cpdlc", { text: withReason(`REQUEST ${spd}`, "reqSpeedReason") }];
    },
    wcw: () => {
      let w = $("wcw").value;
      if (w.endsWith("FL")) { const fl = val("wcwValue").replace(/\D/g, ""); if (!fl) throw new Error("Enter a flight level."); w += fl; }
      return ["cpdlc", { text: `WHEN CAN WE EXPECT ${w}` }];
    },
    free: () => { const t = val("cpdlcText"); if (!t) throw new Error("Type a message."); return ["cpdlc", { text: t, ra: "Y" }]; },
    pdc: () => {
      const need = ["pdcStation", "pdcType", "pdcDep", "pdcArr", "pdcStand", "pdcAtis"];
      if (need.some((id) => !val(id))) throw new Error("Fill in all clearance fields.");
      return ["telex", { station: val("pdcStation"), text: `REQUEST PREDEP CLEARANCE ${state.callsign} ${val("pdcType")} TO ${val("pdcArr")} AT ${val("pdcDep")} STAND ${val("pdcStand")} ATIS ${val("pdcAtis")}` }];
    },
    oceanic: () => {
      const need = ["ocnStation", "ocnEntry", "ocnTime", "ocnMach", "ocnLevel"];
      if (need.some((id) => !val(id))) throw new Error("Fill in station, entry point, time, Mach and level.");
      const rmk = val("ocnRmk") || "NIL";
      return ["telex", { station: val("ocnStation"), text: `OCEANIC CLEARANCE REQUEST CALLSIGN: ${state.callsign} ENTRY POINT: ${val("ocnEntry")} AT: ${val("ocnTime")} REQ: M.${val("ocnMach").replace(/\D/g, "")} FL${val("ocnLevel").replace(/\D/g, "")} RMKS: ${rmk}` }];
    },
    vtext: () => {
      const radio = segVal("textKind") === "radio";
      const text = $("vText").value.trim(); if (!text) throw new Error("Type a message.");
      if (!radio && !val("vTo")) throw new Error("Enter a callsign.");
      return ["text", { kind: radio ? "radio" : "pm", to: val("vTo"), text }];
    },
    telex: () => { if (!val("telexStation") || !val("telexText")) throw new Error("Enter a station and a message."); return ["telex", { station: val("telexStation"), text: val("telexText") }]; },
    wx: () => { if (val("wxIcao").length !== 4) throw new Error("Enter a 4-letter ICAO code."); return ["inforeq", { what: segVal("wxKind"), icao: val("wxIcao") }]; },
  };

  document.querySelectorAll("[data-send]").forEach((b) => b.addEventListener("click", async () => {
    let call;
    try { call = senders[b.dataset.send](); } catch (e) { return toast(e.message, true); }
    b.disabled = true;
    const ok = await act(call[0], call[1], "Sent");
    b.disabled = false;
    if (ok && ["free", "telex", "vtext"].includes(b.dataset.send)) { $("cpdlcText").value = ""; $("telexText").value = ""; $("vText").value = ""; }
  }));

  $("logonBtn").onclick = () => { const st = val("logonStation"); if (!st) return toast("Enter a station.", true); act("logon", { station: st }, `Logon request sent to ${st}`); };
  $("logoffBtn").onclick = () => act("logoff", {}, "Logged off");

  $("connectBtn").onclick = () => {
    const on = state && (state.status === "online" || state.status === "connecting");
    act(on ? "disconnect" : "connect");
  };

  ["setLogon", "setCid", "setCallsign"].forEach((id) => $(id).addEventListener("input", () => (settingsDirty = true)));
  $("saveSettings").onclick = async () => {
    const ok = await act("settings", { hoppie_logon: $("setLogon").value.trim(), vatsim_cid: $("setCid").value.trim(), callsign_override: $("setCallsign").value.trim() }, "Saved");
    if (ok) { settingsDirty = false; $("setLogon").value = ""; }
  };
  const toggles = { setNtfy: "ntfy_enabled", setMute: "mute_phone_when_panel_open", setAdsc: "adsc_enabled", setBrowser: "open_browser_on_start",
    setVpAuto: "vpilot_auto_connect", setVpAll: "vpilot_all_frequency", setTsat: "vdgs_tsat", setQuitVp: "quit_with_vpilot", setKeys: "panel_capture_keys" };
  Object.entries(toggles).forEach(([id, k]) => $(id).addEventListener("change", (e) => act("settings", { [k]: e.target.checked })));
  document.querySelectorAll("#setTheme button").forEach((b) => b.addEventListener("click", () => {
    applyTheme(b.dataset.theme); act("settings", { theme: b.dataset.theme });
  }));

  $("copyTopic").onclick = async () => {
    try { await navigator.clipboard.writeText(state.settings.ntfy_topic); toast("Topic copied"); }
    catch (e) { toast("Select the topic and copy it manually", true); }
  };
  $("testNotif").onclick = () => act("test-notification", {}, "Test sent. Check your phone.");
  $("newTopic").onclick = () => { if (confirm("Create a new topic? You'll need to subscribe to it again in the ntfy app.")) act("new-topic", {}, "New topic created"); };

  // ---------- loop ----------
  // small API for vp.js (vPilot tab and notepad)
  const hooks = [];
  window.CW = { api, act, toast, esc, utc, onRender: (fn) => hooks.push(fn), get state() { return state; }, VP, KIND_LABEL };
  let startTab = "vpilot";
  try { startTab = localStorage.getItem("clearway.tab") || "vpilot"; } catch (e) {}
  if (location.hash.startsWith("#m")) startTab = "cpdlc";
  if (location.hash.startsWith("#tab=")) startTab = location.hash.slice(5);   // e.g. #tab=notes
  showView(startTab);

  poll(true);
  setInterval(() => poll(false), 1500);
  // refresh countdown text once per second without a network call
  setInterval(() => { if (state && state.status === "online") renderSettings(); }, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(true); });
})();
