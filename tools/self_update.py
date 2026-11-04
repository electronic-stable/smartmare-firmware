"""
SmartMare 5V - one-click firmware update from the PC (what the Card Manager's UPDATE does)
Fabien Roffet for Electronic Stable - smartmare.com
Version 1.2.0 - 4 Nov 2026
SPDX-License-Identifier: GPL-3.0-or-later

For a card already on firmware 1.2.0 or later: sends a firmware over the serial link (key U),
the card checks its SHA-256, swaps it in (keeping the old one) and restarts. --back swaps back
to the previous firmware (key K). Prints the card's banner after the restart.
    python tools/self_update.py build/smartmare-5v-sp-202-firmware-v1.2.0.uf2 [--port COM5]
    python tools/self_update.py --back [--port COM5]
Needs pyserial.
"""
import argparse
import hashlib
import struct
import sys
import time

import serial


def uf2_to_bin(data):
    parts, end = [], 0
    for o in range(0, len(data) - 511, 512):
        flags, addr, size = struct.unpack_from("<III", data, o + 8)
        family = struct.unpack_from("<I", data, o + 28)[0]
        if flags & 0x2000 and family == 0xE48BFF57:       # the "absolute" block near the end of flash
            continue
        if not 0x10000000 <= addr < 0x11000000:
            continue
        parts.append((addr - 0x10000000, data[o + 32:o + 32 + size]))
        end = max(end, addr - 0x10000000 + size)
    out = bytearray(b"\xff" * end)
    for at, d in parts:
        out[at:at + len(d)] = d
    return bytes(out)


PENDING = {}                                    # bytes read but not yet split into lines, per port


def lines(s, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        PENDING[s.port] = PENDING.get(s.port, b"") + s.read(4096)
        while b"\n" in PENDING[s.port]:
            line, PENDING[s.port] = PENDING[s.port].split(b"\n", 1)
            yield line.decode("utf8", "replace").strip()
    raise TimeoutError("no answer from the card")


def wait(s, pred, timeout):
    for line in lines(s, timeout):
        if pred(line):
            return line


def banner(port):
    for _ in range(40):
        time.sleep(0.75)
        try:
            s = serial.Serial(port, 115200, timeout=0.2)
        except serial.SerialException:
            continue
        time.sleep(0.4)
        s.reset_input_buffer()
        s.write(b"hu")
        out = {}
        try:
            for line in lines(s, 3):
                if line.startswith("=="):
                    out["banner"] = line.strip("= ")
                if line.startswith("update:"):
                    out["update"] = line
                    break
        except TimeoutError:
            pass
        s.close()
        return out
    return {}


ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("uf2", nargs="?")
ap.add_argument("--back", action="store_true")
ap.add_argument("--port", default="COM5")
a = ap.parse_args()
s = serial.Serial(a.port, 115200, timeout=0.2)
time.sleep(0.4)
s.reset_input_buffer()
t0 = time.time()
if a.back:
    s.write(b"K")
    r = wait(s, lambda l: l.startswith(("UPDATE back", "ERR", "refused")), 20)
    print(r)
    if not r.startswith("UPDATE back"):
        sys.exit(1)
else:
    raw = open(a.uf2, "rb").read()
    fw = uf2_to_bin(raw) if raw[:4] == b"UF2\n" else raw
    s.write(b"U" + struct.pack(">I", len(fw)) + hashlib.sha256(fw).digest())
    r = wait(s, lambda l: l.startswith(("UPDATE ready", "ERR", "refused")), 8)
    print(r)
    if not r.startswith("UPDATE ready"):
        sys.exit(1)
    chunks = (len(fw) + 4095) // 4096
    for c in range(chunks):
        chunk = fw[c * 4096:(c + 1) * 4096].ljust(4096, b"\xff")
        s.write(b"C" + chunk + struct.pack(">H", sum(chunk) & 0xFFFF))
        r = wait(s, lambda l: l == f"OK {c}" or l.startswith("ERR"), 10)
        if r.startswith("ERR"):
            print(r)
            sys.exit(1)
    print(f"sent {len(fw) // 1024} KB in {time.time() - t0:.1f} s")
try:
    for key in ("UPDATE verified", "UPDATE swapping", "UPDATE done"):
        if not a.back or key != "UPDATE verified":
            print(wait(s, lambda l, k=key: l.startswith((k, "ERR")), 90))
except serial.SerialException:
    print("(the link dropped: the card is restarting)")
s.close()
info = banner(a.port)
print(f"after {time.time() - t0:.1f} s:", info.get("banner", "?"))
print(info.get("update", ""))
