/*
 * SmartMare 5V - firmware update from the loader pages
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.0.0 - 2 Nov 2026
 * SPDX-License-Identifier: MIT
 *
 * Firmware update, shared by the Pad Editor (app.js) and the generic card's page
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

function renderFirmware() {
  const powered = state.info?.powered === true;
  $("btn-fw-go").disabled = !firmware || !state.link || powered || state.busy;
  $("btn-fw-go").title = !firmware ? "Choose a .uf2 file first" : !state.link ? "CONNECT the card first" : powered ? "Switch the SP-202 off" : "";
}

async function updateFirmware() {
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
}
