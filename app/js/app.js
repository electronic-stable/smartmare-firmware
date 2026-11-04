/*
 * SmartMare 5V - SP-202 loader page: pads, trims, sample sets, card read and write
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.1 - 4 Nov 2026
 * SPDX-License-Identifier: MIT
 */
/* SmartMare SP-202 Card Manager: the page. Card model in card.js, USB in serial.js. */
"use strict";

const $ = id => document.getElementById(id);
const state = {
  link: null,
  info: null,
  base: null,          // the image as last read from (or written to) the card
  work: null,          // the image being edited
  source: "",          // where `work` came from
  bank: "C",
  selected: 0,         // 0..7 in the bank
  logLevel: "quiet",
  pending: {},         // "C1" -> an audio file waiting to be encoded onto the pad (editor source)
  editorKey: null,
};
let editor = null;

// ---------- log ----------
function log(text, cls = "info") {
  const el = $("log");
  const d = document.createElement("div");
  const t = new Date().toLocaleTimeString([], { hour12: false });
  const arrow = cls === "tx" ? "→ " : cls === "rx" ? "← " : cls === "err" ? "! " : "• ";
  d.innerHTML = `<span class="t">${t}</span> <span class="${cls}"></span>`;
  d.lastChild.textContent = arrow + text;
  el.appendChild(d);
  while (el.childNodes.length > 2000) el.removeChild(el.firstChild);
  if ($("log-scroll").checked) el.scrollTop = el.scrollHeight;
}

function note(text, cls = "") {
  const el = $("pads-note");
  el.textContent = text;
  el.style.color = cls === "err" ? "var(--fail)" : cls === "ok" ? "var(--ok)" : "";
}

// ---------- display ----------
function display(text, label) {
  Segments.render($("display"), text);
  if (label !== undefined && $("display-label")) $("display-label").textContent = label;
}

// ---------- checks ----------
const CHECKS = [
  ["browser", "Browser can talk to USB"],
  ["usb", "Card connected"],
  ["firmware", "Emulator firmware answers"],
  ["write", "Firmware can write blocks"],
  ["power", "SP-202 power"],
  ["health", "Bus health"],
  ["image", "Card image"],
  ["ecc", "Page checks (ECC)"],
  ["table", "Card pad table (C/D)"],
  ["backup", "BACKUP area (A/B)"],
];
const checks = {};
function check(id, st, sub = "") { checks[id] = { st, sub }; renderChecks(); }
function renderChecks() {
  const marks = { ok: "✓", warn: "!", fail: "✕", wait: "○" };
  $("checks").innerHTML = CHECKS.map(([id, label]) => {
    const c = checks[id] || { st: "wait", sub: "" };
    return `<li class="${c.st}"><span class="mark">${marks[c.st]}</span><span>${label}<span class="sub"></span></span></li>`;
  }).join("");
  [...$("checks").children].forEach((li, i) => { li.querySelector(".sub").textContent = (checks[CHECKS[i][0]] || {}).sub || ""; });
  const st = CHECKS.map(([id]) => (checks[id] || {}).st || "wait");
  const n = k => st.filter(x => x === k).length;
  $("checks-sum").textContent = n("fail") ? `· ${n("fail")} problem${n("fail") > 1 ? "s" : ""}`
    : n("warn") ? `· ${n("warn")} to look at` : n("ok") === st.length ? "· all good" : `· ${n("ok")} of ${st.length} good`;
  $("checks-sum").classList.toggle("bad", n("fail") > 0);
}

function imageChecks() {
  const w = state.work;
  if (!w) { ["image", "ecc", "table", "backup"].forEach(id => check(id, "wait")); return; }
  const used = w.usedBlocks().length;
  check("image", w.isFormatted() ? "ok" : "warn",
        `${state.source}: ${used} blocks used` + (w.isFormatted() ? ", formatted by the SP-202" : ", not formatted by the SP-202 (format it there first)"));
  const e = w.checkEcc();
  check("ecc", e.bad.length ? "fail" : "ok",
        e.bad.length ? `${e.bad.length} of ${e.checked} pages wrong (first: page ${e.bad[0]})` : `${e.checked} pages, all correct`);
  const card = new SM.Space(w, "card");
  if (card.present()) {
    const issues = card.check();
    check("table", issues.length ? "warn" : "ok", issues.length ? issues.join("; ") : `${card.used().length} pads used, samples packed`);
  } else check("table", "warn", "no pad table");
  const bk = new SM.Space(w, "backup");
  if (bk.present()) {
    const issues = bk.check();
    const areas = SM.backupAreas(w);
    check("backup", issues.length ? "warn" : "ok", issues.length ? issues.join("; ")
      : `present: backup${areas.length > 1 ? `s ${areas.join(", ")}` : " 1"} (pick one beside CARD BACKUP)`);
  } else check("backup", "warn", "none on the card. On the SP-202: CANCEL + BANK CARD C/D, then REC, to save banks A/B here");
}

// ---------- spaces and pads ----------
const isInternal = bank => bank === "A" || bank === "B";
// The space a bank shows: C/D on the card, or A/B in the backup area chosen (1-7).
function spaceOf(bank) { return state.work ? new SM.Space(state.work, isInternal(bank) ? "backup" : "card", state.area || 1) : null; }
function indexOf(bank, n) { return ("AC".includes(bank) ? 0 : 8) + n; }

// Sample names: the SP-202 keeps none, so the page remembers them by the sample's content
// (in this browser and in sample sets) and finds them again wherever the pad moves.
const NAMES_KEY = "smartmare-names";
let padNames = {};
try { padNames = JSON.parse(localStorage.getItem(NAMES_KEY) || "{}"); } catch (e) {}
function sampleKey(data) {
  let h = 0x811C9DC5;
  const n = Math.min(data.length, 8192);
  for (let i = 0; i < n; i++) h = Math.imul(h ^ data[i], 0x01000193);
  return `${data.length}:${(h >>> 0).toString(16)}`;
}
function rememberName(data, fileName) {
  padNames[sampleKey(data)] = fileName.replace(/\.[^.]+$/, "");
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(padNames)); } catch (e) {}
}
const nameOf = (sp, e) => padNames[sampleKey(sp.sample(e))] || "";
// The audio files put on pads in this session, by the same key: LOAD TO PAD redoes a pad from its
// file (any quality, mono or stereo). {data, chans, rate, fileName, from, to, gain}
const originals = {};

const mb = b => (b / 1048576).toFixed(1);
// A size as the user reads it: KB under 1 MB, else MB.
const size = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024)).toLocaleString()} KB`;
function fmtSeconds(s) { return s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s.toFixed(2)} s`; }

function renderPads() {
  const sp = spaceOf(state.bank);
  const present = sp && sp.present();
  const html = [], names = [];
  for (let n = 0; n < 8; n++) {
    const name = state.bank + (n + 1);
    let info = "", empty = true;
    const pend = state.pending[name];
    if (pend) {
      empty = false;
      const sec = (pend.end - pend.start) / pend.rate;
      info = `<span class="sname"></span><span class="grade">WAV → ${SM.SHORT[pend.grade]}</span><br>${fmtSeconds(sec)} · WAITING`;
      names[n] = pend.fileName.replace(/\.[^.]+$/, "");
    } else if (present) {
      const e = sp.entry(indexOf(state.bank, n));
      if (!e.empty) {
        empty = false;
        names[n] = nameOf(sp, e);
        info = `<span class="sname"></span><span class="grade">${SM.SHORT[e.grade]}</span> · <span class="st">${e.stereo ? "STEREO" : "MONO"}</span><br>${fmtSeconds(e.seconds)}${e.oneShot ? "" : ` · ♩ ${e.bpm}`}`;
      } else info = "EMPTY";
    } else info = state.work ? (isInternal(state.bank) ? "NO BACKUP" : "NOT FORMATTED") : "—";
    html.push(`<div class="pad${empty ? " empty" : ""}${pend ? " pending" : ""}${n === state.selected ? " selected" : ""}" data-n="${n}" draggable="${!empty && !pend}">
      <div class="pad-top"><span class="pad-name">${name}</span><span class="led${empty ? "" : !pend && onCard(state.bank, n) ? " on" : " amber"}" title="${empty ? "" : !pend && onCard(state.bank, n) ? "On the card" : "Not on the card yet: WRITE CARD"}"></span></div>
      <div class="pad-info">${info}</div></div>`);
  }
  $("pads").innerHTML = html.join("");
  $("pads").querySelectorAll(".sname").forEach(el => {
    const t = names[+el.closest(".pad").dataset.n];
    if (t) { el.textContent = t; el.title = t; } else el.remove();
  });
  fitPads();
  const areas = state.work ? SM.backupAreas(state.work) : [];
  $("area-row").innerHTML = areas.length > 1 ? `<span class="silk">BACKUP</span>` + areas.map(k =>
    `<button type="button" data-area="${k}" class="${k === (state.area || 1) ? "on" : ""}" title="Backup ${k}: saved on the SP-202 with pad ${k}">${k}</button>`).join("") : "";
  document.querySelectorAll(".bank").forEach(b => {
    b.classList.toggle("active", b.dataset.bank === state.bank);
    const s = spaceOf(b.dataset.bank);
    b.classList.toggle("absent", !!state.work && !(s && s.present()));
  });
  // memory meter
  if (present) {
    const total = sp.dataEnd - sp.dataStart, free = sp.freeBytes();
    $("mem-bar").style.width = `${(100 * (total - free) / total).toFixed(1)}%`;
    $("mem-text").textContent = `${mb(total - free)} of ${mb(total)} MB used`;
    $("mem-info").innerHTML = memoryTable(free, total, isInternal(state.bank));
  } else { $("mem-bar").style.width = "0"; $("mem-text").textContent = ""; $("mem-info").innerHTML = ""; }
}

