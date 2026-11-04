/*
 * SmartMare 5V - SP-202 sample codec: decodes and encodes pad audio
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.7 - 4 Nov 2026
 * SPDX-License-Identifier: MIT
 *
 * Frames of 4 bytes = 8 samples, big-endian words, in pairs (A, B). The top bits of the
 * pair pick the layout and the step S of both frames. Fields, from bit 0 up: corrections
 * for samples 1-7, then the level (the frame's last sample). Decoding: xa = previous level,
 * xb = S*level, x4 = (xa+xb)/2 + S*v4 (absolute for codes 6-11), x2 and x6 from their
 * neighbours, odd samples from theirs. The codec reaches +-8192 units, but the SP-202's
 * analog output clips well before: its own recordings peak near 1300 units at REC LEVEL
 * MAX. So the page maps its full scale (1.0) to REF = 2048 units, for decoding and
 * encoding alike. Stereo pads alternate the 8-byte pairs: left, right, left, right.
 */
"use strict";

const Codec202 = (() => {
  const FULL = 8192, REF = 2048;
  const LAYOUTS = {
    m0: [2, 4, 2, 5, 2, 4, 2, 9],
    m2: [3, 4, 3, 5, 3, 4, 3, 5],
    a0: [2, 3, 2, 5, 2, 3, 2, 10],
    a1: [2, 4, 2, 6, 2, 4, 2, 7],
    ef: [3, 3, 3, 3, 3, 3, 3, 7],
  };
  const ORDER = [1, 2, 3, 4, 5, 6, 7, 0];

  // [layout, step, x4 absolute] of a pair
  function header(wa, wb) {
    const ma = wa >>> 30, mb = wb >>> 30;
    if (ma < 3) {
      const code = ma * 4 + mb;
      return code < 6 ? ["m0", 2 ** code, false] : ["m2", 16 * 2 ** (code - 6), true];
    }
    const a = (wa >>> 29) & 1, b = (wb >>> 29) & 7;
    if (a === 0) return ["a0", 0.25 * 2 ** b, false];
    if (b < 7) return ["a1", 4 * 2 ** b, false];
    return ["ef", (wb >>> 28) & 1 ? 0.5 : 0.25, false];
  }

  function fields(w, layout, v) {
    let at = 0;
    const widths = LAYOUTS[layout];
    for (let i = 0; i < 8; i++) {
      const width = widths[i], x = Math.floor(w / 2 ** at) % 2 ** width;
      v[ORDER[i]] = x >= 2 ** (width - 1) ? x - 2 ** width : x;
      at += width;
    }
  }

  // Sample bytes -> Float32 samples, full scale = 1.
  function decode(bytes) {
    const pairs = Math.floor(bytes.length / 8), out = new Float32Array(pairs * 16);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = new Array(8);
    let prev = 0;
    for (let p = 0; p < pairs; p++) {
      const wa = dv.getUint32(p * 8), wb = dv.getUint32(p * 8 + 4);
      const [lay, S, abs4] = header(wa, wb);
      for (let f = 0; f < 2; f++) {
        fields(f ? wb : wa, lay, v);
        const xa = prev, xb = S * v[0];
        const x4 = (abs4 ? 0 : (xa + xb) / 2) + S * v[4];
        const x2 = (xa + x4) / 2 + S * v[2], x6 = (x4 + xb) / 2 + S * v[6];
        const o = (p * 2 + f) * 8;
        out[o] = xa; out[o + 1] = (xa + x2) / 2 + S * v[1]; out[o + 2] = x2; out[o + 3] = (x2 + x4) / 2 + S * v[3];
        out[o + 4] = x4; out[o + 5] = (x4 + x6) / 2 + S * v[5]; out[o + 6] = x6; out[o + 7] = (x6 + xb) / 2 + S * v[7];
        prev = xb;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] /= REF;
    return out;
  }

  // Every measured pair header: [layout, step, x4 absolute, head bits A, head bits B]
  const CANDIDATES = [];
  for (let c = 0; c < 12; c++)
    CANDIDATES.push(c < 6 ? ["m0", 2 ** c, false] : ["m2", 16 * 2 ** (c - 6), true], );
  CANDIDATES.forEach((x, c) => x.push(((c >> 2) * 2 ** 30), ((c & 3) * 2 ** 30)));
  for (const b of [1, 2]) CANDIDATES.push(["a0", 0.25 * 2 ** b, false, 3 * 2 ** 30, b * 2 ** 29]);
  for (const b of [0, 1, 2]) CANDIDATES.push(["a1", 4 * 2 ** b, false, 7 * 2 ** 29, b * 2 ** 29]);
  CANDIDATES.push(["ef", 0.25, false, 0xE * 2 ** 28, 0xE * 2 ** 28]);
  CANDIDATES.push(["ef", 0.5, false, 0xE * 2 ** 28, 0xF * 2 ** 28]);
  for (const c of CANDIDATES) {
    const w = LAYOUTS[c[0]], lim = new Array(8);
    for (let i = 0; i < 8; i++) lim[ORDER[i]] = 2 ** (w[i] - 1);
    c.push(lim);
  }

  // One frame with one candidate: t[0..8] targets (t[8] = the frame's end). Fills v (fields)
  // and d (decoded, d[0] = xa .. d[8] = xb); returns the squared error of samples 1..8.
  function frame(xa, t, to, S, abs4, lim, v, d) {
    const q = (target, base, pos) => {
      let x = Math.round((target - base) / S);
      return x < -lim[pos] ? -lim[pos] : x > lim[pos] - 1 ? lim[pos] - 1 : x;
    };
    v[0] = q(t[to + 8], 0, 0);
    const xb = S * v[0], b4 = abs4 ? 0 : (xa + xb) / 2;
    v[4] = q(t[to + 4], b4, 4);
    const x4 = b4 + S * v[4];
    v[2] = q(t[to + 2], (xa + x4) / 2, 2);
    const x2 = (xa + x4) / 2 + S * v[2];
    v[6] = q(t[to + 6], (x4 + xb) / 2, 6);
    const x6 = (x4 + xb) / 2 + S * v[6];
    d[0] = xa; d[2] = x2; d[4] = x4; d[6] = x6; d[8] = xb;
    for (const pos of [1, 3, 5, 7]) {
      const m = (d[pos - 1] + d[pos + 1]) / 2;
      v[pos] = q(t[to + pos], m, pos);
      d[pos] = m + S * v[pos];
    }
    let e = 0;
    for (let i = 1; i <= 8; i++) { const r = d[i] - t[to + i]; e += r * r; }
    return e;
  }

  function pack(v, layout, head) {
    let w = head, at = 0;
    const widths = LAYOUTS[layout];
    for (let i = 0; i < 8; i++) {
      const width = widths[i];
      w += ((v[ORDER[i]] % 2 ** width + 2 ** width) % 2 ** width) * 2 ** at;
      at += width;
    }
    return w;
  }

  // Float32 samples (1.0 = REF units) -> sample bytes, a whole number of pairs. Each pair
  // takes the measured header that gives the smallest error. Returns {bytes, clipped}.
  function encode(samples) {
    const n = Math.ceil(samples.length / 16) * 16 || 16;
    const t = new Float64Array(n + 1);
    let clipped = 0;
    for (let i = 0; i < samples.length; i++) {
      let x = samples[i] * REF;
      if (x > FULL - 1) { x = FULL - 1; clipped++; } else if (x < -FULL) { x = -FULL; clipped++; }
      t[i] = x;
    }
    const out = new Uint8Array(n / 2), dv = new DataView(out.buffer);
    const va = new Array(8), vb = new Array(8), da = new Array(9), db = new Array(9);
    const best = { e: Infinity, va: new Array(8), vb: new Array(8), c: 0, end: 0 };
    let prev = 0;
    for (let p = 0; p < n; p += 16) {
      best.e = Infinity;
      for (let c = 0; c < CANDIDATES.length; c++) {
        const [lay, S, abs4, , , lim] = CANDIDATES[c];
        let e = frame(prev, t, p, S, abs4, lim, va, da);
        if (e >= best.e) continue;
        e += frame(da[8], t, p + 8, S, abs4, lim, vb, db);
        if (e < best.e) { best.e = e; best.c = c; best.end = db[8]; for (let i = 0; i < 8; i++) { best.va[i] = va[i]; best.vb[i] = vb[i]; } }
      }
      const cand = CANDIDATES[best.c];
      dv.setUint32(p / 2, pack(best.va, cand[0], cand[3]));
      dv.setUint32(p / 2 + 4, pack(best.vb, cand[0], cand[4]));
      prev = best.end;
    }
    return { bytes: out, clipped };
  }

  // Stereo pads: the 8-byte pairs alternate left, right, left, right (probe 14).
  function decodeStereo(bytes) {
    const n = Math.floor(bytes.length / 16) * 8, l = new Uint8Array(n), r = new Uint8Array(n);
    for (let i = 0; i < n; i += 8) {
      l.set(bytes.subarray(2 * i, 2 * i + 8), i);
      r.set(bytes.subarray(2 * i + 8, 2 * i + 16), i);
    }
    return [decode(l), decode(r)];
  }
  function encodeStereo(left, right) {
    const a = encode(left), b = encode(right), n = Math.max(a.bytes.length, b.bytes.length);
    const out = new Uint8Array(2 * n);
    for (let i = 0; i < n; i += 8) {
      if (i < a.bytes.length) out.set(a.bytes.subarray(i, i + 8), 2 * i);
      if (i < b.bytes.length) out.set(b.bytes.subarray(i, i + 8), 2 * i + 8);
    }
    return { bytes: out, clipped: a.clipped + b.clipped };
  }

  return { decode, encode, decodeStereo, encodeStereo, FULL, REF };
})();
