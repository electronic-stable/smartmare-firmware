/*
 * SmartMare 5V - the card over USB (Web Serial): commands, dump and write
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.1 - 4 Nov 2026
 * SPDX-License-Identifier: MIT
 *
 * The emulator over USB (Web Serial): text lines in, keys and blocks out.
 * Protocol (src/main.c): s status, h help, v log level, D dump ("P <page> <hex>" lines,
 * "END <n> pages"), W write ("WRITE ready", then 'B' + block + 8448 bytes + sum, answered
 * "OK <b>" / "ERR <b> ..."; 'Q' ends).
 */
"use strict";

class CardLink {
  constructor(handlers) {
    this.h = handlers;            // onLine(text, quiet), onStatus(obj), onClose(), onInfo(obj)
    this.port = null;
    this.waiters = [];
    this.busy = false;
    this.info = { firmware: false, canWrite: false, layoutOk: true, powered: null };
  }

  static supported() { return "serial" in navigator; }

  // port: one already allowed (navigator.serial.getPorts(), to reconnect after the card restarts),
  // or none to let the user pick it.
  async connect(port) {
    port = port || await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x2E8A }] });
    await port.open({ baudRate: 115200, bufferSize: 1 << 16 });
    await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.closing = false;
    this.loopDone = this.readLoop();
    port.addEventListener("disconnect", () => this.closed());
    // The firmware prints its help and a status line when a terminal connects; ask again
    // in case it already did.
    await this.send("h");
    await this.send("s");
    await this.send("u");                    // the previous firmware kept for GO BACK, if any
  }

  // Frees the port for other programs: stop the read loop first (it would take the port
  // again), then release the writer, then close.
  async disconnect() {
    this.closing = true;
    try { await this.reader?.cancel(); } catch (e) {}
    try { await this.loopDone; } catch (e) {}
    try { this.writer?.releaseLock(); } catch (e) {}
    try { await this.port?.close(); } catch (e) {}
    this.closed();
  }

  closed() {
    if (!this.port) return;
    this.port = null;
    for (const w of this.waiters) w.reject(new Error("card disconnected"));
    this.waiters = [];
    this.h.onClose();
  }

  // Bytes in: text lines, except while a binary payload is expected (a sample set after
  // its "SETDATA <length>" line), which goes to this.raw instead.
  async readLoop() {
    const dec = new TextDecoder();
    let buf = new Uint8Array(0);
    try {
      while (this.port?.readable && !this.closing) {
        this.reader = this.port.readable.getReader();
        try {
          while (true) {
            const { value, done } = await this.reader.read();
            if (done) break;
            const joined = new Uint8Array(buf.length + value.length);
            joined.set(buf);
            joined.set(value, buf.length);
            buf = joined;
            let at = 0;
            while (at < buf.length) {
              if (this.raw) {
                const k = Math.min(this.raw.want - this.raw.got, buf.length - at);
                this.raw.data.set(buf.subarray(at, at + k), this.raw.got);
                this.raw.got += k;
                at += k;
                this.raw.progress?.(this.raw.got, this.raw.want);
                if (this.raw.got === this.raw.want) { const r = this.raw; this.raw = null; r.done(r.data); }
                continue;
              }
              const nl = buf.indexOf(10, at);
              if (nl < 0) break;
              const line = dec.decode(buf.subarray(at, nl)).replace(/\r$/, "");
              at = nl + 1;
              this.line(line);
            }
            buf = buf.slice(at);
          }
        } finally {
          this.reader.releaseLock();
        }
      }
    } catch (e) {
      if (!this.closing) this.h.onLine(`USB read stopped: ${e.message}`, false, "err");
    }
    if (!this.closing) this.closed();
  }

  line(text) {
    const pageLine = text.startsWith("P ") || /^C \d+ [0-9a-f]{8}$/.test(text) || text.startsWith("BEND ");
    this.parse(text);
    for (const w of [...this.waiters]) if (w.test(text)) { w.resolve(text); this.waiters.splice(this.waiters.indexOf(w), 1); }
    for (const w of this.waiters) w.each?.(text);
    if (!pageLine) this.h.onLine(text, false, "rx");
  }

  // What the firmware tells about itself: banner, keys, power and health.
  parse(t) {
    // "== SmartMare 5V SP-202 firmware v1.1.0, SmartMedia emulator, ..." (before 1.0.0: "== SmartMedia emulator, ...")
    if (/^== (SmartMare|SmartMedia emulator)/.test(t)) {
      this.info.firmware = true;
      this.info.banner = t.replace(/=/g, "").trim();
      this.info.fwVersion = (t.match(/firmware v(\d+\.\d+\.\d+)/) || [])[1] || null;
    }
    if (t.startsWith("keys:")) {
      this.info.canWrite = /W = write/.test(t); this.info.canDump = /D = dump/.test(t);
      this.info.canSelfUpdate = /U\/K\/u = firmware update/.test(t);     // firmware 1.2.0 and later
    }
    const prev = t.match(/^update: previous (.+) (\d+)$/);
    if (prev) this.info.previousFw = prev[1];
    if (t === "update: none") this.info.previousFw = null;
    if (t.startsWith("ERROR: the firmware overlaps")) this.info.layoutOk = false;
    if (/card power ON/.test(t)) this.info.powered = true;
    if (/card power OFF/.test(t)) this.info.powered = false;
    const m = t.match(/VCC (\d+\.\d+) V, card (ACTIVE|off)/);
    if (m) {
      const num = re => { const x = t.match(re); return x ? +x[1] : null; };
      this.info.powered = m[2] === "ACTIVE";
      this.info.vcc = +m[1];
      this.info.health = {
        wrong: num(/wrong (\d+)/), overflows: num(/FIFO overflows (\d+)/),
        unerased: num(/unerased pages (\d+)/), queued: num(/nothing queued (\d+)/),
        late: num(/\/WE rise (\d+)/), reads: num(/reads checked (\d+)/),
        programs: num(/programs (\d+)/), erases: num(/erases (\d+)/),
      };
    }
    this.h.onInfo(this.info);
  }

  async send(text) {
    if (!this.port) throw new Error("not connected");
    this.h.onLine(text, false, "tx");
    await this.writer.write(new TextEncoder().encode(text));
  }

  waitFor(test, timeoutMs, each) {
    return new Promise((resolve, reject) => {
      const w = { test, each, resolve: v => { clearTimeout(w.timer); resolve(v); }, reject };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error("timeout: no answer from the card"));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  async exclusive(fn) {
    if (this.busy) throw new Error("the card is busy with another job");
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  // Copies the whole image from the card. progress(pagesSoFar). The firmware follows each
  // block with "C <block> <crc32>"; a block whose copy does not match (a line damaged on
  // the way) is asked for again with key B.
  dump(progress) {
    return this.exclusive(async () => {
      const img = new Uint8Array(SM.IMAGE_BYTES).fill(0xFF);
      const crcs = new Map();
      let pages = 0;
      const BLOCK = SM.PPB * SM.PAGE;
      const each = t => {
        if (t.startsWith("C ")) { const [, b, c] = t.split(" "); crcs.set(+b, parseInt(c, 16) >>> 0); return; }
        if (!t.startsWith("P ")) return;
        const sp = t.indexOf(" ", 2), page = +t.slice(2, sp), hex = t.slice(sp + 1);
        if (hex.length !== 2 * SM.PAGE || !(page >= 0 && page < SM.PAGES) || /[^0-9A-F]/.test(hex)) return;
        const o = page * SM.PAGE;
        for (let i = 0; i < SM.PAGE; i++) img[o + i] = parseInt(hex.substr(2 * i, 2), 16);
        pages++;
        if (pages % 64 === 0) progress?.(pages);
      };
      const done = this.waitFor(t => /^END \d+ pages/.test(t) || t.startsWith("refused"), 300000, each);
      await this.send("D");
      const end = await done;
      if (end.startsWith("refused")) throw new Error(end);
      const okBlock = b => crcs.get(b) === crc32(img.subarray(b * BLOCK, (b + 1) * BLOCK));
      if (!crcs.size) {                       // an older firmware: no block checks
        const expected = +end.match(/END (\d+)/)[1];
        if (pages !== expected) throw new Error(`copy damaged (${pages} pages of ${expected}): read again`);
        return new SM.Image(img);
      }
      const bad = [];
      for (let b = 0; b < SM.BLOCKS; b++) if (!okBlock(b)) bad.push(b);
      if (bad.length) this.h.onLine(`${bad.length} block${bad.length > 1 ? "s" : ""} damaged on the way, reading ${bad.length > 1 ? "them" : "it"} again`, false, "warn");
      for (const b of bad) {
        let ok = false;
        for (let attempt = 0; attempt < 5 && !ok; attempt++) {
          img.fill(0xFF, b * BLOCK, (b + 1) * BLOCK);
          crcs.delete(b);
          const got = this.waitFor(t => t === `BEND ${b}` || t.startsWith("refused") || t.startsWith("ERR"), 10000, each);
          this.h.onLine(`B ${b}`, true);
          await this.writer.write(Uint8Array.from([0x42, b >> 8, b & 0xFF]));
          const r = await got;
          if (!r.startsWith("BEND")) throw new Error(r);
          ok = okBlock(b);
        }
        if (!ok) throw new Error(`block ${b} arrives damaged every time: read again`);
      }
      return new SM.Image(img);
    });
  }

  // A blank 4 MB image (key E, confirmed with Y): the generic card has no sample sets.
  eraseImage(progress) {
    return this.exclusive(async () => {
      const done = this.waitFor(t => /^image erased/.test(t) || t.startsWith("refused") || t.startsWith("cancelled"), 120000,
                                t => { const m = t.match(/^\s*(\d+) \/ (\d+) blocks/); if (m) progress?.(+m[1], +m[2]); });
      const asked = this.waitFor(t => /Press Y to confirm/.test(t) || t.startsWith("refused"), 5000);
      await this.send("E");
      const a = await asked;
      if (a.startsWith("refused")) throw new Error(a);
      await this.send("Y");
      const end = await done;
      if (!end.startsWith("image erased")) throw new Error(end);
    });
  }

  // A blank card: the 4 MB image and every sample set (key Z, confirmed with Y).
  eraseAll(progress) {
    return this.exclusive(async () => {
      const done = this.waitFor(t => /^card erased/.test(t) || t.startsWith("refused") || t.startsWith("cancelled"), 120000,
                                t => { const m = t.match(/image (\d+) \/ (\d+) blocks/); if (m) progress?.(+m[1], +m[2]); else if (/sample sets/.test(t)) progress?.(-1); });
      const asked = this.waitFor(t => /Press Y to confirm/.test(t) || t.startsWith("refused"), 5000);
      await this.send("Z");
      const a = await asked;
      if (a.startsWith("refused")) throw new Error(a);
      await this.send("Y");
      const end = await done;
      if (!end.startsWith("card erased")) throw new Error(end);
    });
  }

  // ---------- sample sets kept on the card ----------
  // [{index, length, crc, stamp, name}] and the free / total bytes.
  listSets() {
    return this.exclusive(async () => {
      const sets = [];
      const done = this.waitFor(t => /^SETS END/.test(t) || t.startsWith("ERR"), 10000, t => {
        const m = t.match(/^SET (\d+) (\d+) ([0-9a-f]{8}) (\d+) (.*)$/);
        if (m) sets.push({ index: +m[1], length: +m[2], crc: m[3], stamp: +m[4], name: m[5] });
      });
      await this.send("L");
      const end = await done;
      if (end.startsWith("ERR")) throw new Error(end.slice(4));
      const [, free, capacity] = end.match(/SETS END (\d+) (\d+)/).map(Number);
      return { sets, free, capacity };
    });
  }

  saveSet(name, bytes, progress) {
    return this.exclusive(async () => {
      const nm = new TextEncoder().encode(name).slice(0, 40);
      const head = new Uint8Array(1 + 1 + nm.length + 12);
      const dv = new DataView(head.buffer);
      head[0] = 0x53;                                   // 'S'
      head[1] = nm.length;
      head.set(nm, 2);
      dv.setUint32(2 + nm.length, bytes.length, true);
      dv.setUint32(6 + nm.length, crc32(bytes), true);
      dv.setUint32(10 + nm.length, Math.floor(Date.now() / 1000) - new Date().getTimezoneOffset() * 60, true);   // local time, as FAT dates are
      const ready = this.waitFor(t => t.startsWith("SET READY") || t.startsWith("ERR"), 60000);
      this.h.onLine(`S (save set "${name}", ${bytes.length} bytes)`, false, "tx");
      await this.writer.write(head);
      const r = await ready;
      if (r.startsWith("ERR")) throw new Error(r.slice(4));
      const saved = this.waitFor(t => t.startsWith("SET SAVED") || t.startsWith("ERR"), 60000);
      for (let at = 0; at < bytes.length; at += 16384) {
        await this.writer.write(bytes.subarray(at, Math.min(bytes.length, at + 16384)));
        progress?.(Math.min(bytes.length, at + 16384), bytes.length);
      }
      const s2 = await saved;
      if (s2.startsWith("ERR")) throw new Error(s2.slice(4));
    });
  }

  getSet(index, progress) {
    return this.exclusive(async () => {
      let resolveData, rejectData;
      const data = new Promise((res, rej) => { resolveData = res; rejectData = rej; });
      const head = this.waitFor(t => t.startsWith("SETDATA ") || t.startsWith("ERR"), 10000);
      await this.writer.write(new Uint8Array([0x47, index]));       // 'G' i
      const h = await head;
      if (h.startsWith("ERR")) throw new Error(h.slice(4));
      const [, len, crc] = h.match(/SETDATA (\d+) ([0-9a-f]{8})/);
      this.raw = { want: +len, got: 0, data: new Uint8Array(+len), done: resolveData, progress };
      const timer = setTimeout(() => { this.raw = null; rejectData(new Error("timeout while reading the set")); }, 120000);
      const bytes = await data;
      clearTimeout(timer);
      if (crc32(bytes) !== parseInt(crc, 16)) throw new Error("the set came back damaged (CRC)");
      return bytes;
    });
  }

  deleteSet(index) {
    return this.exclusive(async () => {
      const done = this.waitFor(t => t.startsWith("SET DELETED") || t.startsWith("ERR"), 10000);
      await this.writer.write(new Uint8Array([0x58, index]));       // 'X' i
      const r = await done;
      if (r.startsWith("ERR")) throw new Error(r.slice(4));
    });
  }

  // One-click update (firmware 1.2.0+): sends the firmware (binary, from 0x10000000) in 4 KB
  // chunks into the card's staging area; the card checks its SHA-256, swaps it with the running
  // firmware (kept for goBack) and restarts. progress(done, total).
  sendUpdate(bin, sha, progress) {
    return this.exclusive(async () => {
      const ready = this.waitFor(t => t.startsWith("UPDATE ready") || t.startsWith("ERR") || t.startsWith("refused"), 8000);
      const hdr = new Uint8Array(1 + 4 + 32);
      hdr[0] = 0x55;                                                  // 'U'
      new DataView(hdr.buffer).setUint32(1, bin.length);
      hdr.set(sha, 5);
      await this.writer.write(hdr);
      const r = await ready;
      if (!r.startsWith("UPDATE ready")) throw new Error(r);
      const chunks = Math.ceil(bin.length / 4096);
      for (let c = 0; c < chunks; c++) {
        const pkt = new Uint8Array(1 + 4096 + 2).fill(0xFF);
        pkt[0] = 0x43;                                                // 'C'
        pkt.set(bin.subarray(c * 4096, (c + 1) * 4096), 1);
        let sum = 0;
        for (let i = 1; i <= 4096; i++) sum = (sum + pkt[i]) & 0xFFFF;
        pkt[4097] = sum >> 8; pkt[4098] = sum & 0xFF;
        const ok = this.waitFor(t => t === `OK ${c}` || t.startsWith("ERR"), 10000);
        await this.writer.write(pkt);
        const a = await ok;
        if (a.startsWith("ERR")) throw new Error(a);
        progress?.(c + 1, chunks);
      }
      const v = await this.waitFor(t => t.startsWith("UPDATE verified") || t.startsWith("ERR"), 20000);
      if (v.startsWith("ERR")) throw new Error(v);
      const d = await this.waitFor(t => t.startsWith("UPDATE done") || t.startsWith("ERR"), 90000);
      if (d.startsWith("ERR")) throw new Error(d);
    });
  }

  // GO BACK: the card swaps back to the firmware it kept and restarts.
  goBack() {
    return this.exclusive(async () => {
      const first = this.waitFor(t => t.startsWith("UPDATE back") || t.startsWith("ERR") || t.startsWith("refused"), 20000);
      await this.send("K");
      const r = await first;
      if (!r.startsWith("UPDATE back")) throw new Error(r);
      const d = await this.waitFor(t => t.startsWith("UPDATE done") || t.startsWith("ERR"), 90000);
      if (d.startsWith("ERR")) throw new Error(d);
    });
  }

  // Writes blocks of an image. progress(done, total, block).
  writeBlocks(image, blocks, progress) {
    return this.exclusive(async () => {
      const ready = this.waitFor(t => t.startsWith("WRITE ready") || t.startsWith("refused"), 5000);
      await this.send("W");
      const r = await ready;
      if (r.startsWith("refused")) throw new Error(r);
      try {
        for (let n = 0; n < blocks.length; n++) {
          const b = blocks[n], data = image.blockBytes(b);
          let sum = 0;
          for (const v of data) sum = (sum + v) & 0xFFFF;
          const pkt = new Uint8Array(3 + data.length + 2);
          pkt.set([0x42, b >> 8, b & 0xFF]);
          pkt.set(data, 3);
          pkt.set([sum >> 8, sum & 0xFF], 3 + data.length);
          const ans = this.waitFor(t => t.startsWith(`OK ${b}`) || t.startsWith(`ERR ${b}`) || t.startsWith("ERR"), 20000);
          await this.writer.write(pkt);
          const a = await ans;
          if (!a.startsWith("OK")) throw new Error(`block ${b}: ${a}`);
          progress?.(n + 1, blocks.length, b);
        }
      } finally {
        const end = this.waitFor(t => t.startsWith("WRITE end"), 5000).catch(() => null);
        await this.writer.write(new TextEncoder().encode("Q"));
        await end;
      }
    });
  }
}

// CRC-32 (zlib), as the firmware computes it.
const crc32 = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return bytes => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
})();