// The recording time left per quality, for the space the samples really have. A mono sample
// takes half a byte per sample (two per byte), stereo twice that. Then the BACKUPs on the card:
// the page keeps one area for them (more are counted if the SP-202 has saved more).
const fmtMS = s => { const t = Math.floor(s); return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`; };
function memoryTable(free, total, internal) {
  const rows = SM.GRADES.map((g, i) =>
    `<tr><td>${g}</td><td>${fmtMS(free * 2 / SM.RATES[i])}</td><td>${fmtMS(free / SM.RATES[i])}</td></tr>`).join("");
  const areas = state.work ? SM.backupAreas(state.work).length : 0;
  return `<table><thead><tr><th>QUALITY</th><th>FREE MONO</th><th>FREE STEREO</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="mem-backup"><b>BACKUP</b> ${areas} of ${Math.max(1, areas)} · banks A and B, 0.5 MB each</p>
    ${internal ? "" : `<p>Each BACKUP of banks A and B takes 0.5 MB from the end of the card (32 s of HI-FI mono). This page keeps one backup free, so ${mb(total)} MB is left for banks C and D.</p>`}`;
}

// Whether a pad is on the card as it is here: same settings and sound as the card last read or
// written. The pad LED is green when it is, orange until WRITE CARD.
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function onCard(bank, n) {
  if (!state.base) return false;
  const w = spaceOf(bank), b = new SM.Space(state.base, isInternal(bank) ? "backup" : "card", state.area || 1);
  if (!w || !w.present() || !b.present()) return false;
  const i = indexOf(bank, n), ew = w.entry(i), eb = b.entry(i);
  return !ew.empty && !eb.empty && sameBytes(ew.raw, eb.raw) && sameBytes(w.sample(ew), b.sample(eb));
}

// The sample editor's screen as tall as the two rows of pads beside it, down to the lip under
// them (a 3px shadow).
function fitLcd() {
  const lcd = document.querySelector("#editor .lcd"), cv = lcd.querySelector("canvas");
  const h = Math.max(120, $("pads").offsetHeight + 3 - (lcd.offsetHeight - cv.offsetHeight));
  if (cv.style.height !== `${h}px`) cv.style.height = `${h}px`;
}

// Pad text stays 12px; only a pad whose line runs past its edge (a wide font) gets it smaller.
function fitPads() {
  $("pads").querySelectorAll(".pad-info").forEach(el => {
    el.style.fontSize = "";
    for (let f = 11.5; f >= 8 && el.scrollWidth > el.clientWidth; f -= .5) el.style.fontSize = `${f}px`;
  });
}

function selectedEntry() {
  const sp = spaceOf(state.bank);
  if (!sp || !sp.present()) return null;
  return { sp, e: sp.entry(indexOf(state.bank, state.selected)) };
}

const EFFECTS = [[0x00, "NONE"], [0x04, "RING MOD"], [0x08, "FILTER 2"], [0x10, "FILTER 1"]];
const DEFAULT_SETTINGS = { gate: false, oneShot: false, effect: 0, level: 127, stereo: false };

// The pad settings the SP-202 keeps on the card (PLAY, MODE, EFFECT in the sample editor, BPM
// in INFO), as controls; they change the pad at once. v: {gate, oneShot, effect, level, stereo}.
// off: no pad to set, the controls are shown greyed out.
let fxOpen = false;                             // the EFFECT sub-panel stays as the user left it
const seg = (key, a, b, on, offA, offB) =>
  `<div class="seg"><button type="button" data-set="${key}" data-v="0" class="${on ? "" : "on"}"${offA ? " disabled" : ""}>${a}</button>` +
  `<button type="button" data-set="${key}" data-v="1" class="${on ? "on" : ""}"${offB ? " disabled" : ""}>${b}</button></div>`;
function settingsHtml(v, off) {
  const fx = EFFECTS.map(([k, n]) => `<option value="${k}"${k === v.effect ? " selected" : ""}>${n}</option>`).join("");
  const fxName = v.stereo || off ? "" : (EFFECTS.find(x => x[0] === v.effect) || [0, "NONE"])[1];
  return `<div class="settings">
    <div class="set-row"><span class="silk lbl">PLAY</span>${seg("gate", "TRIGGER", "GATE", v.gate, off, off)}</div>
    <div class="set-row"><span class="silk lbl">MODE</span>${seg("oneShot", "LOOP", "ONE SHOT", v.oneShot, off, off)}</div>
    <details class="fx-box"${fxOpen ? " open" : ""} ontoggle="fxOpen = this.open"><summary>EFFECT${fxName && fxName !== "NONE" ? `<span>${fxName} · ${v.level}</span>` : ""}</summary>
    <div class="set-row"><span class="silk lbl">EFFECT</span><select data-set="effect"${v.stereo || off ? " disabled" : ""}>${fx}</select>
      ${v.stereo && !off ? '<span class="set-note">no effect on stereo pads</span>' : ""}</div>
    <div class="set-row"><span class="silk lbl">FX LEVEL</span><input type="range" min="0" max="127" value="${v.level}" data-set="level"
      ${v.stereo || !v.effect || off ? "disabled" : ""}><b class="lvl">${v.level}</b></div>
    </details>
  </div>`;
}
const chanHtml = (stereo, offMono, offStereo) =>
  `<div class="set-row"><span class="silk lbl">CHANNELS</span>${seg("stereo", "MONO", "STEREO", stereo, offMono, offStereo)}</div>`;
// BPM in INFO: what the SP-202 shows for the pad (set from the marks), or none for a one shot.
function bpmHtml(oneShot, bpm) {
  return `<div>BPM : ${oneShot ? "— (one shot)" : bpm}</div>`;
}

function renderDetail() {
  const s = selectedEntry(), body = $("detail-body"), chan = $("detail-chan"), info = $("pad-info");
  const name = state.bank + (state.selected + 1);
  const head = what => `<div><b>PAD ${name}</b> · <span class="iname"></span></div>${what}`;
  let sound = "";
  const pend = state.pending[name];
  if (pend) {                                    // a file waiting for the card to be read
    const set = pend.settings;
    const sec = (pend.end - pend.start) / pend.rate;
    sound = pend.fileName;
    info.innerHTML = head(`<div>${fmtSeconds(sec)} · not on the pad yet</div>`) + bpmHtml(set.oneShot, bpmOf(guessBeats(sec), sec));
    chan.innerHTML = chanHtml(set.stereo, false, pend.chans.length < 2);
    body.innerHTML = settingsHtml(set) +
      `<p class="hint">${spaceOf(state.bank)?.present() ? "LOAD TO PAD puts it on the pad." : "READ CARD (or open a card image), then LOAD TO PAD puts it on the pad."}</p>`;
  } else if (!s || s.e.empty) {
    sound = !s ? "" : "empty";
    info.innerHTML = head(`<div class="hint">${!s ? (state.work ? "This bank is not on the image." : "Connect the card and READ it, or open a sample set or a card image.")
      : "Drop an audio file or a .sp202pad on it, or drag another pad onto it."}</div>`);
    chan.innerHTML = chanHtml(false, true, true);
    body.innerHTML = settingsHtml(DEFAULT_SETTINGS, true);
  } else {
    const e = s.e, src = editor?.src?.kind === "marks" && editor.src.pad.bank === state.bank && editor.src.pad.index === e.index ? editor.src : null;
    const want = src ? src.wantStereo : e.stereo, canStereo = e.stereo || !!src?.original && src.original.chans.length > 1;
    sound = nameOf(s.sp, e) || "recorded on the SP-202";
    info.innerHTML = head(`<div>${[SM.GRADES[e.grade], e.stereo ? "STEREO" : "MONO", fmtSeconds(e.seconds), `${Math.round(e.length / 1024).toLocaleString()} KB`,
      isInternal(state.bank) ? "internal, via BACKUP" : ""].filter(Boolean).join(" · ")}</div>
      <div>${e.gate ? "GATE" : "TRIGGER"} · ${e.oneShot ? "ONE SHOT" : "LOOP"}</div>`)
      + bpmHtml(e.oneShot, e.bpm);
    chan.innerHTML = chanHtml(want, false, !canStereo);
    body.innerHTML = settingsHtml({ gate: e.gate, oneShot: e.oneShot, effect: e.raw[1], level: e.raw[8], stereo: e.stereo });
  }
  const iname = info.querySelector(".iname");
  if (sound) iname.textContent = sound; else iname.previousSibling.remove(), iname.remove();
  const has = !!(s && !s.e.empty) && !pend;
  $("btn-export").disabled = !has;
  $("btn-clear").disabled = !has && !pend;
  $("btn-import").disabled = !s;
  if (!state.busy) {
    display(state.link ? "202" : "---");        // the SP-202 screen: 202 while the card is connected
  }
}

// A setting changed in the PAD panel: written into the pad entry (card pads) or kept with
// the waiting audio file.
function applySetting(key, value) {
  const name = state.bank + (state.selected + 1), pend = state.pending[name];
  if (pend) {
    pend.settings[key] = key === "effect" || key === "level" ? value : !!value;
    if (pend.settings.stereo) pend.settings.effect = 0;
    log(`${name}: ${key} ${value} (waiting audio file)`);
    render();
    return;
  }
  const s = selectedEntry();
  if (!s || s.e.empty || !(value >= 0)) return;
  if (key === "stereo") {                       // the sound itself: changes on LOAD TO PAD
    if (editor?.src?.kind === "marks") { editor.src.wantStereo = !!value; editor.renderFields(); renderDetail(); }
    return;
  }
  const r = Uint8Array.from(s.e.raw);
  if (key === "gate") r[4] = value ? r[4] | 0x08 : r[4] & ~0x08;
  else if (key === "oneShot") r[4] = value ? r[4] | 0x04 : r[4] & ~0x04;
  else if (key === "effect") r[1] = s.e.stereo ? 0 : value;
  else if (key === "level") r[8] = Math.max(0, Math.min(127, value));
  else return;
  s.sp.writeEntry(s.e.index, r);
  edited(`${name}: ${key} → ${key === "effect" ? (EFFECTS.find(x => x[0] === value) || [0, value])[1] : value}`);
}

function dirtyBlocks() {
  if (!state.work || !state.base) return [];
  return state.work.diffBlocks(state.base);
}

function renderButtons() {
  const linked = !!state.link, info = state.info || {};
  const powered = info.powered === true;
  $("btn-connect").innerHTML = `<span class="key-led"></span>${linked ? "DISCONNECT" : "CONNECT"}`;
  $("btn-connect").classList.toggle("lit", linked);
  $("btn-read").disabled = !linked || powered || state.busy || !info.canDump;
  const dirty = dirtyBlocks().length;
  const writable = linked && !powered && !state.busy && info.canWrite && state.work && (dirty > 0 || !state.base);
  $("btn-write").disabled = !writable;
  $("write-count").textContent = state.base ? (dirty ? `${dirty} BLOCK${dirty > 1 ? "S" : ""}` : "") : (state.work ? "IMAGE" : "");
  $("btn-write").classList.toggle("lit", writable);
  $("btn-save").disabled = !state.work;
  $("btn-erase-all").disabled = !linked || powered || state.busy || !info.canWrite;
  $("btn-status").disabled = !linked;
  $("btn-set-card").disabled = !linked || powered || state.busy || !(state.work || Object.keys(state.pending).length);
  $("btn-loglevel").disabled = !linked;
  $("btn-loglevel").textContent = `FW LOG: ${state.logLevel.toUpperCase()}`;
  renderFirmware();
  // one line that says where things stand
  const cs = $("card-status");
  if (!linked) cs.textContent = state.work ? `Not connected · working on ${state.source}.` : "Not connected. Press CONNECT and pick the SmartMare port.";
  else if (powered) cs.innerHTML = '<span class="bad">The SP-202 is on and using the card: switch it off to read or write.</span>';
  else if (state.busy) cs.textContent = "Working…";
  else if (!state.base) cs.textContent = "Connected, SP-202 off. READ CARD to see its pads.";
  else cs.textContent = dirty ? `Connected · ${dirty} block${dirty > 1 ? "s" : ""} changed: press WRITE CARD.` : "Connected · the card holds what you see.";
}

function render() { renderPads(); syncEditor(); renderDetail(); renderButtons(); renderProject(); renderBackup(); renderFirmware(); }

// ---------- the BACKUP section ----------
const BK_FIRST = SM.BACKUP_BLOCK, BK_BYTES = (SM.BLOCKS - SM.BACKUP_BLOCK) * SM.BLOCK_BYTES;
function renderBackup() {
  const el = $("backup-status"), bk = state.work ? new SM.Space(state.work, "backup", state.area || 1) : null;
  if (!bk) el.innerHTML = "READ CARD (or open a sample set or a card image) to see the card backup.";
  else if (!bk.present()) el.innerHTML = "";
  else {
    const used = bk.used();
    el.innerHTML = `<b>Backup ${state.area || 1} on the card</b> · ${used.length} pad${used.length === 1 ? "" : "s"} (${used.map(e => e.name).join(", ") || "none"})
      · ${fmtSeconds(bk.freeBytes() / SM.RATES[0])} free in HI-FI STEREO
      · ${mb(bk.dataEnd - bk.dataStart - bk.freeBytes())} of ${mb(bk.dataEnd - bk.dataStart)} MB used`;
  }
  $("btn-bk-export").disabled = !(bk && bk.present());
  $("btn-bk-import").disabled = !state.work;
}

function exportBackup() {
  state.work.finalize();
  const at = SM.areaBlock(state.area || 1) * SM.BLOCK_BYTES;
  download(state.work.img.slice(at, at + BK_BYTES), `${projName()}-backup${state.area > 1 ? state.area : ""}.sp202bak`);
}

function importBackup(bytes, name) {
  if (bytes.length !== BK_BYTES) { note(`${name}: not an SP-202 backup (${size(BK_BYTES)} expected).`, "err"); return; }
  const probe = new SM.Image();
  probe.img.set(bytes, BK_FIRST * SM.BLOCK_BYTES);
  if (!new SM.Space(probe, "backup").present()) { note(`${name}: no SP-202 backup inside.`, "err"); return; }
  state.work.img.set(bytes, SM.areaBlock(state.area || 1) * SM.BLOCK_BYTES);
  state.editorKey = null;
  edited(`backup replaced by ${name}`);
  imageChecks();
  note("Backup replaced. WRITE CARD, then LOAD on the SP-202 to put it in banks A/B.", "ok");
}

// ---------- the trim screen ----------
const be32put = (a, o, v) => { a[o] = v >>> 24; a[o + 1] = (v >>> 16) & 255; a[o + 2] = (v >>> 8) & 255; a[o + 3] = v & 255; };
const MARK_ALIGN = 16;     // the SP-202's own marks are multiples of 16 bytes (32 samples mono)

// The BPM the SP-202 shows for a pad: beats ÷ the length between the marks. The page guesses
// the beats (1 to 64, a power of two) that put the tempo between 70 and 140; moving a mark keeps
// the tempo.
const padSeconds = (bytes, grade, stereo) => bytes * 2 / (stereo ? 2 : 1) / SM.RATES[grade];
function guessBeats(sec) {
  for (let beats = 1; beats < 64; beats *= 2) if (60 * beats / sec >= 70) return beats;
  return 64;
}
const bpmOf = (beats, sec) => Math.max(1, Math.min(255, Math.round(60 * beats / sec)));
const beatsOf = (bpm, sec) => Math.max(1, Math.round(bpm * sec / 60));
function sp202Bpm(bytes, grade, stereo, beats) {
  const sec = padSeconds(bytes, grade, stereo);
  return bpmOf(beats ?? guessBeats(sec), sec);
}
const markedSeconds = e => padSeconds((e.playEnd || e.length) - e.playStart, e.grade, e.stereo);

function syncEditor(force) {
  if (!editor) return;
  const name = state.bank + (state.selected + 1);
  const pend = state.pending[name];
  const s = selectedEntry();
  const e = s && !s.e.empty ? s.e : null;
  const key = pend ? `p:${name}:${pend.id}` : e ? `e:${name}:${e.start}:${e.length}:${state.source}` : `n:${name}:${!!s}`;
  if (!force && key === state.editorKey) return;
  state.editorKey = key;
  if (pend) editor.load(pend);
  else if (e) {
    const original = originals[sampleKey(s.sp.sample(e))];       // the file it came from, if this page has it
    const p = padSound(s.sp, e);
    editor.load({
      kind: "marks", title: [name, nameOf(s.sp, e), `${SM.GRADES[e.grade]} ${e.stereo ? "STEREO" : "MONO"}`, isInternal(state.bank) ? "INTERNAL" : "CARD"].filter(Boolean).join(" · "),
      total: e.length, start: e.playStart, end: e.playEnd || e.length, grade: e.grade, origGrade: e.grade, stereo: e.stereo,
      original, minGrade: original ? 0 : e.grade, wantStereo: e.stereo,
      align: MARK_ALIGN, editable: true, pad: { bank: state.bank, index: e.index },
      data: p.r ? p.l.map((v, i) => (v + p.r[i]) / 2) : p.l, lr: p.r ? [p.l, p.r] : null, spb: p.spb,
      rate: e.rate, fileName: [name, nameOf(s.sp, e)].filter(Boolean).join(" "),
      info: original ? "ORIGINAL FILE KEPT" : `${Math.max(1, Math.round(e.length / 1024)).toLocaleString()} KB`,
    });
  } else editor.load({ kind: "none", title: `${name} · EMPTY`, info: s ? "DROP AN AUDIO FILE ON THIS PAD" : "NO PAD TABLE: READ THE CARD OR OPEN AN IMAGE" });
}

function onEditorChange(src) {
  if (src.kind === "marks") {
    const sp = spaceOf(src.pad.bank), e = sp.entry(src.pad.index);
    const r = Uint8Array.from(e.raw);
    be32put(r, 18, src.start);
    be32put(r, 22, src.end);
    const sec = padSeconds(src.end - src.start, e.grade, e.stereo);       // the same tempo: whole beats in the new length
    r[2] = bpmOf(beatsOf(e.bpm, sec), sec);
    if (r[2] < 40 || r[2] > 250) r[2] = bpmOf(guessBeats(sec), sec);
    sp.writeEntry(src.pad.index, r);
    state.work.finalize();
    state.editorKey = `e:${e.name}:${e.start}:${e.length}:${state.source}`;
    renderPads(); renderDetail(); renderButtons();
  } else {
    delete src.cache;
    renderPads(); renderDetail();
  }
}

// Plays a pad as the SP-202 does: TRIGGER starts it on a press (with LOOP, the next press stops
// it), GATE plays it only while the pad or its key is held; LOOP repeats START-STOP, ONE SHOT
// plays it once. held: the pad sounding now.
let held = null;
async function padDown(n) {
  const name = state.bank + (n + 1), pend = state.pending[name];
  const el = $("pads").querySelector(`[data-n="${n}"]`);
  const s = spaceOf(state.bank), e = !pend && s && s.present() ? s.entry(indexOf(state.bank, n)) : null;
  if (!pend && (!e || e.empty)) return;
  const gate = pend ? !!pend.settings.gate : e.gate, loop = pend ? !pend.settings.oneShot : !e.oneShot;
  if (held && held.name === name && held.loop && !gate) { Audio202.stop(); held = null; return; }   // TRIGGER + LOOP: press again to stop
  const me = { name, n, gate, loop };
  document.querySelectorAll(".pad.playing").forEach(x => x.classList.remove("playing"));
  const done = () => { el?.classList.remove("playing"); if (held === me) held = null; };
  if (!pend) {
    const snd = padSound(s, e);
    const p = Audio202.play(snd.l, e.rate, e.playStart * snd.spb, (e.playEnd || e.length) * snd.spb, loop, done, snd.r);
    if (editor?.src?.kind === "marks" && editor.src.pad.index === e.index && editor.src.pad.bank === state.bank) p.source = editor.src;
  } else {
    const rate = SM.RATES[pend.grade];
    const key = `${pend.grade}:${pend.start}:${pend.end}`;
    if (!pend.cache || pend.cache.key !== key)
      pend.cache = { key, data: await Audio202.resample(pend.data.subarray(Math.floor(pend.start), Math.floor(pend.end)), pend.rate, rate) };
    Audio202.play(pend.cache.data, rate, 0, pend.cache.data.length, loop, done);
  }
  held = me;
  el?.classList.add("playing");
}
function padUp(n) {
  if (held && held.gate && held.n === n) { Audio202.stop(); held = null; }   // GATE: the sound stops with the finger
}
const trigger = n => padDown(n);

// EXPORT WAV of a pad (right-click): START-STOP as the SP-202 plays it, 31.25 kHz.
function exportPadWav(sp, e) {
  const snd = padSound(sp, e), a = e.playStart * snd.spb, b = (e.playEnd || e.length) * snd.spb;
  const [l, r] = [snd.l, snd.r].map(c => c && Audio202.toSP202(c.subarray(a, b), e.rate));
  const name = [e.name, nameOf(sp, e)].filter(Boolean).join(" ");
  download(wavFile(l.data, l.rate, r && r.data), `${name}-${SM.SHORT[e.grade].toLowerCase()}.wav`);
  log(`${e.name}: exported as WAV (${SM.GRADES[e.grade]}, ${fmtSeconds(e.seconds)})`, "info");
}

// The right-click menu of a pad.
function padMenu(n, x, y) {
  state.selected = n;
  render();
  const s = selectedEntry(), has = !!(s && !s.e.empty);
  const m = $("pad-menu");
  m.innerHTML = `<button type="button" data-m="load"${s ? "" : " disabled"}>LOAD SAMPLE…</button>
    <button type="button" data-m="wav"${has ? "" : " disabled"}>EXPORT WAV</button>
    <button type="button" data-m="pad"${has ? "" : " disabled"}>EXPORT PAD</button>
    <button type="button" data-m="clear"${has ? "" : " disabled"}>CLEAR PAD</button>`;
  m.hidden = false;
  m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 8)}px`;
}

