/*
 * SmartMare 5V - sound editor: waveform, start and stop points, zoom and preview
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.0 - 4 Nov 2026
 * SPDX-License-Identifier: MIT
 *
 * The trim screen: an MPC-style LCD with the waveform, START / END flags, zoom, and the
 * player (whole sample, start to stop point, and preview as the SP-202 plays an SP-202 quality).
 *
 * Two kinds of source:
 *  - audio: samples in the page (a dropped file), Float32 mono at its own rate;
 *  - marks: an SP-202 pad: the flags move in bytes; data holds the decoded sound
 *    (spb samples per byte; lr the two channels of a stereo pad, data their mix).
 */
"use strict";

const Audio202 = (() => {
  let ctx = null;
  const context = () => (ctx ||= new AudioContext());

  // Any audio file the browser can read -> mono Float32 at the file's rate.
  async function decodeFile(bytes) {
    const buf = await context().decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const n = buf.length, mono = new Float32Array(n), chans = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chans.push(Float32Array.from(buf.getChannelData(c)));
    for (const d of chans)
      for (let i = 0; i < n; i++) mono[i] += d[i] / chans.length;
    return { data: mono, chans, rate: buf.sampleRate };
  }

  // Resample with the browser's own filter (what the SP-202's input filter does, roughly).
  async function resample(data, rate, to) {
    if (Math.abs(rate - to) < 1) return data;
    const len = Math.max(1, Math.round(data.length * to / rate));
    const off = new OfflineAudioContext(1, len, to);
    const b = off.createBuffer(1, data.length, rate);
    b.copyToChannel(data, 0);
    const s = off.createBufferSource();
    s.buffer = b;
    s.connect(off.destination);
    s.start();
    return (await off.startRendering()).getChannelData(0);
  }

  let current = null;
  function stop() {
    if (current) { try { current.src.stop(); } catch (e) {} current = null; }
  }
  // The SP-202's grades are 31250 Hz divided by 1, 2, 4 and 8: it plays at 31.25 kHz and repeats
  // each sample of a lower grade, which is where the LO-FI grit comes from. Sounds at those rates
  // are played the same way (the browser would otherwise smooth them).
  const SP202_RATE = 31250;
  function holdOf(rate) {
    const q = SP202_RATE / rate;
    return q >= 2 && Math.abs(q - Math.round(q)) < 1e-6 ? Math.round(q) : 1;
  }
  function held(d, from, n, f) {
    if (f === 1) return d.subarray(from, from + n);
    const out = new Float32Array(n * f);
    for (let i = 0; i < n; i++) out.fill(d[from + i], i * f, i * f + f);
    return out;
  }
  // A sound at an SP-202 grade rate as the SP-202 puts it out: {data, rate} at 31250 Hz.
  function toSP202(data, rate) {
    const f = holdOf(rate);
    return { data: held(data, 0, data.length, f), rate: rate * f };
  }
  // Plays data[from..to) at `rate`. Returns {startedAt, from, to, rate, loop}.
  // right: the right channel of a stereo sound (same length), or nothing for mono.
  function play(data, rate, from = 0, to = data.length, loop = false, onEnd, right) {
    stop();
    const c = context();
    if (c.state === "suspended") c.resume();
    const n = Math.max(1, to - from), f = holdOf(rate);
    const b = c.createBuffer(right ? 2 : 1, n * f, rate * f);
    b.copyToChannel(held(data, from, n, f), 0);
    if (right) b.copyToChannel(held(right, from, n, f), 1);
    const src = c.createBufferSource();
    src.buffer = b;
    src.loop = loop;
    src.connect(c.destination);
    const me = { src, startedAt: c.currentTime, from, to: from + n, rate, loop };
    src.onended = () => { if (current === me) current = null; onEnd?.(); };
    src.start();
    current = me;
    return me;
  }
  // Position (in samples of the played data) of what is playing now, or null.
  function position() {
    if (!current) return null;
    const t = (context().currentTime - current.startedAt) * current.rate;
    const len = current.to - current.from;
    if (!current.loop && t >= len) return null;
    return { at: current.from + (current.loop ? t % len : t), ...current };
  }
  return { decodeFile, resample, toSP202, play, stop, position, context };
})();

