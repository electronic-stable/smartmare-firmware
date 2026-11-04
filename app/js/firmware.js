/*
 * SmartMare 5V - firmware update from the loader pages
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.1 - 4 Nov 2026
 * SPDX-License-Identifier: MIT
 *
 * Firmware update, shared by the SP-202 Card Manager (app.js) and the generic card's page
 * (generic.js). Uses the page's globals: $, state (link, info, busy), log, ask, download.
 */
"use strict";

// The card restarts in update mode when its port is opened at 1200 baud (no button needed),
// then shows as the RP2350 drive; a UF2 file copied there is the new firmware.
const UF2_FAMILIES = [0xE48BFF57, 0xE48BFF58, 0xE48BFF59, 0xE48BFF5A, 0xE48BFF5B];   // RP2350
let firmware = null;          // {name, bytes}

function checkUf2(bytes) {
  if (bytes.length < 512 || bytes.length % 512) return "not a UF2 file (not whole 512-byte blocks)";
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let o = 0; o < bytes.length; o += 512) {
    if (dv.getUint32(o, true) !== 0x0A324655 || dv.getUint32(o + 4, true) !== 0x9E5D5157 || dv.getUint32(o + 508, true) !== 0x0AB16F30)
      return "not a UF2 file (block marks missing)";
    if ((dv.getUint32(o + 8, true) & 0x2000) && !UF2_FAMILIES.includes(dv.getUint32(o + 28, true)))
      return "this UF2 is not for an RP2350";
  }
  return "";
}

function fwStatus(text, cls = "") {
  const el = $("fw-status");
  el.textContent = text;
  el.style.color = cls === "err" ? "var(--fail)" : cls === "ok" ? "var(--ok)" : "";
  if (text) log(`firmware: ${text}`, cls === "err" ? "err" : "info");
}

// "SP-202 firmware v1.2.0" (or "SP-202 RESEARCH firmware v1.2.0") from the card's banner.
const fwName = banner => (banner || "").match(/5V (.*?firmware v\d+\.\d+\.\d+)/)?.[1] || "";

function renderFirmware() {
  const powered = state.info?.powered === true;
  $("btn-fw-go").disabled = !firmware || !state.link || powered || state.busy;
  $("btn-fw-go").title = !firmware ? "Choose a .uf2 file first" : !state.link ? "CONNECT the card first" : powered ? "Switch the SP-202 off" : "";
  const prev = state.link && !powered && !state.busy ? state.info?.previousFw : null;
  $("btn-fw-back").hidden = !prev;
  if (prev) $("btn-fw-back").title = `Back to the card's previous firmware: ${prev}`;
  // what runs and what is kept, in words (both may have the same version number)
  const now = fwName(state.info?.banner);
  $("fw-now").textContent = state.link && now ? `Running: ${now}${prev ? ` · kept for GO BACK: ${prev}` : ""}.` : "";
  updateSeen();
}

// A UF2 file's flash content as one binary from 0x10000000 (what the card's self-update takes).
function uf2ToBin(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = 0;
  const parts = [];
  for (let o = 0; o + 512 <= bytes.length; o += 512) {
    const addr = dv.getUint32(o + 12, true), size = dv.getUint32(o + 16, true);
    // skip the "absolute" family block (0xE48BFF57, an RP2350 boot ROM workaround near the end of flash)
    if ((dv.getUint32(o + 8, true) & 0x2000) && dv.getUint32(o + 28, true) === 0xE48BFF57) continue;
    if (addr < 0x10000000 || addr >= 0x11000000) continue;
    parts.push([addr - 0x10000000, bytes.subarray(o + 32, o + 32 + size)]);
    end = Math.max(end, addr - 0x10000000 + size);
  }
  const bin = new Uint8Array(end).fill(0xFF);
  for (const [at, d] of parts) bin.set(d, at);
  return bin;
}

// After the card restarts, CONNECT again by itself (the port is already allowed).
async function reconnectCard() {
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 750));
    if (state.link) return true;
    for (const p of await navigator.serial.getPorts()) {
      if (p.getInfo().usbVendorId !== 0x2E8A) continue;
      try { await connect(p); } catch (e) {}
      if (state.link) return true;
    }
  }
  return false;
}

