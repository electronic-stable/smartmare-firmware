/*
 * SmartMare 5V - update check: the latest release on smartmare.com
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.2 - 4 Nov 2026
 * SPDX-License-Identifier: MIT
 *
 * Asks smartmare.com for latest.json (written by WebSite/build.py from the latest release) when
 * the card answers on CONNECT, or on CHECK UPDATES; never on its own otherwise. Compares it
 * with the card's firmware (its banner) and with this page, offers the newer firmware (fetched
 * and checked, then UPDATE as with a chosen file) and the newer page (hosted on the site).
 * Shared by both card pages; uses the page's globals: $, state, log, and firmware.js.
 */
"use strict";

// A page served from the site reads latest.json beside it; the copy on the card asks the site,
// which allows it (Access-Control-Allow-Origin in the site's _headers).
const SITE = "https://smartmare.com";
const PAGE_VERSION = "%VERSION%";              // set by tools/build_drive.py; as is while working in app/
const PAGE_KIND = document.querySelector('meta[name="smartmare-page"]')?.content || "sp-202";
const ON_SITE = location.protocol === "https:" && /(^|\.)smartmare\.com$/.test(location.hostname);
let latest = null;                             // latest.json, once read
let askedFor = null;                           // the firmware version already checked on CONNECT

const siteUrl = path => (ON_SITE ? "/" : `${SITE}/`) + path;
// a > b for "x.y.z" versions (anything else counts as older)
function newer(a, b) {
  const p = v => /^\d+\.\d+\.\d+$/.test(v || "") ? v.split(".").map(Number) : [-1, -1, -1];
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

async function checkUpdates(quiet) {
  $("update-info").textContent = "Checking…";
  try {
    const r = await fetch(siteUrl("latest.json"), { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    latest = await r.json();
    log(`update check: latest release v${latest.version} (${latest.date})`, "info");
  } catch (e) {
    latest = null;
    $("update-info").textContent = quiet ? "" : "smartmare.com cannot be reached.";
    log(`update check: smartmare.com not reached (${e.message})`, quiet ? "info" : "warn");
  }
  renderUpdate();
}

// The card's firmware version: "x.y.z" from its banner; "0.0.0" when it answers without one
// (the firmwares before 1.0.0 said "== SmartMedia emulator, ..."); null until it has answered.
const cardVersion = () => state.info?.fwVersion || (state.info?.firmware ? "0.0.0" : null);

function renderUpdate() {
  const el = $("update-info");
  if (!latest) return;
  const card = cardVersion();
  const has = card === "0.0.0" ? "older than v1.0.0" : `v${card}`;
  el.textContent = !card ? `Latest: v${latest.version}.`
    : newer(latest.version, card) ? `Card ${has} · v${latest.version} available: AUTO UPDATE.`
    : `Card v${card} · latest v${latest.version}.`;
  if (!ON_SITE && newer(latest.version, PAGE_VERSION)) {
    const a = document.createElement("a");
    a.href = siteUrl(latest.page[PAGE_KIND]);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Newer page online";
    el.append(" ", a, ".");
  }
}

// The latest firmware for this page's card, fetched from the site and checked (size, SHA-256,
// UF2), then waiting for UPDATE like a chosen file. If the browser cannot fetch it, it is
// downloaded instead, for CHOOSE .UF2.
async function getLatestFirmware() {
  const f = latest?.firmware?.[PAGE_KIND];
  if (!f) return false;
  const url = siteUrl(f.file), name = f.file.split("/").pop();
  fwStatus(`Getting ${name}…`);
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
    if (bytes.length !== f.size || sha !== f.sha256) throw new Error("the file does not match latest.json");
    const err = checkUf2(bytes);
    if (err) throw new Error(err);
    firmware = { name, bytes };
    fwStatus("");
    return true;
  } catch (e) {
    log(`update: ${name} not fetched (${e.message}); downloading it instead`, "warn");
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    fwStatus(`${name} is downloading: then MANUAL UPDATE and pick it.`);
    return false;
  }
}

// Called by renderFirmware: once the card has answered on CONNECT (with its version or none), check once.
function updateSeen() {
  const v = cardVersion();
  if (v && v !== askedFor) { askedFor = v; checkUpdates(true); }
  else if (latest) renderUpdate();
}