async function loadAudio(bytes, fileName, bank, n) {
  const name = bank + (n + 1);
  try {
    const a = await Audio202.decodeFile(bytes);
    const prev = state.pending[name];
    state.pending[name] = {
      kind: "audio", id: Date.now(), pad: name, fileName, title: `${name} · ${fileName}`,
      data: a.data, chans: a.chans, rate: a.rate, channels: a.chans.length, total: a.data.length,
      start: 0, end: a.data.length, grade: prev ? prev.grade : 0, editable: true,
      settings: prev ? { ...prev.settings } : { ...DEFAULT_SETTINGS },
      info: `${a.rate} HZ${a.chans.length > 1 ? " · ST→MONO" : ""}`,
    };
    state.bank = bank;
    state.selected = n;
    log(`${fileName} on ${name}: ${(a.data.length / a.rate).toFixed(2)} s at ${a.rate} Hz`, "info");
    const sp = spaceOf(bank), pend = state.pending[name];
    if (sp && sp.present()) {                    // straight onto the pad, at the best quality that fits
      const old = sp.entry(indexOf(bank, n)), free = sp.freeBytes() + (old.empty ? 0 : old.length);
      const need = g => (Math.ceil(a.data.length / a.rate * SM.RATES[g] / 2) + 16) * (pend.settings.stereo && a.chans.length > 1 ? 2 : 1);
      while (pend.grade < 3 && need(pend.grade) > free) pend.grade++;
      if (await commitPending(name))
        note(`${fileName} is on ${name} (${SM.GRADES[pend.grade]}). Set the marks, QUALITY or CHANNELS and LOAD TO PAD to redo it; WRITE CARD to keep it.`, "ok");
    } else note(`${fileName} is waiting for ${name}: READ CARD (or open a card image), then LOAD TO PAD.`, "ok");
    render();
  } catch (e) {
    note(`${fileName}: the browser cannot read this audio file (${e.message || e}).`, "err");
  }
}

