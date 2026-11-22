/* Clearway web app: vPilot tab (frequency + private chats, nearby ATC, transponder) and notepad. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const CW = window.CW;
  const { esc, utc, toast } = CW;

  const store = {
    get(k, d) { try { const v = localStorage.getItem("clearway." + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("clearway." + k, JSON.stringify(v)); } catch (e) {} },
  };

  let active = "FREQ";
  let opened = store.get("vpOpen", []);      // chats opened with .chat / the ATC list
  let closed = store.get("vpClosed", {});    // chat -> last message id when it was closed
  let atcOpen = false;
  let obsTouched = false;                     // the observer tickbox follows the last choice until changed
  const atcOpenRows = {};   // controllers whose information is expanded
  let lastTab = "";
  let lastChatKey = "";

  const txFreq = (s) => {
    const c = s && s.vpilot && s.vpilot.com;
    if (!c) return "";
    return c.com1.tx ? c.com1.active : c.com2.tx ? c.com2.active : c.com1.active;
  };
  const label = (chat) => (chat === "FREQ" ? "Frequency" + (txFreq(CW.state) ? " " + txFreq(CW.state) : "") : chat);

  function vpMessages(s) { return s.messages.filter((m) => CW.VP.has(m.kind)); }

  function chatList(s) {
    const msgs = vpMessages(s);
    const chats = new Map([["FREQ", { unread: 0, last: 0 }]]);
    for (const m of msgs) {
      const c = m.chat || "FREQ";
      if (!chats.has(c)) chats.set(c, { unread: 0, last: 0 });
      const info = chats.get(c);
      info.last = Math.max(info.last, m.id);
      if (m.dir === "in" && !m.acked) info.unread++;
    }
    for (const c of opened) if (!chats.has(c)) chats.set(c, { unread: 0, last: 0 });
    // a closed chat comes back when a newer message arrives
    for (const [c, info] of chats) if (c !== "FREQ" && closed[c] !== undefined && info.last <= closed[c] && c !== active) chats.delete(c);
    return chats;
  }

  // ------------------------------------------------------------ rendering
  function render(s, first, tab) {
    tab = tab || document.body.dataset.tab;
    const vp = s.vpilot || {};
    renderStatus(s, vp);
    const chats = chatList(s);
    if (!chats.has(active)) active = "FREQ";
    renderTabs(chats);
    renderChat(s);
    renderAtc(vp);
    renderNotes(s);
    // reading the chat that is on screen marks it read
    // (new frequency text for others counts too, so the panel's grey dot goes away)
    if (tab === "vpilot" && !document.hidden && ((chats.get(active) || {}).unread || (active === "FREQ" && s.quiet_vpilot)))
      CW.act("ack", { chat: active });
    lastTab = tab;
  }

  function renderStatus(s, vp) {
    const dot = $("vpStateDot");
    dot.className = "dot " + (!vp.active ? "" : vp.connected ? "online" : "connecting");
    $("vpWho").textContent = !vp.active ? "vPilot not opened / plugin not found" : vp.connected ? vp.callsign : "vPilot offline";
    // flight plan on VATSIM: green tick filed, red cross not filed (or only a prefile); hidden until VATSIM knows you
    const fpShow = !!(vp.connected && !vp.observer && vp.fp_status), fpOk = vp.fp_status === "filed";
    $("vpFpWarn").hidden = !fpShow;
    $("vpFpWarn").className = "fp-warn" + (fpOk ? " ok" : "");
    $("vpFpWarn").textContent = fpOk ? "FP status ✓" : "FP status ✗";
    $("vpFpWarn").title = fpOk ? `Flight plan filed on VATSIM for ${vp.callsign || "this callsign"}`
      : vp.fp_status === "prefiled" ? "Only a prefile on VATSIM: the flight plan isn't active for this connection"
      : `No flight plan filed on VATSIM for ${vp.callsign || "this callsign"}`;
    $("vpWhoSub").textContent = !vp.active ? "Start vPilot, with the Clearway plugin installed (see Settings)."
      : vp.connected ? (vp.observer ? "Connected to VATSIM as an observer" : "Connected to VATSIM") : "Not connected to VATSIM";
    if (!obsTouched && vp.last) { $("vpObserver").checked = !!vp.last.observer; dimObserver(); }
    const btn = $("vpConnectBtn");
    btn.disabled = !vp.active;
    btn.textContent = vp.connected ? "Disconnect" : "Connect";
    btn.classList.toggle("danger", !!vp.connected);
    if (vp.connected) $("vpConnectForm").classList.add("hidden-block");
    // prefill the connect form
    const last = vp.last || {}, f = s.flight || {};
    const fill = (id, v) => { const el = $(id); if (el && !el.value && v && document.activeElement !== el) el.value = v; };
    // type and SELCAL: from your VATSIM flight plan (by your CID) when there is one, else your last connection; a value
    // filled in this way follows the flight plan, one you typed is never touched
    const vfp = (s.selcal && s.selcal.vatsim_fp) || {};
    const auto = (id, v) => {
      const el = $(id);
      if (!el || !v || document.activeElement === el) return;
      if (!el.value || (el.dataset.auto !== undefined && el.value === el.dataset.auto)) { el.value = v; el.dataset.auto = v; }
    };
    fill("vpCs", last.callsign || s.callsign);
    auto("vpType", vfp.type || last.type || f.aircraft);
    auto("vpSelcal", fmtSelcal(vfp.selcal || last.selcal));
    document.querySelectorAll("#vpXpdr button").forEach((b) => {
      b.classList.toggle("on", vp.modec === true ? b.dataset.v === "c" : vp.modec === false ? b.dataset.v === "sby" : false);
      b.disabled = !vp.connected || !!vp.observer;
    });
    $("vpIdent").disabled = !vp.connected || !!vp.observer;
    const c = vp.com;
    const radio = (n, r) => `COM${n} <b>${esc(r.active || "---.---")}</b>${r.tx ? " <span class=\"vp-tx\">TX</span>" : ""}`;
    $("vpCom").innerHTML = c ? radio(1, c.com1) + " &middot; " + radio(2, c.com2) : "";
    $("vpAtcCount").textContent = vp.connected && vp.controllers ? `(${vp.controllers.length})` : "";
    $("vpInput").disabled = !vp.active;
    // observers can't transmit on the frequency: only private messages (Clearway refuses frequency text)
    $("vpInput").placeholder = active === "FREQ" ? (vp.connected && vp.observer ? "Observer: private messages only (or a .command)" : "Message, or a .command") : `To ${active}, or a .command`;
  }

  function renderTabs(chats) {
    const html = [];
    for (const [c, info] of chats) {
      html.push(`<button class="vp-tab ${c === active ? "on" : ""}" data-chat="${esc(c)}">${esc(label(c))}` +
        (info.unread && c !== active ? `<b class="vp-dot">${info.unread}</b>` : "") +
        (c !== "FREQ" ? `<span class="vp-x" data-closechat="${esc(c)}" aria-label="Close">×</span>` : "") + `</button>`);
    }
    html.push(`<button class="vp-tab add" data-newchat="1" aria-label="New chat">+</button>`);
    $("vpTabs").innerHTML = html.join("");
  }

  function bubble(m) {
    const time = `<span class="vp-time">${utc(m.ts)}</span>`;
    if (m.kind === "vsys") return `<div class="vp-sys">${esc(m.text)} · ${utc(m.ts)}</div>`;
    if (m.kind === "vinfo") {
      return `<div class="vp-info"><div class="vp-meta"><b>${esc(m.station)}</b>${time}</div><pre>${esc(m.text)}</pre></div>`;
    }
    if (m.kind === "selcal") return `<div class="vp-alert selcal"><b>SELCAL</b> ${esc(m.station)}: ${esc(m.text)} ${time}</div>`;
    if (m.kind === "broadcast") return `<div class="vp-alert broadcast"><b>Broadcast</b> from ${esc(m.station)}: ${esc(m.text)} ${time}</div>`;
    const out = m.dir === "out";
    let state = "";
    if (out && m.status === "sending") state = `<span class="vp-state">Sending…</span>`;
    if (out && m.status === "failed") state = `<span class="vp-state err">Not delivered${m.error ? ": " + esc(m.error) : ""}</span>`;
    const who = out ? (m.station === "SUPERVISORS" ? "You → supervisors" : "You") : esc(m.station);
    const freq = m.freq ? ` <span class="muted">${esc(m.freq)}</span>` : "";
    return `<div class="vp-msg ${out ? "out" : "in"} ${m.mention ? "mention" : ""} ${!out && !m.acked ? "unread" : ""}">
      <div class="vp-meta"><b>${who}</b>${freq}${time}</div>
      <div class="vp-text">${esc(m.text)}</div>${state}</div>`;
  }

  function renderChat(s) {
    const box = $("vpChat");
    const msgs = vpMessages(s).filter((m) => (m.chat || "FREQ") === active);
    const key = active + ":" + msgs.map((m) => m.id + m.status + (m.acked ? 1 : 0)).join(",");
    if (key === lastChatKey) return;
    lastChatKey = key;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.innerHTML = msgs.length ? msgs.map(bubble).join("")
      : `<div class="vp-empty">${active === "FREQ" ? "Frequency text and controller info will appear here." : "No messages with " + esc(active) + " yet."}<br><span class="muted">Type <b>.help</b> for commands.</span></div>`;
    if (nearBottom || !box.dataset.scrolled) { box.scrollTop = box.scrollHeight; box.dataset.scrolled = "1"; }
  }

  function renderAtc(vp) {
    $("vpAtc").hidden = !atcOpen;
    if (!atcOpen) return;
    const list = vp.controllers || [];
    $("vpAtcList").innerHTML = list.length ? list.map((c) => {
      const open = !!atcOpenRows[c.callsign];
      const body = c.info && c.info.length ? esc(c.info.join("\n"))
        : (c.info_pending || !c.info ? "Requesting information…" : "No controller information.");
      return `<div class="vp-atc-item ${open ? "open" : ""}">
        <div class="vp-atc-row" data-atc="${esc(c.callsign)}">
          <svg class="vp-atc-arrow" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
          <span class="mono vp-atc-cs">${esc(c.callsign)}</span>
          <span class="mono vp-atc-f">${esc(c.frequency)}</span>
          <span class="muted vp-atc-d">${c.distance !== undefined ? c.distance + " nm" : ""}</span>
          <button class="ghost small" data-chatwith="${esc(c.callsign)}">Chat</button>
        </div>
        ${open ? `<pre class="vp-atc-info">${c.name ? `<span class="vp-atc-who">${esc(c.name)}</span>` : ""}${body}</pre>` : ""}
      </div>`;
    }).join("") : `<div class="muted small-text" style="padding:8px 0">${vp.connected ? "No controllers in range." : "Connect vPilot to see nearby controllers."}</div>`;
  }

  // ------------------------------------------------------------ actions
  function openChat(c) {
    c = c.toUpperCase();
    if (c !== "FREQ" && !opened.includes(c)) { opened.push(c); store.set("vpOpen", opened); }
    if (closed[c] !== undefined) { delete closed[c]; store.set("vpClosed", closed); }
    active = c;
    lastChatKey = "";
    if (CW.state) render(CW.state);
    $("vpInput").focus();
  }

  function closeChat(c) {
    if (c === "FREQ") return;
    const msgs = vpMessages(CW.state).filter((m) => m.chat === c);
    closed[c] = msgs.length ? msgs[msgs.length - 1].id : 0;
    const names = Object.keys(closed);                           // keep the saved list small
    while (names.length > 50) delete closed[names.shift()];
    opened = opened.filter((x) => x !== c);
    store.set("vpOpen", opened); store.set("vpClosed", closed);
    if (active === c) active = "FREQ";
    lastChatKey = "";
    render(CW.state);
  }

  async function copyChat() {
    const text = vpMessages(CW.state).filter((m) => (m.chat || "FREQ") === active)
      .map((m) => `${utc(m.ts)} ${m.dir === "out" ? "You" : m.station}: ${m.text}`).join("\n");
    try { await navigator.clipboard.writeText(text); toast("Chat copied"); }
    catch (e) {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("Chat copied"); } catch (e2) { toast("Couldn't copy on this device", true); }
      ta.remove();
    }
  }

  $("vpTabs").addEventListener("click", (e) => {
    const x = e.target.closest("[data-closechat]");
    if (x) { e.stopPropagation(); return closeChat(x.dataset.closechat); }
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.newchat) { const c = prompt("Open a private chat with (callsign):"); if (c && c.trim()) openChat(c.trim()); return; }
    if (b.dataset.chat) { active = b.dataset.chat; lastChatKey = ""; render(CW.state); }
  });

  // the message box grows with the text; Enter sends, line breaks become spaces
  function grow() {
    const ta = $("vpInput");
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
    ta.style.overflowY = ta.scrollHeight > 120 ? "auto" : "hidden";
  }
  $("vpInput").addEventListener("input", grow);
  $("vpInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("vpComposer").requestSubmit(); }
  });
  $("vpComposer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("vpInput");
    const text = input.value.replace(/\s+/g, " ").trim();
    if (!text) return;
    try {
      const res = await CW.api("vp/command", { text, chat: active });
      input.value = "";
      grow();
      if (res.open) openChat(res.open);
      if (res.close) closeChat(active);
      if (res.copy) copyChat();
    } catch (err) { toast(err.message, true); }
  });

  $("vpConnectBtn").onclick = () => {
    const vp = (CW.state && CW.state.vpilot) || {};
    if (vp.connected) { if (confirm("Disconnect vPilot from VATSIM?")) CW.act("vp/disconnect", {}); return; }
    $("vpConnectForm").classList.toggle("hidden-block");
    selcalCheck(0);
    const sc = CW.state && CW.state.selcal;
    if (!$("vpConnectForm").classList.contains("hidden-block") && sc && sc.simbrief_user && !sc.simbrief) refreshSb();
  };
  // small availability line under the SELCAL field
  let scTimer = null, scSeq = 0;
  function selcalCheck(delay = 500) {
    clearTimeout(scTimer);
    const st = $("vpSelcalSt");
    const code = $("vpSelcal").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4 || $("vpConnectForm").classList.contains("hidden-block")) { st.hidden = true; scSeq++; return; }
    st.hidden = false;
    st.className = "vp-sc-st";
    st.innerHTML = '<span class="spin"></span>check. avail…';
    const seq = ++scSeq;
    scTimer = setTimeout(async () => {
      try {
        const d = await CW.api("selcal/check", { code, remember: false, exclude: $("vpCs").value });
        if (seq !== scSeq) return;
        const used = d.used_by;
        if (used == null) { st.textContent = "not checked"; }
        else if (!used.length) { st.className = "vp-sc-st free"; st.textContent = "avail."; }
        else { st.className = "vp-sc-st taken"; st.textContent = `taken by ${used[0].callsign}${used.length > 1 ? ` +${used.length - 1}` : ""}`; }
      } catch (e) {
        if (seq === scSeq) { st.className = "vp-sc-st taken"; st.textContent = "invalid code"; }
      }
    }, delay);
  }
  // SELCAL always written AB-CD: the dash appears by itself after the second tone
  const fmtSelcal = (v) => { const s = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4); return s.length > 2 ? `${s.slice(0, 2)}-${s.slice(2)}` : s; };
  $("vpSelcal").addEventListener("input", () => { const i = $("vpSelcal"), f = fmtSelcal(i.value); if (f !== i.value) i.value = f; selcalCheck(); });

  // "SB: CALLSIGN" from the latest SimBrief flight plan, to compare with what's typed
  let sbBusy = false;
  function renderSb() {
    const s = CW.state, sc = s && s.selcal, sb = $("vpSb");
    const ofp = sc && sc.simbrief, typed = $("vpCs").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    sb.className = "vp-sb";
    if (sbBusy) return void (sb.textContent = "SB: fetching…");
    if (!sc) return void (sb.textContent = "");
    if (!sc.simbrief_user) return void (sb.textContent = "SB: set up in the SELCAL tab");
    if (!ofp || !ofp.callsign) return void (sb.textContent = sc.simbrief_error ? `SB: ${sc.simbrief_error}` : "SB: –");
    sb.innerHTML = `SB: <b>${esc(ofp.callsign)}</b>`;
    if (typed) sb.classList.add(typed === ofp.callsign ? "match" : "differ");
  }
  async function refreshSb() {
    const sc = CW.state && CW.state.selcal;
    if (!sc || !sc.simbrief_user) { document.querySelector('.tab[data-view="selcal"]').click(); $("scSbUser").hidden = false; return; }
    if (sbBusy) return;
    sbBusy = true; $("vpSbRef").classList.add("spinning"); renderSb();
    try { await CW.api("selcal/simbrief", {}); } catch (e) { toast(e.message, true); }
    sbBusy = false; $("vpSbRef").classList.remove("spinning"); renderSb();
  }
  $("vpSbRef").onclick = refreshSb;
  $("vpSb").onclick = () => {
    const ofp = CW.state && CW.state.selcal && CW.state.selcal.simbrief;
    if (!ofp || !ofp.callsign) return;
    $("vpCs").value = ofp.callsign; renderSb(); selcalCheck(0);
  };
  $("vpCs").addEventListener("input", renderSb);
  CW.onRender(renderSb);
  window.CW.vpSelcalCheck = () => selcalCheck(0);
  $("vpConnectGo").onclick = () => CW.act("vp/connect", { callsign: $("vpCs").value, type_code: $("vpType").value, selcal: $("vpSelcal").value,
    observer: $("vpObserver").checked }, $("vpObserver").checked ? "Connecting as observer…" : "Connecting…");
  // an observer only needs a callsign
  $("vpObserver").onchange = () => { obsTouched = true; dimObserver(); };
  function dimObserver() { ["vpType", "vpSelcal"].forEach((id) => $(id).classList.toggle("dim", $("vpObserver").checked)); }
  $("vpXpdr").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    CW.act("vp/modec", { on: b.dataset.v === "c" }, b.dataset.v === "c" ? "Mode C" : "Standby");
  });
  $("vpIdent").onclick = async () => {
    if (await CW.act("vp/ident", {})) { $("vpIdent").classList.add("flash-ok"); setTimeout(() => $("vpIdent").classList.remove("flash-ok"), 1500); }
  };
  $("vpAtcBtn").onclick = () => { atcOpen = !atcOpen; renderAtc((CW.state && CW.state.vpilot) || {}); };
  // tap a controller to expand/collapse their information (fetched when missing or older than 5 min)
  $("vpAtcList").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b && b.dataset.chatwith) return openChat(b.dataset.chatwith);
    const row = e.target.closest("[data-atc]");
    if (!row) return;
    const cs = row.dataset.atc;
    atcOpenRows[cs] = !atcOpenRows[cs];
    if (atcOpenRows[cs]) {
      const c = ((CW.state && CW.state.vpilot && CW.state.vpilot.controllers) || []).find((x) => x.callsign === cs);
      if (!c || !c.info || c.info_age === null || c.info_age > 300) CW.act("vp/atis", { callsign: cs, quiet: true });
    }
    renderAtc((CW.state && CW.state.vpilot) || {});
  });

  // ------------------------------------------------------------ notepad
  let notesTimer = null, notesDirty = false;
  function renderNotes(s) {
    const ta = $("notesText");
    if (!notesDirty && document.activeElement !== ta && ta.value !== (s.notes || "")) ta.value = s.notes || "";
  }
  $("notesText").addEventListener("input", () => {
    notesDirty = true;
    $("notesState").textContent = "Saving…";
    clearTimeout(notesTimer);
    notesTimer = setTimeout(async () => {
      try { await CW.api("notes", { text: $("notesText").value }); notesDirty = false; $("notesState").textContent = "Saved"; }
      catch (e) { $("notesState").textContent = "Not saved: " + e.message; }
    }, 700);
  });

  CW.onRender(render);
})();
