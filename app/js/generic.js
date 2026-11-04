/*
 * SmartMare 5V - generic loader page: read, back up, restore and erase the card
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.7 - 4 Nov 2026
 * SPDX-License-Identifier: MIT
 *
 * SmartMare Generic Card Manager: the page of the generic card (any device with a 5 V SmartMedia
 * slot). The card as a whole: read it, keep and put back its image, update the firmware,
 * erase it. No pad editing: the device's own format is not known here.
 * Card model in card.js, USB in serial.js, firmware update in firmware.js.
 */
"use strict";

const $ = id => document.getElementById(id);
const state = {
  link: null,
  info: null,
  base: null,          // the image as last read from (or written to) the card
  work: null,          // the image to write: the card's, or a backup opened from a file
  source: "",
  busy: false,
  logLevel: "quiet",
};

// ---------- log, notes, display ----------
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
  const el = $("note");
  el.textContent = text;
  el.style.color = cls === "err" ? "var(--fail)" : cls === "ok" ? "var(--ok)" : "";
}
function display(text, label) {
  Segments.render($("display"), text);
  if (label !== undefined && $("display-label")) $("display-label").textContent = label;
}
function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function ask(title, html, okText = "OK") {
  const d = $("dialog");
  $("dlg-title").textContent = title;
  $("dlg-body").innerHTML = html;
  $("dlg-ok").textContent = okText;
  d.showModal();
  return new Promise(res => d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true }));
}