// The part of a source between its marks, at the chosen quality and channels, ready for the
// codec: {parts: [left, right?], rate, gain, region}. A file is brought to 0.63 of full scale
// (the level of the SP-202's own recordings); a card pad keeps its level, and is redone from its
// original file when the page still has it (region: the part of that file used).
async function soundParts(s) {
  const rate = SM.RATES[s.grade];
  let chans, from, gain = 1, region = null;
  if (s.kind === "audio") {
    const st = s.settings?.stereo && s.chans?.length > 1;
    chans = (st ? s.chans.slice(0, 2) : [s.data]).map(d => d.subarray(Math.floor(s.start), Math.floor(s.end)));
    from = s.rate;
    gain = null;
  } else if (s.original) {                       // card bytes 0..total hold the file's from..to
    const o = s.original, k = (o.to - o.from) / s.total;
    region = [o.from + Math.round(s.start * k), o.from + Math.round(s.end * k)];
    const st = s.wantStereo && o.chans.length > 1;
    chans = (st ? o.chans.slice(0, 2) : [o.data]).map(d => d.subarray(region[0], region[1]));
    from = o.rate;
    gain = o.gain;
  } else {
    const a = Math.floor(s.start * s.spb), b = Math.floor(s.end * s.spb);
    const st = (s.wantStereo ?? s.stereo) && s.lr;
    chans = (st ? s.lr : [s.data]).map(d => d.subarray(a, b));
    from = s.rate;
  }
  const parts = [];
  for (const d of chans) parts.push(Float32Array.from(await Audio202.resample(d, from, rate)));
  if (gain === null) {
    let peak = 0;
    for (const p of parts) for (const v of p) peak = Math.max(peak, Math.abs(v));
    gain = peak > 0 ? 0.63 / peak : 1;
  }
  if (gain !== 1) for (const p of parts) for (let i = 0; i < p.length; i++) p[i] *= gain;
  return { parts, rate, gain, region };
}

