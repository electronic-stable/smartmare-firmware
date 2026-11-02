/*
 * SmartMare 5V - SP-202 card image: pad tables, samples, SmartMedia ECC
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.0.0 - 2 Nov 2026
 * SPDX-License-Identifier: MIT
 *
 * The SP-202 card image: 8192 pages of 528 bytes (512 data + 16 spare), as dumped by the
 * emulator. Pad tables, samples, SSFDC ECC.
 */
"use strict";

const SM = (() => {
  const PAGE = 528, DATA = 512, PAGES = 8192, PPB = 16, BLOCKS = 512;
  const BLOCK_DATA = PPB * DATA;              // 8 KB of data per block
  const BLOCK_BYTES = PPB * PAGE;             // 8448 bytes per block in the image
  const IMAGE_BYTES = PAGES * PAGE;
  const BACKUP_BLOCK = 448;                   // the BACKUP area: blocks 448-511
  const GRADES = ["HI-FI", "STANDARD", "LO-FI 1", "LO-FI 2"];
  const SHORT = ["HI-FI", "STD", "LO-FI1", "LO-FI2"];
  const RATES = [31250, 15625, 7812.5, 3906.25];
  const EMPTY_ENTRY = [0xFF, 0, 0, 0, 0, 0xFF, 0, 0x30, 0x7F, 0x02].concat(Array(16).fill(0xFF));
  const PAD_FILE_MAGIC = "SP202PAD";

  // ---------- SSFDC ECC ----------
  const COL = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const b = i => (v >> i) & 1;
    const cp = [b(0) ^ b(2) ^ b(4) ^ b(6), b(1) ^ b(3) ^ b(5) ^ b(7),
                b(0) ^ b(1) ^ b(4) ^ b(5), b(2) ^ b(3) ^ b(6) ^ b(7),
                b(0) ^ b(1) ^ b(2) ^ b(3), b(4) ^ b(5) ^ b(6) ^ b(7)];
    let par = 0;
    for (let i = 0; i < 8; i++) par ^= b(i);
    COL[v] = cp.reduce((a, c, i) => a | c << i, 0) | par << 6;
  }

  function ecc256(d, off) {
    let cols = 0;
    const lp = new Uint8Array(16);
    for (let i = 0; i < 256; i++) {
      const t = COL[d[off + i]];
      cols ^= t & 0x3F;
      if (t & 0x40)
        for (let k = 0; k < 8; k++) lp[2 * k + ((i >> k) & 1)] ^= 1;
    }
    let lo = 0, hi = 0;
    for (let j = 0; j < 8; j++) { lo |= lp[j] << j; hi |= lp[8 + j] << j; }
    return [~lo & 0xFF, ~hi & 0xFF, ((~cols & 0x3F) << 2) | 3];
  }

  function blockAddressField(lba) {
    let v = 0x1000 | (lba & 0x3FF) << 1;
    let ones = 0;
    for (let x = v; x; x >>= 1) ones += x & 1;
    v |= ones & 1;
    return [v >> 8, v & 0xFF];
  }

  // The 16-byte spare area of a page whose data starts at img[off].
  function spareFor(img, off, lba) {
    const ba = blockAddressField(lba);
    return [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, ...ba, ...ecc256(img, off + 256), ...ba, ...ecc256(img, off)];
  }

  const ascii = (img, off, n) => String.fromCharCode(...img.subarray(off, off + n));
  const be32 = (a, o) => ((a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3]) >>> 0;
  const putBe32 = (a, o, v) => { a[o] = v >>> 24; a[o + 1] = (v >>> 16) & 255; a[o + 2] = (v >>> 8) & 255; a[o + 3] = v & 255; };

  // ---------- the image ----------
  class Image {
    constructor(bytes) {
      this.img = bytes ? new Uint8Array(bytes) : new Uint8Array(IMAGE_BYTES).fill(0xFF);
      if (this.img.length !== IMAGE_BYTES) throw new Error("not a 4MB card image (8192 pages of 528 bytes)");
      this.touched = new Set();               // blocks changed since the last finalize
    }
    clone() { return new Image(this.img); }

    // Sample data is addressed by card byte address: physical block * 8 KB + offset.
    read(addr, n) {
      const out = new Uint8Array(n);
      let i = 0;
      while (i < n) {
        const page = Math.floor(addr / DATA), col = addr % DATA, k = Math.min(n - i, DATA - col);
        out.set(this.img.subarray(page * PAGE + col, page * PAGE + col + k), i);
        addr += k; i += k;
      }
      return out;
    }
    write(addr, bytes) {
      let i = 0;
      while (i < bytes.length) {
        const page = Math.floor(addr / DATA), col = addr % DATA, k = Math.min(bytes.length - i, DATA - col);
        this.img.set(bytes.subarray(i, i + k), page * PAGE + col);
        this.touched.add(Math.floor(page / PPB));
        addr += k; i += k;
      }
    }
    fill(addr, n, v) { this.write(addr, new Uint8Array(n).fill(v)); }

    blockLba(b) {
      for (let p = b * PPB; p < (b + 1) * PPB; p++) {
        const o = p * PAGE + DATA;
        if (this.img[o + 6] !== 0xFF || this.img[o + 7] !== 0xFF)
          return (((this.img[o + 6] << 8) | this.img[o + 7]) >> 1) & 0x3FF;
      }
      return b - 1;                           // seen on every card: physical n+1 = logical n
    }

    // Rewrites the spare areas of the changed blocks, the way the SP-202 leaves them: a
    // block without data is erased (all FF), a block with data gets the block address and
    // the ECC on all 16 pages.
    finalize() {
      for (const b of this.touched) {
        const lba = this.blockLba(b);
        let blank = true;
        for (let p = b * PPB; p < (b + 1) * PPB && blank; p++)
          for (let i = 0; i < DATA; i++) if (this.img[p * PAGE + i] !== 0xFF) { blank = false; break; }
        if (blank) { this.img.fill(0xFF, b * BLOCK_BYTES, (b + 1) * BLOCK_BYTES); continue; }
        for (let p = b * PPB; p < (b + 1) * PPB; p++)
          this.img.set(spareFor(this.img, p * PAGE, lba), p * PAGE + DATA);
      }
      this.touched.clear();
    }

    // Pages whose spare area does not match their data (ECC or block address).
    checkEcc() {
      let checked = 0, bad = [];
      for (let p = PPB; p < PAGES; p++) {
        const o = p * PAGE;
        let blank = true;
        for (let i = 0; i < PAGE; i++) if (this.img[o + i] !== 0xFF) { blank = false; break; }
        if (blank) continue;
        checked++;
        const want = spareFor(this.img, o, this.blockLba(Math.floor(p / PPB)));
        for (let i = 0; i < 16; i++) if (this.img[o + DATA + i] !== want[i]) { bad.push(p); break; }
      }
      return { checked, bad };
    }

    usedBlocks() {
      const out = [];
      for (let b = 0; b < BLOCKS; b++) {
        const a = this.img.subarray(b * BLOCK_BYTES, (b + 1) * BLOCK_BYTES);
        if (a.some(v => v !== 0xFF)) out.push(b);
      }
      return out;
    }

    diffBlocks(base) {
      const out = [];
      for (let b = 0; b < BLOCKS; b++) {
        const o = b * BLOCK_BYTES;
        for (let i = o; i < o + BLOCK_BYTES; i++)
          if (this.img[i] !== base.img[i]) { out.push(b); break; }
      }
      return out;
    }
    blockBytes(b) { return this.img.subarray(b * BLOCK_BYTES, (b + 1) * BLOCK_BYTES); }

    isFormatted() { return ascii(this.img, PPB * PAGE, 6) === "Roland" && ascii(this.img, PPB * PAGE + 16, 11) === "BOSS SP-202"; }
  }

  // ---------- a set of 16 pads: the card (C/D) or the BACKUP area (A/B) ----------
  const SPACES = {
    card: {
      banks: ["C", "D"], padBase: 0x10,
      param: 1 * BLOCK_DATA, table: 66,                       // physical block 1, page 0
      dataStart: 2 * BLOCK_DATA, dataEnd: BACKUP_BLOCK * BLOCK_DATA,
      toCard: a => a, header: img => img.isFormatted(),
    },
    backup: {
      banks: ["A", "B"], padBase: 0x00,
      param: BACKUP_BLOCK * BLOCK_DATA + 62 * BLOCK_DATA, table: 34,
      dataStart: 0x20000, dataEnd: 0x20000 + 62 * BLOCK_DATA, // internal-memory addresses
      toCard: a => BACKUP_BLOCK * BLOCK_DATA + (a - 0x20000),
      header: img => ascii(img.img, (BACKUP_BLOCK + 62) * BLOCK_BYTES, 16) === "*Parameter Area*",
    },
  };

  class Space {
    constructor(image, kind) {
      this.image = image; this.kind = kind; Object.assign(this, SPACES[kind]);
    }
    present() { return this.header(this.image); }
    names() { return this.banks.flatMap(b => [1, 2, 3, 4, 5, 6, 7, 8].map(i => b + i)); }
    entryAddr(i) { return this.param + this.table + 26 * i; }
    rawEntry(i) { return this.image.read(this.entryAddr(i), 26); }

    entry(i) {
      const r = this.rawEntry(i);
      const e = { index: i, name: this.names()[i], raw: r, empty: r[0] === 0xFF };
      if (e.empty) return e;
      e.mode = r[4]; e.grade = r[4] >> 6; e.stereo = !!(r[4] & 0x20);
      e.gate = !!(r[4] & 0x08); e.oneShot = !!(r[4] & 0x04);   // else TRIGGER, LOOP
      e.effect = { 0x00: "", 0x04: "RING MOD", 0x08: "FILTER 2", 0x10: "FILTER 1" }[r[1]] ?? `EFFECT ${r[1].toString(16)}`;
      e.effectLevel = r[8];
      e.bpm = r[2]; e.bpmRec = r[3];
      e.start = be32(r, 10); e.length = be32(r, 14); e.playStart = be32(r, 18); e.playEnd = be32(r, 22);
      e.rate = RATES[e.grade];
      e.seconds = e.length * 2 / (e.stereo ? 2 : 1) / e.rate;
      e.marked = e.playStart !== 0 || e.playEnd !== e.length;
      return e;
    }
    entries() { return Array.from({ length: 16 }, (_, i) => this.entry(i)); }
    used() { return this.entries().filter(e => !e.empty); }
    usedEnd() { return this.used().reduce((m, e) => Math.max(m, e.start + e.length), this.dataStart); }
    freeBytes() { return this.dataEnd - this.usedEnd(); }
    sample(e) { return this.image.read(this.toCard(e.start), e.length); }

    // The layout problems found: samples outside the area, overlapping, gaps.
    check() {
      const u = this.used().sort((a, b) => a.start - b.start), issues = [];
      let at = this.dataStart;
      for (const e of u) {
        if (e.start < this.dataStart || e.start + e.length > this.dataEnd) issues.push(`${e.name} is outside the sample area`);
        else if (e.start < at) issues.push(`${e.name} overlaps the previous sample`);
        else if (e.start > at) issues.push(`gap of ${e.start - at} bytes before ${e.name}`);
        at = Math.max(at, e.start + e.length);
      }
      return issues;
    }

    writeEntry(i, bytes) { this.image.write(this.entryAddr(i), Uint8Array.from(bytes)); }

    // Removes a pad and packs the samples after it down, as the SP-202 does.
    clear(i) {
      const e = this.entry(i);
      if (e.empty) return;
      const end = this.usedEnd(), tail = end - (e.start + e.length);
      if (tail > 0) this.image.write(this.toCard(e.start), this.image.read(this.toCard(e.start + e.length), tail));
      this.image.fill(this.toCard(end - e.length), e.length, 0xFF);
      for (const o of this.used()) {
        if (o.index === i || o.start <= e.start) continue;
        const r = Uint8Array.from(o.raw);
        putBe32(r, 10, o.start - e.length);
        this.writeEntry(o.index, r);
      }
      this.writeEntry(i, EMPTY_ENTRY);
    }

    // Puts a sample on a pad (replacing what was there), after the last sample.
    put(i, entry26, data) {
      this.clear(i);
      const start = this.usedEnd();
      if (start + data.length > this.dataEnd)
        throw new Error(`not enough memory: ${data.length} bytes needed, ${this.dataEnd - start} free`);
      this.image.write(this.toCard(start), data);
      const r = Uint8Array.from(entry26);
      r[0] = this.padBase + i;
      putBe32(r, 10, start);
      putBe32(r, 14, data.length);
      if (be32(r, 22) > data.length || be32(r, 22) === 0) { putBe32(r, 18, 0); putBe32(r, 22, data.length); }
      this.writeEntry(i, r);
    }
  }

  // ---------- pad files: SP202PAD, version, source pad name, 26-byte entry, sample ----------
  function padFile(space, e) {
    const data = space.sample(e);
    const out = new Uint8Array(8 + 1 + 2 + 26 + data.length);
    out.set([...PAD_FILE_MAGIC].map(c => c.charCodeAt(0)), 0);
    out[8] = 1;
    out.set([e.name.charCodeAt(0), e.name.charCodeAt(1)], 9);
    out.set(e.raw, 11);
    out.set(data, 37);
    return out;
  }
  function parsePadFile(bytes) {
    if (bytes.length < 37 || ascii(bytes, 0, 8) !== PAD_FILE_MAGIC) throw new Error("not an SP-202 pad file");
    const entry = bytes.slice(11, 37), data = bytes.slice(37);
    if (be32(entry, 14) !== data.length) throw new Error("pad file damaged: length does not match");
    return { source: ascii(bytes, 9, 2), entry, data };
  }

  return { PAGE, DATA, PAGES, PPB, BLOCKS, BLOCK_BYTES, IMAGE_BYTES, BACKUP_BLOCK, GRADES, SHORT, RATES,
           Image, Space, padFile, parsePadFile, ecc256 };
})();