// A card pad's sound: [left, right] (right undefined for mono) and samples per byte.
function padSound(sp, e) {
  const bytes = sp.sample(e);
  if (!e.stereo) return { l: Codec202.decode(bytes), r: undefined, spb: 2 };
  const [l, r] = Codec202.decodeStereo(bytes);
  return { l, r, spb: 1 };
}

// Encodes a waiting audio file (START–END, at its grade) and puts it on its pad, its peak
// brought to NORMAL_PEAK of the codec's REF level: 1290 units, the peak of the SP-202's own
// recordings at REC LEVEL MAX, so kicks and bass do not overdrive what follows its output.
const NORMAL_PEAK = 0.63;
async function commitPending(name) {
  const pend = state.pending[name];
  if (!pend) return false;
  const bank = name[0], n = +name.slice(1) - 1, sp = spaceOf(bank);
  if (!sp || !sp.present()) { note(`Bank ${bank} is not on the image: READ CARD first.`, "err"); return false; }
  const set = pend.settings;
  const { parts, gain } = await soundParts(pend);               // brought to NORMAL_PEAK, both channels alike
  const stereo = parts.length > 1;
  const t0 = performance.now();
  const { bytes, clipped } = stereo ? Codec202.encodeStereo(parts[0], parts[1]) : Codec202.encode(parts[0]);
  const data = bytes.length % 16 ? Uint8Array.from([...bytes, ...new Uint8Array(16 - bytes.length % 16)]) : bytes;
  const bpm = sp202Bpm(data.length, pend.grade, stereo);
  const r = [0, stereo ? 0 : set.effect, bpm, bpm,
             (pend.grade << 6) | (stereo ? 0x20 : 0) | (set.gate ? 0x08 : 0) | (set.oneShot ? 0x04 : 0),
             0xFF, 0, 0x30, set.level, 0x02].concat(Array(16).fill(0));
  try { sp.put(indexOf(bank, n), r, data); }
  catch (e) { note(`${name}: ${e.message}`, "err"); log(`${name}: ${e.message}`, "err"); return false; }
  delete state.pending[name];
  state.editorKey = null;
  rememberName(data, pend.fileName);
  originals[sampleKey(data)] = { data: pend.data, chans: pend.chans, rate: pend.rate, fileName: pend.fileName,
                                 from: Math.floor(pend.start), to: Math.floor(pend.end), gain };
  log(`${name}: ${pend.fileName} encoded (${SM.GRADES[pend.grade]}${stereo ? " STEREO" : ""}, ${size(data.length)}, level ${(20 * Math.log10(gain)).toFixed(1)} dB, ${(performance.now() - t0).toFixed(0)} ms)`
      + (clipped ? `, ${clipped} samples clipped: the file is louder than the SP-202's full scale` : ""), clipped ? "warn" : "info");
  if (pend.grade) log(`${name}: ${SM.GRADES[pend.grade]} is encoded like HI-FI at its own rate; only HI-FI was checked on the SP-202`, "warn");
  edited(`${name} ready to write`);
  return true;
}

