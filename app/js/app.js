/*
 * SmartMare 5V - SP-202 loader page: pads, trims, sample sets, card read and write
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.0.0 - 2 Nov 2026
 * SPDX-License-Identifier: MIT
 */
/* SmartMare Pad Editor: the page. Card model in card.js, USB in serial.js. */
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
  if (label !== undefined) $("display-label").textContent = label;
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
    check("backup", issues.length ? "warn" : "ok", issues.length ? issues.join("; ") : `present: ${bk.used().length} internal pads saved`);
  } else check("backup", "warn", "none on the card. On the SP-202: CANCEL + BANK CARD C/D, then REC, to save banks A/B here");
}

// ---------- spaces and pads ----------
const isInternal = bank => bank === "A" || bank === "B";
function spaceOf(bank) { return state.work ? new SM.Space(state.work, isInternal(bank) ? "backup" : "card") : null; }
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

function fmtSeconds(s) { return s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s.toFixed(2)} s`; }
function hex(n, w = 6) { return "0x" + n.toString(16).toUpperCase().padStart(w, "0"); }

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
      info = `<span class="sname"></span><span class="grade">WAV → ${SM.SHORT[pend.grade]}</span><br>${fmtSeconds(sec)} · PENDING`;
      names[n] = pend.fileName.replace(/\.[^.]+$/, "");
    } else if (present) {
      const e = sp.entry(indexOf(state.bank, n));
      if (!e.empty) {
        empty = false;
        names[n] = nameOf(sp, e);
        info = `<span class="sname"></span><span class="grade">${SM.SHORT[e.grade]}</span>${e.stereo ? ' <span class="st">ST</span>' : ""} · ${e.gate ? "GATE" : "TRIG"} · ${e.oneShot ? "1SHOT" : "LOOP"}${e.effect ? ` · <span class="fx">${({ "RING MOD": "RING", "FILTER 1": "FLT1", "FILTER 2": "FLT2" })[e.effect] || "FX"}</span>` : ""}<br>${fmtSeconds(e.seconds)} · ${e.bpm} BPM${e.marked ? " · MARK" : ""}`;
      } else info = "EMPTY";
    } else info = state.work ? (isInternal(state.bank) ? "NO BACKUP" : "NOT FORMATTED") : "—";
    html.push(`<div class="pad${empty ? " empty" : ""}${pend ? " pending" : ""}${n === state.selected ? " selected" : ""}" data-n="${n}" draggable="${!empty && !pend}">
      <div class="pad-top"><span class="pad-name">${name}</span><span class="led${empty ? "" : " on"}"></span></div>
      <div class="pad-info">${info}</div></div>`);
  }
  $("pads").innerHTML = html.join("");
  $("pads").querySelectorAll(".sname").forEach(el => {
    const t = names[+el.closest(".pad").dataset.n];
    if (t) { el.textContent = t; el.title = t; } else el.remove();
  });
  document.querySelectorAll(".bank").forEach(b => {
    b.classList.toggle("active", b.dataset.bank === state.bank);
    const s = spaceOf(b.dataset.bank);
    b.classList.toggle("absent", !!state.work && !(s && s.present()));
  });
  // memory meter
  if (present) {
    const total = sp.dataEnd - sp.dataStart, free = sp.freeBytes();
    $("mem-bar").style.width = `${(100 * (total - free) / total).toFixed(1)}%`;
    $("mem-text").textContent = `${fmtSeconds(free * 2 / SM.RATES[0])} free HI-FI`;
  } else { $("mem-bar").style.width = "0"; $("mem-text").textContent = ""; }
}

function selectedEntry() {
  const sp = spaceOf(state.bank);
  if (!sp || !sp.present()) return null;
  return { sp, e: sp.entry(indexOf(state.bank, state.selected)) };
}

const EFFECTS = [[0x00, "NONE"], [0x04, "RING MOD"], [0x08, "FILTER 2"], [0x10, "FILTER 1"]];
const DEFAULT_SETTINGS = { gate: false, oneShot: false, effect: 0, level: 127, stereo: false };

// The pad settings the SP-202 keeps on the card, as controls (entry) or for a waiting
// audio file (pending, used when it is written).
function settingsHtml(v, opts) {
  const seg = (key, a, b, on) =>
    `<div class="seg"><button type="button" data-set="${key}" data-v="0" class="${on ? "" : "on"}">${a}</button>` +
    `<button type="button" data-set="${key}" data-v="1" class="${on ? "on" : ""}">${b}</button></div>`;
  const fx = EFFECTS.map(([k, n]) => `<option value="${k}"${k === v.effect ? " selected" : ""}>${n}</option>`).join("");
  return `<div class="settings">
    <div class="set-row"><span class="silk">PLAY</span>${seg("gate", "TRIGGER", "GATE", v.gate)}</div>
    <div class="set-row"><span class="silk">MODE</span>${seg("oneShot", "LOOP", "ONE SHOT", v.oneShot)}</div>
    <div class="set-row"><span class="silk">EFFECT</span><select data-set="effect"${v.stereo ? " disabled" : ""}>${fx}</select>
      ${v.stereo ? '<span class="set-note">no effect on stereo pads</span>' : ""}</div>
    <div class="set-row"><span class="silk">FX LEVEL</span><input type="range" min="0" max="127" value="${v.level}" data-set="level"
      ${v.stereo || !v.effect ? "disabled" : ""}><b class="lvl">${v.level}</b></div>
    <div class="set-row"><span class="silk">QUALITY</span><span>${opts.quality}</span></div>
    <div class="set-row"><span class="silk">CHANNELS</span><span>${opts.channels}</span></div>
  </div>`;
}

function renderDetail() {
  const s = selectedEntry(), body = $("detail-body");
  const name = state.bank + (state.selected + 1);
  $("detail-title").textContent = `PAD ${name}`;
  let bpm = "---";
  const pend = state.pending[name];
  if (pend) {
    const set = pend.settings;
    const sec = (pend.end - pend.start) / pend.rate;
    const bytes = Math.ceil(sec * SM.RATES[pend.grade] / 2) * (set.stereo ? 2 : 1);
    const gradeSel = `<select data-set="grade">${SM.GRADES.map((g, i) => `<option value="${i}"${i === pend.grade ? " selected" : ""}>${g}</option>`).join("")}</select>`;
    const chanSel = pend.chans.length > 1
      ? `<div class="seg"><button type="button" data-set="stereo" data-v="0" class="${set.stereo ? "" : "on"}">MONO</button><button type="button" data-set="stereo" data-v="1" class="${set.stereo ? "on" : ""}">STEREO</button></div>`
      : "MONO (the file is mono)";
    body.innerHTML = `<table>
      <tr><td>PAD</td><td>${name} · audio file waiting</td></tr>
      <tr><td>FILE</td><td class="fname"></td></tr>
      <tr><td>LENGTH</td><td>${fmtSeconds(sec)} · about ${bytes.toLocaleString()} bytes on the card</td></tr>
      <tr><td>BPM</td><td>${sp202Bpm(bytes, pend.grade, set.stereo)}</td></tr>
    </table>` + settingsHtml({ ...set }, { quality: gradeSel, channels: chanSel }) +
      `<p class="hint">LOAD TO PAD (in the sound editor) or WRITE CARD encodes it for the SP-202 with these settings.</p>`;
    body.querySelector(".fname").textContent = pend.fileName;
  } else if (!s) {
    body.innerHTML = `<p class="hint">${state.work ? "This bank is not on the image." : "Connect the card and READ it, or open a sample set or a card backup."}</p>`;
  } else if (s.e.empty) {
    body.innerHTML = `<table><tr><td>PAD</td><td>${name} · empty</td></tr></table><p class="hint">Drop an audio file or a pad file here, or drag another pad onto it.</p>`;
  } else {
    const e = s.e;
    bpm = String(e.bpm);
    body.innerHTML = `<table>
      <tr><td>PAD</td><td>${name}${isInternal(state.bank) ? " (internal, via BACKUP)" : ""}</td></tr>
      <tr><td>NAME</td><td class="sample-name"></td></tr>
      <tr><td>LENGTH</td><td>${fmtSeconds(e.seconds)} · ${e.length.toLocaleString()} bytes</td></tr>
      <tr><td>BPM</td><td>${e.bpm} (recorded at ${e.bpmRec})</td></tr>
      <tr><td>START / END</td><td>${e.marked ? `${e.playStart.toLocaleString()} → ${e.playEnd.toLocaleString()}` : "whole sample"}</td></tr>
    </table>` + settingsHtml({ gate: e.gate, oneShot: e.oneShot, effect: e.raw[1], level: e.raw[8], stereo: e.stereo },
      { quality: `${SM.GRADES[e.grade]} · ${e.rate} Hz <span class="set-note">set when recorded</span>`,
        channels: `${e.stereo ? "STEREO" : "MONO"} <span class="set-note">set when recorded</span>` }) +
      `<details class="raw-box"><summary>Entry bytes</summary><div class="raw">${[...e.raw].map(b => b.toString(16).padStart(2, "0")).join(" ")}</div>
       <div class="set-note">address ${hex(e.start)} · byte 7 = ${e.raw[7].toString(16)} (not decoded yet)</div></details>`;
    body.querySelector(".sample-name").textContent = nameOf(s.sp, e) || "— (recorded on the SP-202)";
  }
  const has = !!(s && !s.e.empty) && !pend;
  $("btn-export").disabled = !has;
  $("btn-wav").disabled = !has;
  $("btn-clear").disabled = !has && !pend;
  $("btn-import").disabled = !s;
  if (!state.busy) {
    if (pend) display(SM.SHORT[pend.grade] === "HI-FI" ? "HiF" : SM.SHORT[pend.grade] === "STD" ? "Std" : "L-F", `${name} · AUDIO FILE`);
    else display(s ? (has ? bpm : "---") : (state.link ? "Con" : "---"), s ? `${name} · ${has ? "BPM" : "EMPTY"}` : (state.link ? "CONNECTED" : "READY"));
  }
}

// A setting changed in the PAD panel: written into the pad entry (card pads) or kept with
// the waiting audio file.
function applySetting(key, value) {
  const name = state.bank + (state.selected + 1), pend = state.pending[name];
  if (pend) {
    if (key === "grade") { pend.grade = value; delete pend.cache; editor && syncEditor(true); }
    else pend.settings[key] = key === "effect" || key === "level" ? value : !!value;
    if (pend.settings.stereo) pend.settings.effect = 0;
    log(`${name}: ${key} ${value} (waiting audio file)`);
    render();
    return;
  }
  const s = selectedEntry();
  if (!s || s.e.empty) return;
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
  $("btn-revert").disabled = !state.base || !dirty || state.busy;
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

function render() { renderPads(); renderDetail(); renderButtons(); syncEditor(); renderProject(); renderBackup(); renderFirmware(); }

// ---------- the BACKUP section ----------
const BK_FIRST = SM.BACKUP_BLOCK, BK_BYTES = (SM.BLOCKS - SM.BACKUP_BLOCK) * SM.BLOCK_BYTES;
function renderBackup() {
  const el = $("backup-status"), bk = state.work ? new SM.Space(state.work, "backup") : null;
  if (!bk) el.innerHTML = "READ CARD (or open a sample set or a card backup) to see the backup bank.";
  else if (!bk.present()) el.innerHTML = '<span class="bad">No backup on this card.</span> Do step 1 on the SP-202, then READ CARD.';
  else {
    const used = bk.used();
    el.innerHTML = `<b>Backup present</b> · ${used.length} pad${used.length === 1 ? "" : "s"} (${used.map(e => e.name).join(", ") || "none"})
      · ${fmtSeconds(bk.freeBytes() * 2 / SM.RATES[0])} free in HI-FI`;
  }
  $("btn-bk-export").disabled = !(bk && bk.present());
  $("btn-bk-import").disabled = !state.work;
}

function exportBackup() {
  state.work.finalize();
  download(state.work.img.slice(BK_FIRST * SM.BLOCK_BYTES), `${projName()}-backup.sp202bak`);
}

function importBackup(bytes, name) {
  if (bytes.length !== BK_BYTES) { note(`${name}: not an SP-202 backup (${BK_BYTES.toLocaleString()} bytes expected).`, "err"); return; }
  const probe = new SM.Image();
  probe.img.set(bytes, BK_FIRST * SM.BLOCK_BYTES);
  if (!new SM.Space(probe, "backup").present()) { note(`${name}: no SP-202 backup inside.`, "err"); return; }
  state.work.img.set(bytes, BK_FIRST * SM.BLOCK_BYTES);
  state.editorKey = null;
  edited(`backup replaced by ${name}`);
  imageChecks();
  note("Backup replaced. WRITE CARD, then LOAD on the SP-202 to put it in banks A/B.", "ok");
}

// ---------- the trim screen ----------
const be32put = (a, o, v) => { a[o] = v >>> 24; a[o + 1] = (v >>> 16) & 255; a[o + 2] = (v >>> 8) & 255; a[o + 3] = v & 255; };
const MARK_ALIGN = 16;     // the SP-202's own marks are multiples of 16 bytes (32 samples mono)

// The BPM the SP-202 shows for a pad: the part between the marks taken as 8, 4, 2 or 1
// beats, the most beats that stay at or under 200 BPM (fits all 16 pads seen).
function sp202Bpm(bytes, grade, stereo) {
  const sec = bytes * 2 / (stereo ? 2 : 1) / SM.RATES[grade];
  let bpm = 0;
  for (const beats of [8, 4, 2, 1]) { bpm = 60 * beats / sec; if (bpm <= 200) break; }
  return Math.max(1, Math.min(255, Math.round(bpm)));
}

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
  else if (e) editor.load({
    kind: "marks", title: `${name} · ${SM.GRADES[e.grade]} ${e.stereo ? "ST" : "MONO"} · ${isInternal(state.bank) ? "INTERNAL" : "CARD"}`,
    total: e.length, start: e.playStart, end: e.playEnd || e.length, grade: e.grade, stereo: e.stereo,
    align: MARK_ALIGN, editable: true, pad: { bank: state.bank, index: e.index },
    ...(() => {
      const p = padSound(s.sp, e);
      const mix = p.r ? p.l.map((v, i) => (v + p.r[i]) / 2) : p.l;
      return { data: mix, lr: p.r ? [p.l, p.r] : null, spb: p.spb };
    })(), rate: e.rate, fileName: name,
    info: "MARKS · THEN WRITE CARD",
  });
  else editor.load({ kind: "none", title: `${name} · EMPTY`, info: s ? "DROP AN AUDIO FILE ON THIS PAD" : "NO PAD TABLE: READ THE CARD OR OPEN AN IMAGE" });
}

function onEditorChange(src) {
  if (src.kind === "marks") {
    const sp = spaceOf(src.pad.bank), e = sp.entry(src.pad.index);
    const r = Uint8Array.from(e.raw);
    be32put(r, 18, src.start);
    be32put(r, 22, src.end);
    r[2] = sp202Bpm(src.end - src.start, e.grade, e.stereo);
    sp.writeEntry(src.pad.index, r);
    state.work.finalize();
    state.editorKey = `e:${e.name}:${e.start}:${e.length}:${state.source}`;
    renderPads(); renderDetail(); renderButtons();
  } else {
    delete src.cache;
    renderPads(); renderDetail();
  }
}

// Plays a pad like a sampler: an audio file at its grade, START to END.
async function trigger(n) {
  const name = state.bank + (n + 1), pend = state.pending[name];
  const el = $("pads").querySelector(`[data-n="${n}"]`);
  if (!pend) {
    const s = spaceOf(state.bank), e = s && s.present() ? s.entry(indexOf(state.bank, n)) : null;
    if (!e || e.empty) return;
    const snd = padSound(s, e);
    document.querySelectorAll(".pad.playing").forEach(x => x.classList.remove("playing"));
    const p = Audio202.play(snd.l, e.rate, e.playStart * snd.spb, (e.playEnd || e.length) * snd.spb, false,
                            () => el?.classList.remove("playing"), snd.r);
    if (editor?.src?.kind === "marks" && editor.src.pad.index === e.index && editor.src.pad.bank === state.bank) p.source = editor.src;
    el?.classList.add("playing");
    return;
  }
  const rate = SM.RATES[pend.grade];
  const key = `${pend.grade}:${pend.start}:${pend.end}`;
  if (!pend.cache || pend.cache.key !== key)
    pend.cache = { key, data: await Audio202.resample(pend.data.subarray(Math.floor(pend.start), Math.floor(pend.end)), pend.rate, rate) };
  document.querySelectorAll(".pad.playing").forEach(x => x.classList.remove("playing"));
  Audio202.play(pend.cache.data, rate, 0, pend.cache.data.length, false, () => el?.classList.remove("playing"));
  el?.classList.add("playing");
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
    note(`${fileName} is on ${name}, waiting. Trim it below, then LOAD TO PAD or WRITE CARD.`, "ok");
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
  const rate = SM.RATES[pend.grade], set = pend.settings;
  const stereo = !!set.stereo && pend.chans.length > 1;
  const cut = d => d.subarray(Math.floor(pend.start), Math.floor(pend.end));
  const parts = [];
  for (const d of stereo ? pend.chans.slice(0, 2) : [pend.data]) parts.push(Float32Array.from(await Audio202.resample(cut(d), pend.rate, rate)));
  let peak = 0;
  for (const p of parts) for (const v of p) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? NORMAL_PEAK / peak : 1;               // the same for both channels
  for (const p of parts) for (let i = 0; i < p.length; i++) p[i] *= gain;
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
  log(`${name}: ${pend.fileName} encoded (${SM.GRADES[pend.grade]}${stereo ? " STEREO" : ""}, ${data.length.toLocaleString()} bytes, level ${(20 * Math.log10(gain)).toFixed(1)} dB, ${(performance.now() - t0).toFixed(0)} ms)`
      + (clipped ? `, ${clipped} samples clipped: the file is louder than the SP-202's full scale` : ""), clipped ? "warn" : "info");
  if (pend.grade) log(`${name}: ${SM.GRADES[pend.grade]} is encoded like HI-FI at its own rate; only HI-FI was checked on the SP-202`, "warn");
  edited(`${name} ready to write`);
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
          : "this firmware cannot write: load the latest smartmedia_5v_sp-202 firmware");
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
          : `no errors · ${(h.reads ?? 0).toLocaleString()} bytes read by the SP-202 checked`);
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