// One-click update (card firmware 1.2.0+): the firmware goes over the open link, the card checks
// it, swaps it in (keeping the old one) and restarts; then the page reconnects.
async function selfUpdate() {
  const ok = ask("Update the firmware?", `<p>The card receives <b class="fw-name"></b>, checks it, swaps it in and restarts, in about 20 s.
     Keep the SP-202 off and the USB cable in.</p><p>Your pads and sample sets stay on the card, and the current firmware is kept: GO BACK returns to it.</p>`, "UPDATE");
  $("dlg-body").querySelector(".fw-name").textContent = firmware.name;
  if (!await ok) return;
  let sentAll = false;
  try {
    const bin = uf2ToBin(firmware.bytes);
    const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", bin));
    await state.link.sendUpdate(bin, sha, (n, total) => {
      sentAll = n === total;
      fwStatus(sentAll ? "Sent: the card checks it and swaps it in…" : `Sending ${firmware.name}: ${Math.round(100 * n / total)}%`);
    });
    fwStatus("Checked and swapped: the card is restarting…");
  } catch (e) {
    // every chunk taken, then the link dropped: the card is checking, swapping or restarting
    if (!(sentAll && /disconnected/.test(e.message))) { fwStatus(`Update stopped: ${e.message}. The card keeps its firmware.`, "err"); return; }
    fwStatus("The card is restarting…");
  }
  if (await reconnectCard()) fwStatus(`Done: the card now runs ${fwName(state.info?.banner) || "its new firmware"}.`, "ok");
  else fwStatus("The card restarted: press CONNECT.", "ok");
}

async function goBackFirmware() {
  const prev = state.info?.previousFw;
  if (!prev || !await ask("Go back?", `<p>The card swaps back to its previous firmware, <b class="fw-name"></b>, and restarts. Your pads and sample sets stay.</p>`, "GO BACK")) return;
  try {
    await state.link.goBack();
    fwStatus("Swapped back: the card is restarting…");
  } catch (e) {
    if (!/disconnected/.test(e.message)) { fwStatus(`Not done: ${e.message}.`, "err"); return; }
    fwStatus("The card is restarting…");
  }
  if (await reconnectCard()) fwStatus(`Done: the card now runs ${fwName(state.info?.banner) || "its new firmware"}.`, "ok");
  else fwStatus("The card restarted: press CONNECT.", "ok");
}

async function updateFirmware() {
  if (state.info?.canSelfUpdate) return selfUpdate();
  const ok = ask("Update the firmware?", `<p>The card restarts in update mode for <b class="fw-name"></b>. Keep the SP-202 off and the USB cable in.</p>
     <p>Your pads and sample sets stay on the card.</p>`, "UPDATE");
  $("dlg-body").querySelector(".fw-name").textContent = firmware.name;
  if (!await ok) return;
  const port = state.link.port;
  try {
    await state.link.disconnect();
    await port.open({ baudRate: 1200 });          // the firmware restarts in update mode on this
    await port.close().catch(() => {});
  } catch (e) { /* the card restarts while the port opens: that is the expected end */ }
  $("btn-fw-copy").hidden = false;
  fwStatus("The card restarted in update mode: a drive named RP2350 appears. Press COPY TO RP2350 and pick that drive.");
}

async function copyFirmware() {
  if (!window.showDirectoryPicker) { downloadFirmware("this browser cannot write to a drive"); return; }
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: "readwrite", id: "rp2350" }); }
  catch (e) { if (e.name !== "AbortError") downloadFirmware(e.message); return; }
  try { await dir.getFileHandle("INFO_UF2.TXT"); }
  catch (e) { fwStatus(`"${dir.name}" is not the RP2350 drive (no INFO_UF2.TXT): pick the drive named RP2350.`, "err"); return; }
  try {
    const fh = await dir.getFileHandle("SMARTMARE.UF2", { create: true });
    const w = await fh.createWritable();
    await w.write(firmware.bytes);
    await w.close();
  } catch (e) {
    // the card takes the firmware as the blocks arrive and restarts at the last one: the
    // drive can vanish before the browser has finished with it
    log(`firmware: the drive went away while writing (${e.message}): usually the card has restarted`, "warn");
  }
  $("btn-fw-copy").hidden = true;
  fwStatus(`${firmware.name} sent. The card restarts with it in a few seconds: press CONNECT.`, "ok");
}

function downloadFirmware(why) {
  download(firmware.bytes, firmware.name);
  fwStatus(`The page cannot copy the file itself (${why}). ${firmware.name} is in your Downloads: drag it onto the RP2350 drive.`, "err");
}

function bindFirmware() {
  $("btn-fw-file").onclick = () => $("file-fw").click();
  $("file-fw").onchange = async e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer()), err = checkUf2(bytes);
    if (err) { firmware = null; $("fw-file").textContent = "no file chosen"; fwStatus(`${f.name}: ${err}.`, "err"); }
    else { firmware = { name: f.name, bytes }; $("fw-file").textContent = `${f.name} · ${(bytes.length / 2 / 1024).toFixed(0)} KB of firmware`; fwStatus(""); }
    renderFirmware();
  };
  $("btn-fw-go").onclick = updateFirmware;
  $("btn-fw-copy").onclick = copyFirmware;
  $("btn-fw-back").onclick = goBackFirmware;
  bindUpdate();
}