// LOAD TO PAD on a card pad: START–STOP put back on the pad at the chosen quality and channels,
// with its settings and the same beats. It is redone from its original file when this page has
// it (any quality, mono or stereo), else from the pad itself (down only, or stereo to mono). The
// part outside the marks is gone and its memory freed; the pad then plays whole.
async function resamplePad(src) {
  const sp = spaceOf(src.pad.bank), e = sp.entry(src.pad.index);
  const cut = src.start > 0 || src.end < e.length;
  if (e.empty || src.grade < src.minGrade) return false;
  const t0 = performance.now();
  const { parts, region } = await soundParts(src);
  const stereo = parts.length > 1;
  if (src.grade === e.grade && stereo === e.stereo && !cut) {
    note(`${e.name} already holds this sound (quality, channels, marks). WRITE CARD puts the pad on the card.`, "ok");
    return false;
  }
  const { bytes, clipped } = stereo ? Codec202.encodeStereo(parts[0], parts[1]) : Codec202.encode(parts[0]);
  const data = bytes.length % 16 ? Uint8Array.from([...bytes, ...new Uint8Array(16 - bytes.length % 16)]) : bytes;
  const r = Uint8Array.from(e.raw);
  r[4] = (r[4] & 0x1F) | (src.grade << 6) | (stereo ? 0x20 : 0);
  if (stereo) r[1] = 0;                                           // no effect on stereo pads
  r[2] = sp202Bpm(data.length, src.grade, stereo, beatsOf(e.bpm, markedSeconds(e)));
  be32put(r, 18, 0);
  be32put(r, 22, data.length);
  const title = nameOf(sp, e);
  try { sp.put(e.index, r, data); }
  catch (err) { note(`${e.name}: ${err.message}`, "err"); log(`${e.name}: ${err.message}`, "err"); return false; }
  if (title) rememberName(data, `${title}.x`);
  if (src.original) originals[sampleKey(data)] = { ...src.original, from: region[0], to: region[1] };
  state.editorKey = null;
  const what = [cut ? "cut to its start and stop points" : "", src.grade !== e.grade ? `${SM.GRADES[e.grade]} → ${SM.GRADES[src.grade]}` : "",
                stereo !== e.stereo ? (stereo ? "MONO → STEREO" : "STEREO → MONO") : "", src.original ? "from its file" : ""].filter(Boolean).join(", ");
  log(`${e.name}: ${what}, ${size(e.length)} → ${size(data.length)} (${(performance.now() - t0).toFixed(0)} ms)`
      + (clipped ? `, ${clipped} samples clipped` : ""), clipped ? "warn" : "info");
  edited(`${e.name} reloaded (${what}): WRITE CARD to keep it`);
  note(`${e.name} is done: ${what}. WRITE CARD to put it on the card.`, "ok");
  return true;
}

// TRUNCATE, as on the SP-202: the pad cut to its start and stop points byte for byte (the marks
// fall on 16-byte frame boundaries), the rest deleted and its memory freed. No re-encoding; the
// settings and the BPM stay, the pad then plays whole.
function truncatePad(src) {
  const sp = spaceOf(src.pad.bank), e = sp.entry(src.pad.index);
  if (e.empty || (src.start === 0 && src.end === e.length)) return false;
  const data = Uint8Array.from(sp.sample(e).subarray(src.start, src.end));
  const r = Uint8Array.from(e.raw);
  be32put(r, 18, 0);
  be32put(r, 22, data.length);
  const title = nameOf(sp, e);
  try { sp.put(e.index, r, data); }
  catch (err) { note(`${e.name}: ${err.message}`, "err"); log(`${e.name}: ${err.message}`, "err"); return false; }
  if (title) rememberName(data, `${title}.x`);
  if (src.original) {                            // the file it came from, cut alike
    const o = src.original, k = (o.to - o.from) / e.length;
    originals[sampleKey(data)] = { ...o, from: o.from + Math.round(src.start * k), to: o.from + Math.round(src.end * k) };
  }
  state.editorKey = null;
  edited(`${e.name} truncated: ${size(e.length)} → ${size(data.length)}, ${size(e.length - data.length)} freed (WRITE CARD to keep it)`);
  note(`${e.name} truncated: ${size(e.length - data.length)} freed. WRITE CARD to put it on the card.`, "ok");
  return true;
}

function edited(what) {
  state.work.finalize();
  log(what);
  render();
}

// ---------- connection ----------
function onInfo(info) {
  state.info = info;
  check("firmware", info.firmware ? "ok" : "wait", info.banner || "");
  if (info.firmware) {
    check("write", info.canWrite ? "ok" : "fail", info.canWrite ? "D (read) and W (write) available"
          : "this firmware cannot write: load the latest smartmare-5v-sp-202 firmware");
    if (!info.layoutOk) check("write", "fail", "the firmware overlaps the image area");
  }
  if (info.powered === true) check("power", "warn", `ON (${info.vcc ?? "?"} V): the SP-202 is using the card. Switch it off to READ or WRITE CARD.`);
  else if (info.powered === false) check("power", "ok", "off: the card can be read and written");
  const h = info.health;
  if (h) {
    const errs = [h.wrong && `${h.wrong} wrong reads`, h.overflows && `${h.overflows} FIFO overflows`,
                  h.unerased && `${h.unerased} programs over unerased pages`, h.queued && `${h.queued} reads with nothing queued`,
                  h.late && `${h.late} late data changes`].filter(Boolean);
    check("health", errs.length ? "warn" : "ok", errs.length ? errs.join(", ")
          : `no errors · ${size(h.reads ?? 0)} read by the SP-202 checked`);
    $("led-health").className = "led " + (errs.length ? "amber" : "on");
  }
  $("led-power").className = "led " + (info.powered ? "amber blink" : "");
  renderButtons();
}

function onLine(text, quiet, cls) {
  if (quiet) return;
  const m = text.match(/^log level: (\w+)/);
  if (m) state.logLevel = m[1];
  const c = /refused|ERROR|!!|ERR /.test(text) ? "err" : cls;
  log(text, c);
  if (m) renderButtons();
}

function onClose() {
  log("card disconnected", "warn");
  state.link = null;
  state.info = null;
  check("usb", "fail", "disconnected");
  ["firmware", "write", "power", "health"].forEach(id => check(id, "wait"));
  $("led-usb").className = "led";
  $("led-power").className = "led";
  $("led-health").className = "led";
  render();
}

const NO_SERIAL = "This browser cannot open USB serial ports. Open this page in Chrome or Edge "
  + "(right-click the file → Open with → Microsoft Edge). Firefox and Safari cannot.";