class WaveEditor {
  constructor(root, onChange) {
    this.root = root;
    this.onChange = onChange;       // (source) => void, after a flag moved or the grade changed
    this.canvas = root.querySelector("canvas");
    this.src = null;
    this.view = [0, 1];             // visible window [from, to) in units (samples or bytes)
    this.drag = null;
    this.bind();
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    const tick = () => { this.drawPlayhead(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  // source: {kind:"audio"|"marks"|"none", title, info, total, start, end, rate?, data?, grade, editable}
  load(src) {
    Audio202.stop();
    this.src = src;
    this.view = [0, Math.max(1, src.total || 1)];
    this.renderFields();
    this.draw();
  }

  units() { return this.src?.kind === "audio" ? "samples" : "bytes"; }
  spu() { return this.src?.kind === "audio" ? 1 : this.src?.spb || 1; }      // samples per unit
  seconds(u) {
    const s = this.src;
    if (!s) return 0;
    if (s.kind === "audio") return u / s.rate;
    return u * 2 / (s.stereo ? 2 : 1) / SM.RATES[s.origGrade ?? s.grade];   // the pad's own quality, not the one chosen
  }

  // ---------- drawing ----------
  size() {
    const r = this.canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    return { w, h, dpr };
  }
  x(u) { const { w } = this.size(); return (u - this.view[0]) / (this.view[1] - this.view[0]) * w; }
  u(x) { const { w } = this.size(); return this.view[0] + x / w * (this.view[1] - this.view[0]); }

  draw() {
    const { w, h, dpr } = this.size(), g = this.canvas.getContext("2d");
    const css = getComputedStyle(this.root);
    const ink = css.getPropertyValue("--lcd-ink").trim(), dim = css.getPropertyValue("--lcd-dim").trim(), sel = css.getPropertyValue("--lcd-sel").trim();
    g.clearRect(0, 0, w, h);
    const s = this.src;
    const mid = h / 2;
    // grid
    g.fillStyle = dim;
    for (let gx = 0; gx < w; gx += 24 * dpr) g.fillRect(gx, mid, 1 * dpr, 1 * dpr);
    if (!s || s.kind === "none") return;
    // selection
    const xs = this.x(s.start), xe = this.x(s.end);
    g.fillStyle = sel;
    g.fillRect(Math.max(0, xs), 0, Math.min(w, xe) - Math.max(0, xs), h);
    // waveform: min/max per column
    if (s.data) {
      const d = s.data, k = this.spu(), per = (this.view[1] - this.view[0]) / w * k, v0 = this.view[0] * k;
      g.fillStyle = ink;
      for (let col = 0; col < w; col++) {
        const a = Math.floor(v0 + col * per), b = Math.max(a + 1, Math.floor(v0 + (col + 1) * per));
        let lo = 1, hi = -1;
        for (let i = Math.max(0, a); i < Math.min(d.length, b); i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi < lo) continue;
        const y0 = mid - hi * (mid - 4 * dpr), y1 = mid - lo * (mid - 4 * dpr);
        g.fillRect(col, y0, 1, Math.max(1, y1 - y0));
      }
    } else {
      g.fillStyle = dim;
      g.font = `${12 * dpr}px ui-monospace, Consolas, monospace`;
      g.textAlign = "center";
      g.fillText(s.noWave || "NO WAVEFORM", w / 2, mid - 8 * dpr);
      g.fillRect(0, mid, w, 1 * dpr);
    }
    // flags
    for (const [u, label] of [[s.start, "S"], [s.end, "E"]]) {
      const fx = Math.round(this.x(u));
      if (fx < -20 || fx > w + 20) continue;
      g.fillStyle = ink;
      g.fillRect(fx - dpr, 0, 2 * dpr, h);
      const fw = 14 * dpr, fh = 14 * dpr, left = label === "S" ? fx : fx - fw;
      g.fillRect(left, 0, fw, fh);
      g.fillStyle = css.getPropertyValue("--lcd-bg").trim();
      g.font = `bold ${11 * dpr}px ui-monospace, Consolas, monospace`;
      g.textAlign = "center";
      g.fillText(label, left + fw / 2, 11 * dpr);
    }
    this.lastFrame = g.getImageData(0, 0, w, h);
  }

  drawPlayhead() {
    const p = Audio202.position(), s = this.src;
    if (!this.lastFrame || !s || !s.data) { this.wasPlaying = false; return; }
    if (!p && !this.wasPlaying) return;
    const g = this.canvas.getContext("2d");
    g.putImageData(this.lastFrame, 0, 0);
    this.wasPlaying = !!p;
    if (!p || p.source !== s) { this.root.querySelector(".lcd-play").textContent = ""; return; }
    const n = p.at * s.rate / p.rate;                                       // in samples of the source
    const at = (p.base || 0) + (s.kind === "audio" ? n : n / this.spu());   // back to the source's units
    const x = this.x(at), { h, dpr } = this.size();
    g.fillStyle = getComputedStyle(this.root).getPropertyValue("--lcd-ink").trim();
    g.globalAlpha = .6;
    g.fillRect(x, 0, 2 * dpr, h);
    g.globalAlpha = 1;
    this.root.querySelector(".lcd-play").textContent = `▶ ${this.seconds(at).toFixed(3)} s`;
  }

  renderFields() {
    const s = this.src, f = this.root.querySelector(".lcd-fields"), head = this.root.querySelector(".lcd-title");
    const b = this.root.querySelectorAll("[data-ed]");
    if (!s || s.kind === "none") {
      head.textContent = s?.title || "MARK";
      f.innerHTML = `<span>${s?.info || "DROP AN AUDIO FILE ON A PAD, OR SELECT A PAD"}</span>`;
      b.forEach(x => x.disabled = true);
      this.root.querySelectorAll("[data-grade]").forEach(x => { x.disabled = true; x.classList.remove("on"); });
      return;
    }
    head.textContent = s.title;
    const len = s.end - s.start;
    const t = u => this.seconds(u).toFixed(3);
    f.innerHTML = `<span>START <b>${t(s.start)}</b></span><span>STOP <b>${t(s.end)}</b></span>
      <span>LEN <b>${t(len)}</b> s</span><span>${s.info || ""}</span>`;
    b.forEach(x => {
      const a = x.dataset.ed;
      // card pad: LOAD TO PAD for a new quality or channels, TRUNCATE for the marks
      const reload = s.kind === "marks" && (s.grade !== s.origGrade || (s.wantStereo ?? s.stereo) !== s.stereo);
      const needs = a === "preview" ? (s.kind === "audio" || s.kind === "marks") && !!s.data
        : a === "load" ? s.kind === "audio" || reload
        : a === "truncate" ? s.kind === "marks" && (s.start > 0 || s.end < s.total)
        : ["play", "playsel", "savewav"].includes(a) ? !!s.data : true;
      x.disabled = !needs || (!s.editable && /^(s|e)[-+]/.test(a));
    });
    const can = s.kind === "audio" || (s.kind === "marks" && !!s.data);
    this.root.querySelectorAll("[data-grade]").forEach(x => {   // a card pad only goes down, unless its file is known
      x.classList.toggle("on", +x.dataset.grade === s.grade);
      x.disabled = !can || (s.kind === "marks" && +x.dataset.grade < (s.minGrade ?? s.origGrade));
    });
    this.root.querySelector('[data-ed="load"]').title =
      "Puts START–STOP on the pad at the chosen quality and channels; the rest is cut and its memory freed (then WRITE CARD)";
  }

  // ---------- editing ----------
  step(fine) {
    const s = this.src;
    if (s.kind === "marks") return fine ? s.align : s.align * 16;
    const span = this.view[1] - this.view[0];
    return Math.max(1, Math.round(span / (fine ? 2000 : 100)));
  }
  setFlag(which, u) {
    const s = this.src;
    if (!s || !s.editable) return;
    u = Math.round(u);
    if (s.align) u = Math.round(u / s.align) * s.align;
    if (which === "start") s.start = Math.max(0, Math.min(u, s.end - (s.align || 1)));
    else s.end = Math.min(s.total, Math.max(u, s.start + (s.align || 1)));
    this.renderFields();
    this.draw();
    this.onChange?.(s);
  }
  zoom(f, center) {
    const [a, b] = this.view, total = this.src?.total || 1;
    const c = center ?? (a + b) / 2;
    let span = Math.min(total, Math.max(64, (b - a) * f));
    let from = Math.max(0, Math.min(total - span, c - (c - a) * span / (b - a)));
    this.view = [from, from + span];
    this.draw();
  }

  async playIt(sel) {
    const s = this.src;
    if (!s || !s.data) return;
    const k = this.spu(), from = sel ? s.start * k : 0, to = sel ? s.end * k : s.data.length;
    const [l, r] = s.lr || [s.data];
    Audio202.play(l, s.rate, Math.floor(from), Math.floor(to), false, undefined, r).source = s;
  }
  // START–STOP as the SP-202 would play it at the chosen quality: resampled, encoded and decoded
  // with its codec (what goes on the card). Returns {chans: [left, right?], rate}, or null.
  // ▶ AS SP-202 plays it, EXPORT WAV saves it.
  async sound202() {
    const s = this.src;
    if (!s || !s.data || (s.kind !== "audio" && s.kind !== "marks")) return null;
    const { parts, rate } = await soundParts(s);
    const out = parts.length > 1
      ? Codec202.decodeStereo(Codec202.encodeStereo(parts[0], parts[1]).bytes)
      : [Codec202.decode(Codec202.encode(parts[0]).bytes)];
    return { chans: out, rate };
  }
  // Plays sound202(); the playhead follows.
  async preview() {
    const s = this.src, r = await this.sound202();
    if (!r) return;
    const [l, right] = r.chans;
    const p = Audio202.play(l, r.rate, 0, l.length, false, undefined, right);
    p.source = s;
    p.base = s.start;                            // the playhead counts from START
  }

  bind() {
    const r = this.root;
    r.addEventListener("click", e => {
      const btn = e.target.closest("[data-ed]");
      if (!btn || btn.disabled || !this.src) return;
      const a = btn.dataset.ed, s = this.src;
      if (a === "play") this.playIt(false);
      else if (a === "playsel") this.playIt(true);
      else if (a === "stop") Audio202.stop();
      else if (a === "preview") this.preview();
      else if (a === "zin") this.zoom(0.5);
      else if (a === "zout") this.zoom(2);
      else if (a === "zfit") { this.view = [0, s.total]; this.draw(); }
      else if (a === "zsel") { const pad = (s.end - s.start) * .05; this.view = [Math.max(0, s.start - pad), Math.min(s.total, s.end + pad)]; this.draw(); }
      else if (a === "s-") this.setFlag("start", s.start - this.step(e.shiftKey));
      else if (a === "s+") this.setFlag("start", s.start + this.step(e.shiftKey));
      else if (a === "e-") this.setFlag("end", s.end - this.step(e.shiftKey));
      else if (a === "e+") this.setFlag("end", s.end + this.step(e.shiftKey));
      else if (a === "savewav") this.onSaveWav?.(s);
      else if (a === "load") this.onLoad?.(s);
      else if (a === "truncate") this.onTruncate?.(s);
    });
    r.querySelector(".grade-seg").addEventListener("click", e => {
      const b = e.target.closest("[data-grade]");
      if (!this.src || !b || b.disabled) return;
      this.src.grade = +b.dataset.grade;
      this.renderFields();
      if (this.src.kind === "audio") this.onChange?.(this.src);           // a card pad changes on RELOAD TO PAD
    });
    const cv = this.canvas;
    const unitAt = e => this.u((e.clientX - cv.getBoundingClientRect().left) * (devicePixelRatio || 1));
    cv.addEventListener("pointerdown", e => {
      const s = this.src;
      if (!s || s.kind === "none") return;
      const u = unitAt(e), near = px => Math.abs(this.x(px) - this.x(u)) < 10 * (devicePixelRatio || 1);
      if (s.editable && near(s.start)) this.drag = "start";
      else if (s.editable && near(s.end)) this.drag = "end";
      else this.drag = { pan: e.clientX, view: [...this.view] };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", e => {
      const s = this.src;
      if (!s || s.kind === "none") return;
      if (!this.drag) {
        const u = unitAt(e), near = px => Math.abs(this.x(px) - this.x(u)) < 10 * (devicePixelRatio || 1);
        cv.style.cursor = s.editable && (near(s.start) || near(s.end)) ? "ew-resize" : "grab";
        return;
      }
      if (this.drag === "start" || this.drag === "end") { this.setFlag(this.drag, unitAt(e)); return; }
      const span = this.drag.view[1] - this.drag.view[0];
      const du = (this.drag.pan - e.clientX) / cv.getBoundingClientRect().width * span;
      const from = Math.max(0, Math.min(s.total - span, this.drag.view[0] + du));
      this.view = [from, from + span];
      this.draw();
    });
    cv.addEventListener("pointerup", () => { this.drag = null; });
    cv.addEventListener("wheel", e => {
      if (!this.src || this.src.kind === "none") return;
      e.preventDefault();
      this.zoom(e.deltaY > 0 ? 1.25 : 0.8, unitAt(e));
    }, { passive: false });
  }
}

// A 16-bit WAV file of data (Float32) at rate: mono, or stereo with right.
function wavFile(data, rate, right) {
  const ch = right ? 2 : 1, n = data.length, out = new DataView(new ArrayBuffer(44 + 2 * ch * n));
  const str = (o, t) => [...t].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); out.setUint32(4, 36 + 2 * n, true); str(8, "WAVE"); str(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, Math.round(rate), true); out.setUint32(28, Math.round(rate) * 2 * ch, true);
  out.setUint16(32, 2 * ch, true); out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, 2 * ch * n, true);
  const put = (i, v) => out.setInt16(44 + 2 * i, Math.max(-1, Math.min(1, v)) * 32767, true);
  for (let i = 0; i < n; i++) {
    if (right) { put(2 * i, data[i]); put(2 * i + 1, right[i]); } else put(i, data[i]);
  }
  return new Uint8Array(out.buffer);
}