// ---------- checks ----------
const CHECKS = [
  ["browser", "Browser can talk to USB"],
  ["usb", "Card connected"],
  ["firmware", "Card firmware answers"],
  ["write", "Firmware can write blocks"],
  ["power", "Device power"],
  ["health", "Bus health"],
  ["image", "Card image"],
  ["ecc", "Page checks (ECC)"],
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

// The SmartMedia card information structure (CIS) that every formatted card carries in its
// first good block: the page starts 01 03 D9 01 FF 18.
function cisBlock(img) {
  const sig = [0x01, 0x03, 0xD9, 0x01, 0xFF, 0x18];
  for (let b = 0; b < 16; b++) {
    const o = b * SM.BLOCK_BYTES;
    if (sig.every((v, i) => img.img[o + i] === v)) return b;
  }
  return -1;
}

function imageChecks() {
  const w = state.work;
  if (!w) { check("image", "wait"); check("ecc", "wait"); $("image-info").textContent = "READ CARD to see what the card holds."; return; }
  const used = w.usedBlocks().length, cis = cisBlock(w);
  const what = used === 0 ? "blank: format it in the device"
    : cis >= 0 ? `formatted (card information in block ${cis}), ${used} of ${SM.BLOCKS} blocks used`
    : `${used} of ${SM.BLOCKS} blocks used, no SmartMedia card information found`;
  check("image", used === 0 || cis >= 0 ? "ok" : "warn", `${state.source}: ${what}`);
  const e = w.checkEcc();
  // A device may keep its own spare bytes: a mismatch is worth a look, not an error.
  check("ecc", e.bad.length ? "warn" : "ok", e.bad.length ? `${e.bad.length} of ${e.checked} pages differ from the SmartMedia ECC (first: page ${e.bad[0]})`
                                                       : `${e.checked} pages, all match the SmartMedia ECC`);
  $("image-info").textContent = `${state.source}: ${what}.`;
}

// ---------- buttons ----------
const dirtyBlocks = () => (state.work && state.base ? state.work.diffBlocks(state.base) : []);

function renderButtons() {
  const linked = !!state.link, info = state.info || {};
  const powered = info.powered === true;
  $("btn-connect").innerHTML = `<span class="key-led"></span>${linked ? "DISCONNECT" : "CONNECT"}`;
  $("btn-connect").classList.toggle("lit", linked);
  $("btn-read").disabled = !linked || powered || state.busy || !info.canDump;
  const dirty = dirtyBlocks().length;
  const writable = linked && !powered && !state.busy && info.canWrite && state.work && (dirty > 0 || !state.base);
  $("btn-write").disabled = !writable;
  $("btn-write").classList.toggle("lit", writable);
  $("write-count").textContent = state.base ? (dirty ? `${dirty} BLOCK${dirty > 1 ? "S" : ""}` : "") : (state.work ? "IMAGE" : "");
  $("btn-save").disabled = !state.work;
  $("btn-erase").disabled = !linked || powered || state.busy || !info.canWrite;
  $("btn-status").disabled = !linked;
  $("btn-loglevel").disabled = !linked;
  $("btn-loglevel").textContent = `FW LOG: ${state.logLevel.toUpperCase()}`;
  const cs = $("card-status");
  if (!linked) cs.textContent = state.work ? `Not connected · holding ${state.source}.` : "Not connected. Press CONNECT and pick the SmartMare port.";
  else if (powered) cs.innerHTML = '<span class="bad">The device is powering the card: take the card out, or switch the device off.</span>';
  else if (state.busy) cs.textContent = "Working…";
  else if (!state.base) cs.textContent = "Connected. READ CARD to see what it holds.";
  else cs.textContent = dirty ? `Connected · ${dirty} block${dirty > 1 ? "s" : ""} differ from the card: WRITE CARD puts them on it.` : "Connected · the card holds what you see.";
  renderFirmware();
}
function render() { renderButtons(); imageChecks(); }

// ---------- connection ----------
function onInfo(info) {
  state.info = info;
  check("firmware", info.firmware ? "ok" : "wait", info.banner || "");
  if (info.firmware) {
    check("write", info.canWrite ? "ok" : "fail", info.canWrite ? "D (read) and W (write) available" : "this firmware cannot write");
    if (!info.layoutOk) check("write", "fail", "the firmware overlaps the image area");
  }
  if (info.powered === true) check("power", "warn", `ON (${info.vcc ?? "?"} V): the device is using the card. Take it out to READ or WRITE it.`);
  else if (info.powered === false) check("power", "ok", "off: the card can be read and written");
  const h = info.health;
  if (h) {
    const errs = [h.wrong && `${h.wrong} wrong reads`, h.overflows && `${h.overflows} FIFO overflows`,
                  h.unerased && `${h.unerased} programs over unerased pages`, h.queued && `${h.queued} reads with nothing queued`,
                  h.late && `${h.late} late data changes`].filter(Boolean);
    check("health", errs.length ? "warn" : "ok", errs.length ? errs.join(", ")
          : `no errors · ${(h.reads ?? 0) >= 1048576 ? `${((h.reads ?? 0) / 1048576).toFixed(1)} MB` : `${Math.round((h.reads ?? 0) / 1024)} KB`} read by the device checked`);
    $("led-health").className = "led " + (errs.length ? "amber" : "on");
  }
  $("led-power").className = "led " + (info.powered ? "amber blink" : "");
  renderButtons();
}
function onLine(text, quiet, cls) {
  if (quiet) return;
  const m = text.match(/^log level: (\w+)/);
  if (m) state.logLevel = m[1];
  log(text, /refused|ERROR|!!|ERR /.test(text) ? "err" : cls);
  if (m) renderButtons();
}
function onClose() {
  log("card disconnected", "warn");
  state.link = null;
  state.info = null;
  check("usb", "fail", "disconnected");
  ["firmware", "write", "power", "health"].forEach(id => check(id, "wait"));
  ["led-usb", "led-power", "led-health"].forEach(id => { $(id).className = "led"; });
  render();
}

const NO_SERIAL = "This browser cannot open USB serial ports. Open this page in Chrome or Edge. Firefox and Safari cannot.";

async function connect(port) {
  if (state.link) { if (!port) await state.link.disconnect(); return; }
  if (!CardLink.supported()) { log(NO_SERIAL, "err"); note(NO_SERIAL, "err"); return; }
  const link = new CardLink({ onLine, onInfo, onClose });
  try { await link.connect(port); }
  catch (e) { if (e.name !== "NotFoundError") log(`connection failed: ${e.message}`, "err"); return; }
  state.link = link;
  $("led-usb").className = "led on";
  check("usb", "ok", "USB serial open");
  log("card connected", "info");
  display("Con", "CONNECTED");
  render();
  setTimeout(() => {
    if (state.link === link && !link.info.firmware) check("firmware", "fail", "no answer: is this a SmartMare card?");
  }, 3000);
}

// ---------- read, write, backup ----------
async function readCard() {
  if (dirtyBlocks().length && !await ask("Replace what you hold?", "<p>Reading the card replaces the image in the page.</p>", "READ")) return;
  state.busy = true;
  renderButtons();
  display("rd", "READING");
  const t0 = performance.now();
  try {
    const img = await state.link.dump(p => display(String(Math.min(99, Math.round(100 * p / 8192))), `READING ${p} PAGES`));
    state.base = img;
    state.work = img.clone();
    state.source = "the card";
    log(`card read in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${img.usedBlocks().length} blocks used`, "info");
    note("Card read. SAVE BACKUP keeps a copy (CARD IMAGE).", "ok");
    display("rd", "CARD READ");
  } catch (e) { log(e.message, "err"); note(e.message, "err"); }
  finally { state.busy = false; render(); }
}

async function writeCard() {
  const link = state.link;
  state.busy = true;
  renderButtons();
  try {
    // Always read the card again: the device may have changed it since the last READ CARD, and
    // comparing with an old copy would skip blocks that look unchanged here but are not.
    log("reading the card first, to send what differs from what it really holds", "info");
    display("rd", "READING");
    state.base = await link.dump(p => display(String(Math.min(99, Math.round(100 * p / 8192))), `READING ${p} PAGES`));
    const blocks = dirtyBlocks();
    if (!blocks.length) { note("Nothing to write: the card already holds this image.", "ok"); return; }
    state.busy = false;
    const ok = await ask("Write to the card?", `<p>${blocks.length} block${blocks.length > 1 ? "s" : ""} of the card will be erased and written with ${state.source}.</p>
      <p>Keep the card out of the device until it is done.</p>`, "WRITE");
    state.busy = true;
    if (!ok) return;
    $("btn-write").classList.add("busy");
    const t0 = performance.now();
    await link.writeBlocks(state.work, blocks, (n, total) => display(String(Math.round(100 * n / total)).padStart(3, " ").slice(-3), `WRITING ${n} / ${total}`));
    state.base = state.work.clone();
    state.source = "the card";
    log(`${blocks.length} blocks written and read back in ${((performance.now() - t0) / 1000).toFixed(1)} s`, "info");
    note("Written. The card is ready for the device.", "ok");
  } catch (e) { log(e.message, "err"); note(e.message, "err"); }
  finally { state.busy = false; $("btn-write").classList.remove("busy"); render(); }
}

function openImage(bytes, name) {
  try {
    state.work = new SM.Image(bytes);
    state.source = name;
    log(`opened ${name}`, "info");
    note(state.base ? `${name} opened. WRITE CARD puts it on the card.` : `${name} opened. CONNECT, then WRITE CARD puts it on the card.`, "ok");
    render();
  } catch (e) { note(`${name}: ${e.message}`, "err"); log(`${name}: ${e.message}`, "err"); }
}

// ---------- erase ----------
async function eraseCard() {
  const ok = ask("Erase the card?", `<p>Everything the device stored on the card is erased. It cannot be undone.</p>
     <p>To keep it, SAVE BACKUP (CARD IMAGE) first.</p>
     <p>Type <b>ERASE</b> to confirm:</p><input id="erase-confirm" autocomplete="off" spellcheck="false">`, "ERASE");
  const input = $("erase-confirm"), okBtn = $("dlg-ok");
  okBtn.disabled = true;
  input.addEventListener("input", () => { okBtn.disabled = input.value.trim().toUpperCase() !== "ERASE"; });
  input.focus();
  const go = await ok;
  okBtn.disabled = false;
  if (!go) return;
  state.busy = true;
  renderButtons();
  try {
    display("Er", "ERASING");
    waitBanner("Erasing the card… Keep it connected.");
    await state.link.eraseImage((n, total) => display(String(Math.round(100 * n / total)).padStart(3, " ").slice(-3), `ERASING ${n} / ${total}`));
    log("card erased", "info");
    state.base = new SM.Image();
    state.work = state.base.clone();
    state.source = "the card";
    note("The card is blank. Format it in the device before use.", "ok");
    display("---", "ERASED");
  } catch (e) { log(`erase: ${e.message}`, "err"); note(`Not erased: ${e.message}`, "err"); }
  finally { waitBanner(null); state.busy = false; render(); }
}

// ---------- events ----------
function bind() {
  $("btn-connect").onclick = () => connect();      // not connect(event): it takes a port
  $("btn-read").onclick = readCard;
  $("btn-write").onclick = writeCard;
  $("btn-save").onclick = () => {
    state.work.finalize();
    download(state.work.img, `smartmare-card-${new Date().toISOString().slice(0, 10)}.img`);
  };
  $("btn-open").onclick = () => $("file-open").click();
  $("file-open").onchange = async e => { const f = e.target.files[0]; if (f) openImage(new Uint8Array(await f.arrayBuffer()), f.name); e.target.value = ""; };
  $("btn-erase").onclick = eraseCard;
  $("btn-status").onclick = () => state.link?.send("s");
  $("btn-loglevel").onclick = () => state.link?.send("v");
  $("btn-logclear").onclick = () => { $("log").innerHTML = ""; };
  bindFirmware();

  let depth = 0;
  window.addEventListener("dragenter", e => { if (e.dataTransfer.types.includes("Files")) { depth++; $("dropzone").classList.add("on"); } });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("dropzone").classList.remove("on"); } });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", async e => {
    e.preventDefault();
    depth = 0;
    $("dropzone").classList.remove("on");
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (f.size === SM.IMAGE_BYTES || /\.img$/i.test(f.name)) openImage(new Uint8Array(await f.arrayBuffer()), f.name);
    else note(`${f.name}: not a card image (.img of ${SM.IMAGE_BYTES.toLocaleString()} bytes).`, "err");
  });
  window.addEventListener("beforeunload", e => { if (dirtyBlocks().length) { e.preventDefault(); e.returnValue = ""; } });
}

function start() {
  bind();
  renderChecks();
  if (CardLink.supported()) check("browser", "ok", "Web Serial available");
  else { check("browser", "fail", "use Chrome, Edge, Opera or Brave on a computer"); note(NO_SERIAL, "err"); }
  check("usb", "wait", "press CONNECT and pick the card");
  display("---", "READY");
  render();
  log("ready. CONNECT the card (out of the device) to read it, back it up, update or erase it.", "info");
}

start();