async function connect() {
  if (state.link) { await state.link.disconnect(); return; }
  if (!CardLink.supported()) { log(NO_SERIAL, "err"); note(NO_SERIAL, "err"); return; }
  const link = new CardLink({ onLine, onInfo, onClose });
  try {
    await link.connect();
  } catch (e) {
    if (e.name !== "NotFoundError") log(`connection failed: ${e.message}`, "err");
    return;
  }
  state.link = link;
  $("led-usb").className = "led on";
  check("usb", "ok", "USB serial open (Raspberry Pi RP2350)");
  log("card connected", "info");
  display("Con", "CONNECTED");
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
    if (!state.base) {
      log("reading the card first, to send only what changes", "info");
      display("rd", "READING");
      state.base = await link.dump(p => display(String(Math.min(99, Math.round(100 * p / 2600))), `READING ${p} PAGES`));
    }
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
     <p>To keep something, SAVE CARD BACKUP or copy the sample sets from the SMARTMARE drive first.</p>
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
    else if (lower.endsWith(".sp202bak")) { if (state.work) importBackup(bytes, f.name); else note("Read the card or open a card backup first.", "err"); }
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
  if (!state.work && !Object.keys(state.pending).length) { note("Nothing to save yet: READ the card, open a card backup, or drop audio files.", "err"); return; }
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
  if (!state.work && !Object.keys(state.pending).length) { note("Nothing to save yet: READ CARD, open a card backup, or drop audio files.", "err"); return; }
  const name = projName(), link = state.link;
  state.busy = true;
  renderButtons();
  try {
    display("SEt", "SAVING THE SET");
    const bytes = await Project.gzip(Project.save(state, name));
    log(`saving sample set "${name}" on the card (${(bytes.length / 1048576).toFixed(2)} MB compressed)`, "info");
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
        <button class="key small" data-a="open">OPEN</button><button class="key small danger" data-a="del">DELETE</button>`;
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
  $("btn-connect").onclick = connect;
  $("btn-read").onclick = readCard;
  $("btn-write").onclick = writeCard;
  $("btn-open").onclick = () => $("file-open").click();
  $("file-open").onchange = async e => { const f = e.target.files[0]; if (f) openImage(new Uint8Array(await f.arrayBuffer()), f.name); e.target.value = ""; };
  $("btn-save").onclick = () => { state.work.finalize(); download(state.work.img, `${projName()}-card-backup-${new Date().toISOString().slice(0, 10)}.img`); };
  $("btn-revert").onclick = () => { state.work = state.base.clone(); state.source = "card"; edited("changes undone"); imageChecks(); };
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
  $("btn-wav").onclick = () => {
    const s = selectedEntry();
    if (!s || s.e.empty) return;
    const p = padSound(s.sp, s.e);
    download(wavFile(p.l, s.e.rate, p.r), `${s.e.name}.wav`);
  };
  $("btn-set-card").onclick = saveSetToCard;
  $("btn-erase-all").onclick = eraseCard;
  bindFirmware();
  $("btn-bk-a").onclick = () => { state.bank = "A"; render(); $("sec-pads").scrollIntoView({ behavior: "smooth" }); };
  $("btn-bk-b").onclick = () => { state.bank = "B"; render(); $("sec-pads").scrollIntoView({ behavior: "smooth" }); };
  $("btn-bk-export").onclick = exportBackup;
  $("btn-bk-import").onclick = () => $("file-backup").click();
  $("file-backup").onchange = async e => { const f = e.target.files[0]; if (f) importBackup(new Uint8Array(await f.arrayBuffer()), f.name); e.target.value = ""; };
  $("btn-proj-open").onclick = showProjects;
  $("proj-close").onclick = () => $("projects").close();
  $("proj-name").addEventListener("keydown", e => e.stopPropagation());
  const db = $("detail-body");
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
  $("btn-status").onclick = () => state.link?.send("s");
  $("btn-loglevel").onclick = () => state.link?.send("v");
  $("btn-logclear").onclick = () => { $("log").innerHTML = ""; };

  document.querySelectorAll(".bank").forEach(b => b.onclick = () => { state.bank = b.dataset.bank; render(); });

  const pads = $("pads");
  pads.addEventListener("click", e => {
    const p = e.target.closest(".pad");
    if (!p) return;
    state.selected = +p.dataset.n;
    render();
    trigger(state.selected);
  });
  window.addEventListener("keydown", e => {
    if (e.target.closest?.("input, select, textarea, dialog") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key >= "1" && e.key <= "8") {
      state.selected = +e.key - 1;
      render();
      trigger(state.selected);
    } else if (e.key === " ") { e.preventDefault(); Audio202.stop(); }
  });
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
  editor.onLoad = src => commitPending(src.pad);
  editor.onSaveWav = async src => {
    if (src.kind === "marks") {               // a card pad: START–END of the decoded sound
      const k = src.spb, [l, r] = src.lr || [src.data];
      download(wavFile(l.subarray(src.start * k, src.end * k), src.rate, r && r.subarray(src.start * k, src.end * k)), `${src.fileName}.wav`);
      return;
    }
    const rate = SM.RATES[src.grade];
    const r = await Audio202.resample(src.data.subarray(Math.floor(src.start), Math.floor(src.end)), src.rate, rate);
    download(wavFile(r, rate), `${src.fileName.replace(/\.[^.]+$/, "")}-${SM.SHORT[src.grade].toLowerCase()}.wav`);
  };
  bind();
  renderChecks();
  if (CardLink.supported()) check("browser", "ok", "Web Serial available");
  else {
    check("browser", "fail", "use Chrome, Edge, Opera or Brave on a computer (Firefox and Safari cannot open USB serial ports)");
    note(NO_SERIAL, "err");
  }
  check("usb", "wait", "press CONNECT and pick the card");
  display("202", "READY");
  render();
  display("202", "READY");
  log("ready. CONNECT the card (SP-202 off to read or write), or open a sample set or a card backup.", "info");
  // For tests from a local server: ?img=<url of an image file>
  const url = new URLSearchParams(location.search).get("img");
  if (url) {
    try { openImage(new Uint8Array(await (await fetch(url)).arrayBuffer()), url.split("/").pop()); }
    catch (e) { log(`${url}: ${e.message}`, "err"); }
  }
}

start();
