# SmartMare firmware

Firmware and web loaders for **SmartMare 5V**, by Electronic Stable: a card for 5 V SmartMedia
slots that emulates a 4 MB SmartMedia card (an RP2350A microcontroller and a 16 MB flash
instead of the original memory). More: [smartmare.com](https://smartmare.com).

Two firmwares, for the same card:

| Firmware | For | Loader page on the card's USB drive |
|---|---|---|
| `smartmedia_5v_sp-202_v<version>.uf2` | the BOSS SP-202: pads, sample sets, backup bank | `app/sp-202_loader.html` |
| `smartmedia_5v_generic_v<version>.uf2` | any gear with a 5 V 4 MB SmartMedia slot | `app/generic_loader.html` |

The version is set in `CMakeLists.txt` (`project(... VERSION 1.0.0 ...)`) and shown on the
card's USB serial port when it starts.

## What is here
- `src/` — the firmware: SmartMedia command set, the bus (PIO + DMA), the image in flash, USB.
- `boards/` — the board definition for the Pico SDK (RP2350A, 12 MHz crystal, 16 MB flash).
- `app/` — the loader pages. The build packs them into the firmware (`tools/build_drive.py`),
  so the card shows them on a small read-only USB drive.
- `tests/` — a simulated SmartMedia host, used by the self-test firmware.

## Build
You need:
- the [Raspberry Pi Pico SDK](https://github.com/raspberrypi/pico-sdk) 2.x (tested with 2.3.1);
- the Arm GNU toolchain (`arm-none-eabi-gcc`), CMake 3.13 or newer, Ninja and Python 3.

The simplest way to get all of them is Raspberry Pi's Pico extension for VS Code, or their
installers for Windows. Then, from this folder:

```
cmake -S . -B build -G Ninja -DPICO_SDK_PATH=<path to pico-sdk>
cmake --build build
```

If CMake cannot find the compiler, add `-DPICO_TOOLCHAIN_PATH=<path to the Arm toolchain>`.
If you already have picotool and pioasm, add `-Dpicotool_DIR=<dir>` and `-Dpioasm_DIR=<dir>`;
otherwise the SDK builds them, which needs a host C/C++ compiler. On Windows, keep the build
folder's path short: very long paths make the build fail.

The firmwares land in `build/`:

| File | What it is |
|---|---|
| `smartmedia_5v_sp-202_v<version>.uf2` | SP-202 firmware |
| `smartmedia_5v_generic_v<version>.uf2` | generic firmware |
| `smartmedia_selftest.uf2` | self test: checks the card against a simulated host. **It overwrites the card's memory**; load a normal firmware afterwards |
| `smartmedia_bringup.uf2` | first power-on checks of a new board |

## Load a firmware onto the card
**Take the card out of your gear (or switch the gear off) before connecting it to a computer.**
Then connect the card by USB-C.

- **With picotool** (the card restarts into its update mode by itself):
  ```
  picotool load -f -x build/smartmedia_5v_sp-202_v1.0.0.uf2
  ```
- **From the loader page:** open the page from the card's USB drive in Chrome or Edge,
  CONNECT, then use its firmware update.
- **By hand:** when the card is in update mode a drive called **RP2350** appears; copy the
  `.uf2` file onto it and the card restarts by itself. A card with no firmware at all starts
  in update mode when its BOOT pad is held to GND at power-up.

The loader pages need Chrome or Edge (Opera and Brave work too): Firefox and Safari cannot
open USB serial ports.

## Licence
Copyright (c) 2026 Fabien Roffet (Electronic Stable).

- **The firmware** — everything outside `app/` (`src/`, `boards/`, `tests/`, `tools/`, the build
  files) — is free software under the **GNU General Public License v3.0 or later** (`LICENSE`).
  You may use, study, change and share it; if you distribute it or a changed version, as a
  file or inside a device, you must pass on its source code under the same licence.
- **The loader pages** in `app/` are under the **MIT licence** (`app/LICENSE`): use them for
  anything, keep the copyright notice.

The firmware also uses the Raspberry Pi Pico SDK (BSD 3-Clause) and TinyUSB (MIT):
see `THIRD_PARTY_NOTICES.txt`.

## Contact
support@smartmare.com