async function connect(port) {
  if (state.link) { if (!port) await state.link.disconnect(); return; }
  if (!CardLink.supported()) { log(NO_SERIAL, "err"); note(NO_SERIAL, "err"); return; }
  const link = new CardLink({ onLine, onInfo, onClose });
  try {
    await link.connect(port);
  } catch (e) {
    if (e.name !== "NotFoundError") log(`connection failed: ${e.message}`, "err");
    return;
  }
  state.link = link;
  $("led-usb").className = "led on";
  check("usb", "ok", "USB serial open (Raspberry Pi RP2350)");
  log("card connected", "info");
  display("202", "CONNECTED");
  render();
  setTimeout(() => {
    if (state.link === link && !link.info.firmware)
      check("firmware", "fail", "no answer: is this the SmartMedia card with the emulator firmware?");
  }, 3000);
}

// ---------- read / write ----------
async function readCard() {
  if (dirtyBlocks().length && !await ask("Discard your changes?", "<p>Reading the card replaces the image you are editing.</p>", "READ"))
    return;
  state.busy = true;
  $("btn-read").classList.add("busy");
  renderButtons();
  display("rd", "READING");
  const t0 = performance.now();
  try {
    const img = await state.link.dump(p => display(String(Math.min(99, Math.round(100 * p / 2600))), `READING ${p} PAGES`));
    state.base = img;
    state.work = img.clone();
    state.source = "card";
    log(`card read in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${img.usedBlocks().length} blocks used`, "info");
    imageChecks();
    note("Card read.", "ok");
  } catch (e) {
    log(e.message, "err");
    note(e.message, "err");
  } finally {
    state.busy = false;
    $("btn-read").classList.remove("busy");
    render();
  }
}

function describeBlocks(blocks) {
  const parts = [];
  const cis = blocks.filter(b => b === 0).length, table = blocks.filter(b => b === 1).length;
  const samples = blocks.filter(b => b >= 2 && b < SM.BACKUP_BLOCK).length, backup = blocks.filter(b => b >= SM.BACKUP_BLOCK).length;
  if (cis) parts.push("card identity (block 0)");
  if (table) parts.push("C/D pad table");
  if (samples) parts.push(`${samples} sample block${samples > 1 ? "s" : ""}`);
  if (backup) parts.push(`${backup} BACKUP block${backup > 1 ? "s" : ""} (banks A/B)`);
  return parts.join(", ");
}

async function writeCard() {
  const link = state.link;
  state.busy = true;
  renderButtons();
  try {
    // Always read the card again: the SP-202 may have changed it since the last READ CARD (a
    // BACKUP SAVE rewrites banks A/B, a recording adds pages). Comparing with an old copy would
    // skip blocks that look unchanged here but are not on the card (3 Nov 2026: holes in A1-A3).
    log("reading the card first, to send what differs from what it really holds", "info");
    display("rd", "READING");
    state.base = await link.dump(p => display(String(Math.min(99, Math.round(100 * p / 2600))), `READING ${p} PAGES`));
    for (const name of Object.keys(state.pending)) {
      display("Enc", `ENCODING ${name}`);
      await commitPending(name);
    }
    state.work.finalize();
    const blocks = dirtyBlocks();
    if (!blocks.length) { note("Nothing to write: the card already holds this image.", "ok"); return; }
    const backup = blocks.some(b => b >= SM.BACKUP_BLOCK);
    state.busy = false;
    const ok = await ask("Write to the card?",
      `<p>${blocks.length} block${blocks.length > 1 ? "s" : ""} will be erased and written: ${describeBlocks(blocks)}.</p>
       <p>Keep the SP-202 off until it is done.${backup ? " Then load banks A/B into the SP-202 with its BACKUP LOAD." : ""}</p>`, "WRITE");
    state.busy = true;
    if (!ok) return;
    $("btn-write").classList.add("busy");
    const t0 = performance.now();
    await link.writeBlocks(state.work, blocks, (n, total) => display(String(Math.round(100 * n / total)).padStart(3, " ").slice(-3), `WRITING ${n} / ${total}`));
    state.base = state.work.clone();
    log(`${blocks.length} blocks written and read back in ${((performance.now() - t0) / 1000).toFixed(1)} s`, "info");
    note(backup ? "Written. On the SP-202, LOAD the backup to put banks A/B in its memory." : "Written. The card is ready for the SP-202.", "ok");
    state.source = "card";
    imageChecks();
  } catch (e) {
    log(e.message, "err");
    note(e.message, "err");
  } finally {
    state.busy = false;
    $("btn-write").classList.remove("busy");
    render();
  }
}

// A blank card: everything erased on the card itself, after typing ERASE.
async function eraseCard() {
  const ok = ask("Erase the whole card?", `<p>Everything on the card is erased: the pads of banks C/D, the BACKUP of banks A/B
     and every sample set. It cannot be undone.</p>
     <p>To keep something, SAVE BACKUP (CARD IMAGE) or copy the sample sets from the SMARTMARE drive first.</p>
     <p>Type <b>ERASE</b> to confirm:</p><input id="erase-confirm" autocomplete="off" spellcheck="false">`, "ERASE");
  const input = $("erase-confirm"), okBtn = $("dlg-ok");
  okBtn.disabled = true;
  input.addEventListener("input", () => { okBtn.disabled = input.value.trim().toUpperCase() !== "ERASE"; });
  input.addEventListener("keydown", e => e.stopPropagation());
  input.focus();
  const go = await ok;
  okBtn.disabled = false;
  if (!go) return;
  state.busy = true;
  renderButtons();
  try {
    display("Er", "ERASING");
    await state.link.eraseAll((n, total) => display(n < 0 ? "SEt" : String(Math.round(100 * n / total)).padStart(3, " ").slice(-3), n < 0 ? "ERASING THE SETS" : `ERASING ${n} / ${total}`));
    log("card erased: image and sample sets", "info");
    state.base = new SM.Image();
    state.work = state.base.clone();
    state.source = "card";
    state.pending = {};
    imageChecks();
    note("The card is blank. Format it on the SP-202 before recording.", "ok");
  } catch (e) {
    log(`erase: ${e.message}`, "err");
    note(`Not erased: ${e.message}`, "err");
  } finally {
    state.busy = false;
    render();
  }
}

// ---------- files ----------
function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function openImage(bytes, name) {
  try {
    const img = new SM.Image(bytes);
    state.work = img;
    state.source = name;
    log(`opened ${name}`, "info");
    if (state.base) note(`${name} opened. WRITE CARD sends the blocks that differ from the card.`, "ok");
    else note(`${name} opened.`, "ok");
    imageChecks();
    render();
  } catch (e) {
    note(`${name}: ${e.message}`, "err");
    log(`${name}: ${e.message}`, "err");
  }
}

function loadPadFile(bytes, name, bank, n) {
  const sp = spaceOf(bank);
  if (!sp || !sp.present()) { note(`Bank ${bank} is not on the image.`, "err"); return; }
  try {
    const p = SM.parsePadFile(bytes);
    sp.put(indexOf(bank, n), p.entry, p.data);
    state.selected = n;
    edited(`${name} (from ${p.source}) loaded on ${bank}${n + 1}`);
    note(`${bank}${n + 1} loaded. Press WRITE CARD.`, "ok");
  } catch (e) {
    note(`${name}: ${e.message}`, "err");
  }
}

async function dropFiles(files, bank, n) {
  for (const f of files) {
    const lower = f.name.toLowerCase();
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (lower.endsWith(".smartmare")) await openProjectBytes(bytes, f.name);
    else if (lower.endsWith(".sp202bak")) { if (state.work) importBackup(bytes, f.name); else note("Read the card or open a card image first.", "err"); }
    else if (lower.endsWith(".img") || bytes.length === SM.IMAGE_BYTES) openImage(bytes, f.name);
    else if (lower.endsWith(".sp202pad")) {
      if (n === undefined) { bank = state.bank; n = state.selected; }
      loadPadFile(bytes, f.name, bank, n);
    } else if (/\.(wav|aif|aiff|mp3|flac|ogg|m4a)$/.test(lower) || f.type.startsWith("audio/")) {
      if (n === undefined) { bank = state.bank; n = state.selected; }
      await loadAudio(bytes, f.name, bank, n);
    }
    else note(`${f.name}: unknown file type.`, "err");
  }
}

// ---------- sample sets (stored as "projects") ----------
const projName = () => ($("proj-name").value.trim() || "my_sample_set").slice(0, 40);
let savedSnapshot = null;           // what the last save or open contained, to tell "unsaved"

