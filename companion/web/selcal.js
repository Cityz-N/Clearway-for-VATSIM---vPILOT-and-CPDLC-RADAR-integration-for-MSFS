/* Clearway web app: SELCAL tab (merged from the standalone SELCAL code generator).
   Codes are generated and checked against VATSIM by Clearway; saved codes live in Clearway for 24 h. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = CW.esc;
  let airlines = {};

  fetch("/api/selcal/airlines").then((r) => r.json()).then((d) => { airlines = d.airlines || {}; delete $("scTile").dataset.cs; if (CW.state) render(CW.state); }).catch(() => {});

  const normalize = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  function airlineFor(cs) {
    const m = /^([A-Z]{3})(\d[A-Z0-9]*)?$/.exec(cs || "");
    if (!m || !airlines[m[1]]) return null;
    return { iata: airlines[m[1]][0], name: airlines[m[1]][1] };
  }
  function fillTile(tile, cs) {
    if (tile.dataset.cs === cs) return;
    tile.dataset.cs = cs;
    const airline = airlineFor(cs);
    tile.textContent = cs.slice(0, 3) || "–";
    tile.classList.remove("logo");
    if (!airline) return;
    const img = new Image();
    img.alt = airline.name;
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      if (tile.dataset.cs !== cs) return;
      tile.textContent = "";
      tile.classList.add("logo");
      tile.appendChild(img);
    };
    img.src = `https://pics.avs.io/120/60/${airline.iata}.png`;
  }
  const codeHtml = (code) => esc(code).replace("-", '<span class="dash">-</span>');
  const isExtended = (code) => /[T-Z1-9]/.test(String(code || "").replace("-", ""));
  function usedHtml(list) {
    if (list === null || list === undefined) return '<span class="sc-used">Not checked on VATSIM</span>';
    if (!list.length) return '<span class="sc-used free">Free on VATSIM</span>';
    const who = list.slice(0, 3).map((u) => esc(u.callsign) + (u.where === "prefiled" ? " (prefiled)" : "")).join(", ");
    return `<span class="sc-used taken">Used by ${who}${list.length > 3 ? ` +${list.length - 3}` : ""}</span>`;
  }
  function timeLeft(s) {
    const mins = Math.floor(s / 60), h = Math.floor(mins / 60);
    return mins < 1 ? "under a minute left" : h ? `${h}h ${mins % 60}m left` : `${mins}m left`;
  }

  function render(s) {
    const sc = s.selcal;
    if (!sc) return;
    const v = sc.vatsim || {};
    $("scFeed").textContent = v.checked ? `VATSIM: ${v.count} flight plans checked` : (v.error || "");
    // SimBrief
    $("scSbWho").textContent = sc.simbrief_user ? "******" : "";      // kept private on screen
    if (document.activeElement !== $("scSbUserIn") && !$("scSbUserIn").value) $("scSbUserIn").value = sc.simbrief_user || "";
    const ofp = sc.simbrief;
    // no SELCAL in the flight plan: show the one vPilot connected to VATSIM with, if any
    const vpNow = s.vpilot || {};
    const vpTones = vpNow.connected && !vpNow.observer && vpNow.last ? String(vpNow.last.selcal || "").toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const vpSel = vpTones.length === 4 ? vpTones.slice(0, 2) + "-" + vpTones.slice(2) : "";
    // your VATSIM flight plan (by your CID): its SELCAL when SimBrief has none, or the whole plan without SimBrief
    const vfp = sc.vatsim_fp, vfpSel = vfp && vfp.selcal ? vfp.selcal : "";
    if (!ofp && vfp) {
      const vroute = [vfp.departure && vfp.arrival ? `${vfp.departure}→${vfp.arrival}` : "", vfp.type].filter(Boolean).join(" · ");
      $("scOfp").innerHTML = `<div class="sc-ofp"><div class="sc-ofp-top"><b class="mono">${esc(vfp.callsign || "–")}</b><span class="muted small-text">VATSIM · ${esc(vroute)}</span></div>` +
        (vfpSel
          ? `<div class="sc-ofp-code"><span class="sc-code small" data-copy="${esc(vfpSel)}">${codeHtml(vfpSel)}</span></div>
             <p class="muted small-text">In your VATSIM flight plan.</p>`
          : '<p class="muted small-text">No SELCAL in your VATSIM flight plan.</p>') + "</div>";
    } else if (ofp) {
      const route = [ofp.departure && ofp.arrival ? `${ofp.departure}→${ofp.arrival}` : "", ofp.aircraft, ofp.reg].filter(Boolean).join(" · ");
      $("scOfp").innerHTML = `<div class="sc-ofp"><div class="sc-ofp-top"><b class="mono">${esc(ofp.callsign || "–")}</b><span class="muted small-text">${esc(route)}</span></div>` +
        (ofp.selcal
          ? `<div class="sc-ofp-code"><span class="sc-code small" data-copy="${esc(ofp.selcal)}">${codeHtml(ofp.selcal)}</span>${usedHtml(ofp.used_by)}</div>
             <div class="row">${isExtended(ofp.selcal) ? "" : '<button class="ghost" data-ofp="use">Use in vPilot</button>'}<button class="ghost" data-ofp="save">Save</button></div>`
          : vfpSel
          ? `<div class="sc-ofp-code"><span class="sc-code small" data-copy="${esc(vfpSel)}">${codeHtml(vfpSel)}</span></div>
             <p class="muted small-text">Not in SimBrief: the SELCAL in your VATSIM flight plan.</p>`
          : vpSel
          ? `<div class="sc-ofp-code"><span class="sc-code small" data-copy="${esc(vpSel)}">${codeHtml(vpSel)}</span></div>
             <p class="muted small-text">Not in the flight plan: the SELCAL you connected to VATSIM with.</p>`
          : '<p class="muted small-text">No SELCAL in this flight plan. Generate one below and add it in SimBrief.</p>') + "</div>";
    } else {
      $("scOfp").innerHTML = sc.simbrief_error ? `<p class="sc-err small-text">${esc(sc.simbrief_error)}</p>` : "";
    }
    // generator
    const cur = sc.current, vp = s.vpilot || {};
    const input = $("scCallsign");
    if (!input.value && document.activeElement !== input) input.value = (cur && cur.callsign) || (vp.connected && vp.callsign) || (ofp && ofp.callsign) || s.callsign || "";
    showCallsign();
    $("scStd").innerHTML = cur ? codeHtml(cur.std) : "––-––";
    $("scExt").innerHTML = cur ? codeHtml(cur.ext) : "––-––";
    $("scStd").dataset.copy = cur ? cur.std : "";
    $("scExt").dataset.copy = cur ? cur.ext : "";
    $("scStdUsed").innerHTML = cur ? usedHtml(cur.std_used) : "";
    $("scExtUsed").innerHTML = cur ? usedHtml(cur.ext_used) : "";
    $("scSave").disabled = $("scUse").disabled = !cur;
    const chk = sc.checked;
    $("scCheckRes").innerHTML = chk ? `<div class="sc-check-res"><span class="sc-code small" data-copy="${esc(chk.code)}">${codeHtml(chk.code)}</span>${usedHtml(chk.used_by)}</div>
      <div class="row">${isExtended(chk.code) ? "" : '<button class="ghost" data-chk="use">Use in vPilot</button>'}<button class="ghost" data-chk="save">Save</button></div>` : "";
    renderSaved(sc);
  }

  function showCallsign() {
    const cs = normalize($("scCallsign").value);
    fillTile($("scTile"), cs);
    const al = airlineFor(cs);
    $("scAirline").textContent = al ? al.name : "";
  }

  function renderSaved(sc) {
    const saved = sc.saved || [];
    $("scSavedCount").textContent = saved.length ? `${saved.length} · kept 24 hours` : "";
    $("scFilter").hidden = saved.length < 2;
    const term = $("scFilter").value.trim().toUpperCase();
    const shown = saved.filter((e) => `${e.callsign} ${e.airline ? e.airline.name : ""} ${e.std || ""} ${e.ext || ""}`.toUpperCase().includes(term));
    $("scSaved").innerHTML = !saved.length ? '<p class="muted small-text center">Nothing saved in the last 24 hours.</p>'
      : !shown.length ? '<p class="muted small-text center">No saved code matches that search.</p>'
      : shown.map((e) => `<div class="card sc-row">
          <div class="sc-tile" data-tile="${esc(e.callsign)}"></div>
          <div class="sc-who"><b class="mono">${esc(e.callsign)}</b><span class="muted small-text">${esc([e.airline && e.airline.name, timeLeft(e.left)].filter(Boolean).join(" · "))}</span></div>
          <div class="sc-rcodes">${["std", "ext"].filter((k) => e[k]).map((k) => `<div><i class="sc-tag ${k}">${k.toUpperCase()}</i><span class="sc-code tiny" data-copy="${esc(e[k])}">${codeHtml(e[k])}</span></div>`).join("")}</div>
          <button class="del" data-sc-del="${esc(e.callsign)}|${e.generated}" aria-label="Remove">×</button></div>`).join("");
    $("scSaved").querySelectorAll("[data-tile]").forEach((t) => fillTile(t, t.dataset.tile));
  }

  // ---------- events ----------
  const callsign = () => normalize($("scCallsign").value);
  $("scCallsign").addEventListener("input", () => { $("scCallsign").value = normalize($("scCallsign").value); showCallsign(); });
  $("scCallsign").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("scGen").click(); } });
  $("scGen").onclick = () => CW.act("selcal/generate", { callsign: callsign() });
  $("scSave").onclick = () => {
    const cur = CW.state && CW.state.selcal && CW.state.selcal.current;
    if (cur) CW.act("selcal/save", { callsign: callsign() || cur.callsign, generated: cur.generated, std: cur.std, ext: cur.ext }, "Saved for 24 hours");
  };
  async function useInVpilot(code) {
    try {
      const d = await CW.api("selcal/use", { code });
      const vpSel = $("vpSelcal");
      if (vpSel) { vpSel.value = d.code; if (CW.vpSelcalCheck) CW.vpSelcalCheck(); }
      CW.toast(`${d.code} is set in the vPilot connect form`);
    } catch (e) { CW.toast(e.message, true); }
  }
  $("scUse").onclick = () => { const cur = CW.state && CW.state.selcal && CW.state.selcal.current; if (cur) useInVpilot(cur.std); };

  async function fetchSimbrief(user) {
    $("scSbFetch").disabled = true;
    try {
      await CW.api("selcal/simbrief", user === undefined ? {} : { user });
      $("scSbUser").hidden = true;
      CW.toast("SimBrief flight plan loaded");
    } catch (e) {
      $("scSbUser").hidden = false;
      CW.toast(e.message, true);
    } finally { $("scSbFetch").disabled = false; }
  }
  $("scSbFetch").onclick = () => {
    const sc = CW.state && CW.state.selcal;
    if (sc && sc.simbrief_user) fetchSimbrief();
    else { $("scSbUser").hidden = false; $("scSbUserIn").focus(); }
  };
  $("scSbWho").onclick = () => { $("scSbUser").hidden = !$("scSbUser").hidden; };
  $("scSbUserGo").onclick = () => fetchSimbrief($("scSbUserIn").value.trim());
  $("scSbUserIn").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("scSbUserGo").click(); } });
  $("scOfp").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ofp]"), ofp = CW.state && CW.state.selcal && CW.state.selcal.simbrief;
    if (!b || !ofp || !ofp.selcal) return;
    if (b.dataset.ofp === "use") return useInVpilot(ofp.selcal);
    CW.act("selcal/save", { callsign: ofp.callsign, generated: ofp.fetched, [isExtended(ofp.selcal) ? "ext" : "std"]: ofp.selcal }, "Saved for 24 hours");
  });
  async function check() {
    const v = $("scCheckIn").value.trim();
    if (!v) return;
    try { const d = await CW.api("selcal/check", { code: v, exclude: callsign() }); $("scCheckIn").value = d.code; }
    catch (e) { CW.toast(e.message, true); }
  }
  $("scCheckGo").onclick = check;
  $("scCheckIn").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); check(); } });
  $("scCheckRes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-chk]"), chk = CW.state && CW.state.selcal && CW.state.selcal.checked;
    if (!b || !chk) return;
    if (b.dataset.chk === "use") return useInVpilot(chk.code);
    CW.act("selcal/save", { callsign: callsign(), generated: chk.ts, [isExtended(chk.code) ? "ext" : "std"]: chk.code }, "Saved for 24 hours");
  });
  $("scFilter").addEventListener("input", () => CW.state && renderSaved(CW.state.selcal));
  $("scSaved").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sc-del]");
    if (!b) return;
    const [cs, gen] = b.dataset.scDel.split("|");
    CW.act("selcal/remove", { callsign: cs, generated: +gen });
  });
  // tap a code to copy it
  document.getElementById("view-selcal").addEventListener("click", async (e) => {
    const c = e.target.closest("[data-copy]");
    if (!c || !c.dataset.copy) return;
    try { await navigator.clipboard.writeText(c.dataset.copy); CW.toast(`${c.dataset.copy} copied`); }
    catch (err) { CW.toast("Copy isn't available here", true); }
  });

  CW.onRender(render);
})();
