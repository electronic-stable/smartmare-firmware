/*
 * SmartMare 5V - sample sets: the whole work in one .smartmare file
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.0.0 - 2 Nov 2026
 * SPDX-License-Identifier: MIT
 *
 * Sample sets: the whole work in one file. A set keeps the card image being edited
 * (banks C/D and the A/B backup), the audio files waiting on pads with their trims and
 * settings, and the names of the samples.
 *
 * File (.smartmare): "SMPROJ01", u32 length of the JSON, the JSON, then the binary parts
 * the JSON points to (offset, length).
 */
"use strict";

const Project = (() => {
  const MAGIC = "SMPROJ01";

  function pack(meta, parts) {
    let offset = 0;
    const index = parts.map(p => { const r = { offset, length: p.byteLength }; offset += p.byteLength; return r; });
    const json = new TextEncoder().encode(JSON.stringify({ ...meta, parts: index }));
    const out = new Uint8Array(12 + json.length + offset);
    out.set([...MAGIC].map(c => c.charCodeAt(0)), 0);
    new DataView(out.buffer).setUint32(8, json.length, true);
    out.set(json, 12);
    let at = 12 + json.length;
    for (const p of parts) { out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at); at += p.byteLength; }
    return out;
  }

  function unpack(bytes) {
    if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 8)) !== MAGIC) throw new Error("not a SmartMare project");
    const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
    const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + n)));
    const base = 12 + n;
    const part = i => bytes.slice(base + meta.parts[i].offset, base + meta.parts[i].offset + meta.parts[i].length);
    return { meta, part };
  }

  // The names of the samples in the image (padNames and sampleKey are app.js's).
  function names(state) {
    const out = {};
    if (!state.work || typeof padNames === "undefined") return out;
    for (const kind of ["card", "backup"]) {
      const sp = new SM.Space(state.work, kind);
      if (!sp.present()) continue;
      for (const e of sp.used()) { const k = sampleKey(sp.sample(e)); if (padNames[k]) out[k] = padNames[k]; }
    }
    return out;
  }

  // state -> bytes
  function save(state, name) {
    const parts = [];
    const add = u8 => { parts.push(u8); return parts.length - 1; };
    const pending = Object.entries(state.pending).map(([pad, p]) => ({
      pad, fileName: p.fileName, rate: p.rate, start: p.start, end: p.end, grade: p.grade,
      settings: p.settings, chans: p.chans.map(c => {                 // 16-bit, half the size of Float32
        const q = new Int16Array(c.length);
        for (let i = 0; i < c.length; i++) q[i] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767)));
        return add(new Uint8Array(q.buffer));
      }),
    }));
    if (state.work) state.work.finalize();
    const meta = {
      app: "SmartMare Pad Editor", version: 2, name, savedAt: new Date().toISOString(),
      bank: state.bank, selected: state.selected, source: state.source,
      image: state.work ? add(state.work.img) : null, pending,
      names: names(state),
    };
    return pack(meta, parts);
  }

  // bytes -> {name, image (SM.Image|null), pending (state.pending), bank, selected}
  function load(bytes) {
    const { meta, part } = unpack(bytes);
    const audio = i => {
      if ((meta.version || 1) < 2) return new Float32Array(part(i).buffer);
      const q = new Int16Array(part(i).buffer), f = new Float32Array(q.length);
      for (let k = 0; k < q.length; k++) f[k] = q[k] / 32767;
      return f;
    };
    const pending = {};
    for (const p of meta.pending || []) {
      const chans = p.chans.map(audio);
      const n = chans[0].length, mono = new Float32Array(n);
      for (const c of chans) for (let i = 0; i < n; i++) mono[i] += c[i] / chans.length;
      pending[p.pad] = {
        kind: "audio", id: Date.now() + Math.random(), fileName: p.fileName, title: `${p.pad} · ${p.fileName}`,
        data: mono, chans, rate: p.rate, channels: chans.length, total: n, start: p.start, end: p.end,
        grade: p.grade, editable: true, settings: p.settings,
        info: `${p.rate} HZ${chans.length > 1 ? " · ST→MONO" : ""}`,
      };
    }
    return {
      name: meta.name, savedAt: meta.savedAt, bank: meta.bank || "C", selected: meta.selected || 0,
      image: meta.image === null ? null : new SM.Image(part(meta.image)), pending, names: meta.names || {},
    };
  }

  // ---------- the library in the browser (IndexedDB) ----------
  const DB = "smartmare", STORE = "projects";
  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "name" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, mode), st = t.objectStore(STORE);
      const r = fn(st);
      t.oncomplete = () => res(r && "result" in r ? r.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  const put = (name, bytes) => tx("readwrite", st => st.put({ name, savedAt: new Date().toISOString(), size: bytes.length, bytes }));
  const get = name => tx("readonly", st => st.get(name));
  const remove = name => tx("readwrite", st => st.delete(name));
  async function list() {
    const all = await tx("readonly", st => st.getAll());
    return (all || []).map(({ name, savedAt, size }) => ({ name, savedAt, size })).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  // gzip, for the sets kept on the card (an image is mostly blank).
  async function gzip(bytes) {
    const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function gunzip(bytes) {
    if (bytes[0] !== 0x1F || bytes[1] !== 0x8B) return bytes;      // not compressed
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  return { save, load, put, get, remove, list, gzip, gunzip };
})();