function projectSignature() {
  const pend = Object.entries(state.pending).map(([k, p]) => `${k}:${p.id}:${p.start}:${p.end}:${p.grade}:${JSON.stringify(p.settings)}`).join("|");
  let h = 0;
  if (state.work) {
    const img = state.work.img, P = SM.PAGE;
    for (let i = 0; i < img.length; i += 97) h = (h * 31 + img[i]) | 0;
    for (const page of [SM.PPB, (SM.BACKUP_BLOCK + 62) * SM.PPB])        // the two pad tables, every byte
      for (let i = page * P; i < page * P + P; i++) h = (h * 31 + img[i]) | 0;
  }
  return `${h}#${pend}`;
}
function renderProject() {
  const unsaved = savedSnapshot !== projectSignature() && (state.work || Object.keys(state.pending).length);
  $("proj-state").textContent = unsaved ? "● unsaved changes" : savedSnapshot ? "saved" : "";
}

async function saveProject() {
  if (!state.work && !Object.keys(state.pending).length) { note("Nothing to save yet: READ the card, open a card image, or drop audio files.", "err"); return; }
  const name = projName();
  try {
    const bytes = Project.save(state, name);
    await Project.put(name, bytes);
    savedSnapshot = projectSignature();
    log(`sample set "${name}" saved in this browser (${(bytes.length / 1048576).toFixed(1)} MB)`, "info");
    note(`Sample set "${name}" saved in this browser. EXPORT FILE makes a copy you can keep.`, "ok");
  } catch (e) {
    log(`sample set not saved: ${e.message}`, "err");
    note(`Sample set not saved: ${e.message}. EXPORT FILE keeps it as a file.`, "err");
  }
  renderProject();
}

function exportProject() {
  if (!state.work && !Object.keys(state.pending).length) { note("Nothing to export yet.", "err"); return; }
  const name = projName();
  download(Project.save(state, name), `${name.replace(/[^\w -]+/g, "_")}.smartmare`);
  savedSnapshot = projectSignature();
  renderProject();
}

async function saveSetToCard() {
  if (!state.work && !Object.keys(state.pending).length) { note("Nothing to save yet: READ CARD, open a card image, or drop audio files.", "err"); return; }
  const name = projName(), link = state.link;
  state.busy = true;
  renderButtons();
  try {
    display("SEt", "SAVING THE SET");
    const bytes = Project.save(state, name, true);
    log(`saving sample set "${name}" on the card (${(bytes.length / 1048576).toFixed(2)} MB)`, "info");
    await link.saveSet(name, bytes, (n, t) => display(String(Math.round(100 * n / t)).padStart(3, " ").slice(-3), `SAVING SET ${Math.round(100 * n / t)}%`));
    savedSnapshot = projectSignature();
    log(`sample set "${name}" saved on the card`, "info");
    note(`Sample set "${name}" saved on the card. It goes wherever the card goes.`, "ok");
  } catch (e) {
    log(`set not saved on the card: ${e.message}`, "err");
    note(`Not saved on the card: ${e.message}`, "err");
  } finally {
    state.busy = false;
    render();
  }
}

async function openProjectBytes(bytes, label) {
  try { bytes = await Project.gunzip(bytes); } catch (e) { note(`${label}: ${e.message}`, "err"); return; }
  if ((dirtyBlocks().length || Object.keys(state.pending).length) && savedSnapshot !== projectSignature() &&
      !await ask("Open the sample set?", "<p>The work in the page that is not saved will be replaced.</p>", "OPEN")) return;
  try {
    const p = Project.load(bytes);
    Audio202.stop();
    state.work = p.image;
    state.pending = p.pending;
    if (p.names) { Object.assign(padNames, p.names); try { localStorage.setItem(NAMES_KEY, JSON.stringify(padNames)); } catch (e) {} }
    state.bank = p.bank;
    state.selected = p.selected;
    state.source = `sample set ${p.name}`;
    state.editorKey = null;
    $("proj-name").value = p.name;
    savedSnapshot = projectSignature();
    log(`sample set "${p.name}" opened (${label})`, "info");
    note(state.base ? `Sample set "${p.name}" opened. WRITE CARD sends what differs from the card.` : `Sample set "${p.name}" opened.`, "ok");
    imageChecks();
    render();
  } catch (e) {
    note(`${label}: ${e.message}`, "err");
  }
}

async function showProjects() {
  const dlg = $("projects");
  const cardEl = $("set-card-list"), freeEl = $("set-card-free");
  const fillCard = async () => {
    const link = state.link, powered = state.info?.powered === true;
    if (!link) { cardEl.innerHTML = '<p class="hint">CONNECT the card to see the sets kept on it.</p>'; return; }
    if (powered) { cardEl.innerHTML = '<p class="hint">Switch the SP-202 off to see the sets on the card.</p>'; return; }
    cardEl.innerHTML = '<p class="hint">Reading…</p>';
    let r;
    try { r = await link.listSets(); } catch (e) { cardEl.innerHTML = `<p class="hint">Cannot list the sets: ${e.message}. An older firmware has no set store.</p>`; return; }
    freeEl.textContent = `${(r.free / 1048576).toFixed(1)} MB free of ${(r.capacity / 1048576).toFixed(1)} MB`;
    if (!r.sets.length) { cardEl.innerHTML = '<p class="hint">No set on the card yet. Name your pads and press SAVE SET TO CARD.</p>'; return; }
    cardEl.innerHTML = "";
    for (const it of r.sets) {
      const row = document.createElement("div");
      row.className = "proj-row";
      row.innerHTML = `<div><b></b><span>${it.stamp ? new Date(it.stamp * 1000).toLocaleString([], { timeZone: "UTC" }) + " · " : ""}${(it.length / 1048576).toFixed(2)} MB</span></div>
        <button class="key small act" data-a="open">OPEN</button><button class="key small act" data-a="del">DELETE</button>`;
      row.querySelector("b").textContent = it.name;
      row.querySelector('[data-a="open"]').onclick = async () => {
        dlg.close();
        state.busy = true; renderButtons();
        try {
          const bytes = await link.getSet(it.index, (n, t) => display(String(Math.round(100 * n / t)).padStart(3, " ").slice(-3), `OPENING SET ${Math.round(100 * n / t)}%`));
          state.busy = false;
          await openProjectBytes(bytes, "card");
        } catch (e) { note(`Cannot open "${it.name}": ${e.message}`, "err"); }
        finally { state.busy = false; render(); }
      };
      row.querySelector('[data-a="del"]').onclick = async () => {
        try { await link.deleteSet(it.index); log(`sample set "${it.name}" deleted from the card`); } catch (e) { note(e.message, "err"); }
        fillCard();
      };
      cardEl.appendChild(row);
    }
  };
  dlg.showModal();
  await fillCard();
}

// ---------- dialog ----------
function ask(title, html, okText = "OK") {
  const d = $("dialog");
  $("dlg-title").textContent = title;
  $("dlg-body").innerHTML = html;
  $("dlg-ok").textContent = okText;
  d.showModal();
  return new Promise(res => d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true }));
}

// ---------- events ----------
function bind() {
  $("btn-connect").onclick = () => connect();      // not connect(event): it takes a port
  $("btn-read").onclick = readCard;
  $("btn-write").onclick = writeCard;
  $("btn-open").onclick = () => $("file-open").click();
  $("file-open").onchange = async e => { const f = e.target.files[0]; if (f) openImage(new Uint8Array(await f.arrayBuffer()), f.name); e.target.value = ""; };
  $("btn-save").onclick = () => { state.work.finalize(); download(state.work.img, `${projName()}-card-backup-${new Date().toISOString().slice(0, 10)}.img`); };
  $("btn-export").onclick = () => { const s = selectedEntry(); if (s && !s.e.empty) download(SM.padFile(s.sp, s.e), `${s.e.name}.sp202pad`); };
  $("btn-import").onclick = () => $("file-pad").click();
  $("file-pad").onchange = async e => { const f = e.target.files[0]; if (f) await dropFiles([f], state.bank, state.selected); e.target.value = ""; };
  $("btn-clear").onclick = async () => {
    const pname = state.bank + (state.selected + 1);
    if (state.pending[pname]) {
      Audio202.stop();
      delete state.pending[pname];
      log(`${pname}: audio file removed`);
      render();
      return;
    }
    const s = selectedEntry();
    if (!s || s.e.empty) return;
    if (!await ask(`Clear ${s.e.name}?`, "<p>The sample is removed and the following samples are packed down, as the SP-202 does. Nothing changes on the card until WRITE CARD.</p>", "CLEAR")) return;
    s.sp.clear(s.e.index);
    edited(`${s.e.name} cleared`);
  };
  $("btn-set-card").onclick = saveSetToCard;
  $("btn-erase-all").onclick = eraseCard;
  bindFirmware();
  $("btn-bk-export").onclick = exportBackup;
  $("btn-bk-import").onclick = () => $("file-backup").click();
  $("file-backup").onchange = async e => { const f = e.target.files[0]; if (f) importBackup(new Uint8Array(await f.arrayBuffer()), f.name); e.target.value = ""; };
  $("btn-proj-open").onclick = showProjects;
  $("proj-close").onclick = () => $("projects").close();
  $("proj-name").addEventListener("keydown", e => e.stopPropagation());
  for (const db of [$("editor"), $("pad-info")]) {     // the pad settings, CHANNELS and BPM
    db.addEventListener("click", e => {
      const b = e.target.closest("button[data-set]");
      if (b) applySetting(b.dataset.set, +b.dataset.v);
    });
    db.addEventListener("change", e => {
      const t = e.target.closest("select[data-set], input[data-set]");
      if (t) applySetting(t.dataset.set, +t.value);
    });
    db.addEventListener("input", e => {
      if (e.target.matches('input[data-set="level"]')) e.target.nextElementSibling.textContent = e.target.value;
    });
  }
  $("btn-status").onclick = () => state.link?.send("s");
  $("btn-loglevel").onclick = () => state.link?.send("v");
  $("btn-logclear").onclick = () => { $("log").innerHTML = ""; };

  document.querySelectorAll(".bank").forEach(b => {
    b.onclick = () => { state.bank = b.dataset.bank; render(); };
    // while a pad is dragged, holding it over a bank button opens that bank (copy C1 to A1)
    b.addEventListener("dragover", e => {
      if (!e.dataTransfer.types.includes("application/x-sp202-pad")) return;
      e.preventDefault();
      if (state.bank !== b.dataset.bank) { state.bank = b.dataset.bank; renderPads(); }
    });
  });

  $("area-row").addEventListener("click", e => {
    const b = e.target.closest("[data-area]");
    if (!b) return;
    state.area = +b.dataset.area;
    if (!isInternal(state.bank)) state.bank = "A";
    state.editorKey = null;
    log(`banks A/B: backup ${state.area}`);
    render();
  });
  const pads = $("pads");
  const fit = new ResizeObserver(() => { fitPads(); fitLcd(); });
  fit.observe(pads);
  fit.observe(document.querySelector("#editor .lcd"));   // its top line can wrap
  $("mem-info-btn").onclick = () => {
    const open = $("mem-info").hidden;
    $("mem-info").hidden = !open;
    $("mem-info-btn").setAttribute("aria-expanded", String(open));
  };
  // press = sound (as on the SP-202), release = the end of a GATE pad; the panels follow on click
  pads.addEventListener("pointerdown", e => {
    const p = e.target.closest(".pad");
    if (!p || e.button !== 0) return;
    pads.querySelectorAll(".pad.selected").forEach(x => x.classList.remove("selected"));
    p.classList.add("selected");
    padDown(+p.dataset.n);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"])
    pads.addEventListener(ev, e => { const p = e.target.closest(".pad"); if (p) padUp(+p.dataset.n); }, true);
  pads.addEventListener("click", e => {
    const p = e.target.closest(".pad");
    if (!p) return;
    state.selected = +p.dataset.n;
    render();
  });
  pads.addEventListener("contextmenu", e => {
    const p = e.target.closest(".pad");
    if (!p) return;
    e.preventDefault();
    padMenu(+p.dataset.n, e.clientX, e.clientY);
  });
  $("pad-menu").addEventListener("click", e => {
    const b = e.target.closest("[data-m]");
    if (!b || b.disabled) return;
    $("pad-menu").hidden = true;
    const s = selectedEntry();
    if (b.dataset.m === "load") $("file-pad").click();
    else if (s && !s.e.empty && b.dataset.m === "wav") exportPadWav(s.sp, s.e);
    else if (s && !s.e.empty && b.dataset.m === "pad") $("btn-export").click();
    else if (s && !s.e.empty && b.dataset.m === "clear") $("btn-clear").click();
  });
  window.addEventListener("pointerdown", e => { if (!e.target.closest("#pad-menu")) $("pad-menu").hidden = true; });
  window.addEventListener("keydown", e => {
    if (e.target.closest?.("input, select, textarea, dialog") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") $("pad-menu").hidden = true;
    if (e.key >= "1" && e.key <= "8") {
      if (e.repeat) return;
      state.selected = +e.key - 1;
      render();
      padDown(state.selected);
    } else if (e.key === " ") { e.preventDefault(); Audio202.stop(); held = null; }
  });
  window.addEventListener("keyup", e => { if (e.key >= "1" && e.key <= "8") padUp(+e.key - 1); });
  pads.addEventListener("dragstart", e => {
    const p = e.target.closest(".pad");
    if (!p) return;
    e.dataTransfer.setData("application/x-sp202-pad", JSON.stringify({ bank: state.bank, n: +p.dataset.n }));
    e.dataTransfer.effectAllowed = "copy";
  });
  pads.addEventListener("dragover", e => {
    const p = e.target.closest(".pad");
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    $("dropzone").classList.remove("on");
    document.querySelectorAll(".pad.drop").forEach(x => x !== p && x.classList.remove("drop"));
    p.classList.add("drop");
  });
  pads.addEventListener("dragleave", e => { const p = e.target.closest(".pad"); if (p && !p.contains(e.relatedTarget)) p.classList.remove("drop"); });
  pads.addEventListener("drop", async e => {
    const p = e.target.closest(".pad");
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    p.classList.remove("drop");
    $("dropzone").classList.remove("on");
    const n = +p.dataset.n;
    const internal = e.dataTransfer.getData("application/x-sp202-pad");
    if (internal) {
      const from = JSON.parse(internal);
      if (from.bank === state.bank && from.n === n) return;
      const src = spaceOf(from.bank), dst = spaceOf(state.bank);
      if (!dst.present()) { note(`Bank ${state.bank} is not on the image.`, "err"); return; }
      const e0 = src.entry(indexOf(from.bank, from.n));
      try {
        dst.put(indexOf(state.bank, n), e0.raw, src.sample(e0));
        state.selected = n;
        edited(`${from.bank}${from.n + 1} copied to ${state.bank}${n + 1}`);
        note(`${from.bank}${from.n + 1} copied to ${state.bank}${n + 1}. Press WRITE CARD.`, "ok");
      } catch (err) { note(err.message, "err"); }
    } else if (e.dataTransfer.files.length) await dropFiles(e.dataTransfer.files, state.bank, n);
  });

  // files dropped anywhere else
  let depth = 0;
  window.addEventListener("dragenter", e => { if (e.dataTransfer.types.includes("Files")) { depth++; $("dropzone").classList.add("on"); } });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("dropzone").classList.remove("on"); } });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", async e => {
    e.preventDefault();
    depth = 0;
    $("dropzone").classList.remove("on");
    document.querySelectorAll(".pad.drop").forEach(x => x.classList.remove("drop"));
    if (e.dataTransfer.files.length) await dropFiles(e.dataTransfer.files);
  });
  window.addEventListener("beforeunload", e => { if (dirtyBlocks().length || Object.keys(state.pending).length) { e.preventDefault(); e.returnValue = ""; } });
}

async function start() {
  editor = new WaveEditor($("editor"), onEditorChange);
  editor.onLoad = src => src.kind === "marks" ? resamplePad(src) : commitPending(src.pad);
  editor.onTruncate = truncatePad;
  editor.onSaveWav = async src => {           // what ▶ AS SP-202 plays: START–STOP, the quality, at 31.25 kHz
    const s = await editor.sound202();
    if (!s) return;
    const [l, r] = s.chans.map(c => Audio202.toSP202(c, s.rate));
    download(wavFile(l.data, l.rate, r && r.data),
      `${src.fileName.replace(/\.[^.]+$/, "")}-${SM.SHORT[src.grade].toLowerCase()}.wav`);
    log(`${src.fileName}: exported START–STOP as ${SM.GRADES[src.grade]}${r ? " STEREO" : ""}, ${(l.data.length / l.rate).toFixed(2)} s at ${l.rate} Hz`, "info");
  };
  bind();
  renderChecks();
  if (CardLink.supported()) check("browser", "ok", "Web Serial available");
  else {
    check("browser", "fail", "use Chrome, Edge, Opera or Brave on a computer (Firefox and Safari cannot open USB serial ports)");
    note(NO_SERIAL, "err");
  }
  check("usb", "wait", "press CONNECT and pick the card");
  render();
  log("ready. CONNECT the card (SP-202 off to read or write), or open a sample set or a card image.", "info");
  // For tests from a local server: ?img=<url of an image file>
  const url = new URLSearchParams(location.search).get("img");
  if (url) {
    try { openImage(new Uint8Array(await (await fetch(url)).arrayBuffer()), url.split("/").pop()); }
    catch (e) { log(`${url}: ${e.message}`, "err"); }
  }
}

start();
