# SmartMare firmware

Firmware and web loaders for the **SmartMare** cards, by Electronic Stable: cards that emulate
SmartMedia memory cards for vintage samplers and other gear, with an RP2350A microcontroller and
flash memory instead of the original chips, and USB-C to manage them from a computer.
More: [smartmare.com](https://smartmare.com).

## Get a SmartMare
The cards are **for sale**, assembled and tested, with the firmware already on them:
**[smartmare.com](https://smartmare.com)**. They give vintage Roland, BOSS and other SmartMedia gear
new and modern features:

- **No more hunting for rare, worn-out cards:** a new card, made today, that your gear takes
  as its own.
- **USB-C to your computer:** the card shows up as a drive with its own editor page; no
  software to install, it runs in Chrome or Edge.
- **Back up and restore** the whole card from the editor page, and keep as many copies as you like.
- **On the SP-202:** see and edit your pads, copy them between banks, drop your own audio
  files on pads, trim and loop them, and keep whole sample sets on the card itself.
- **Firmware updates** from the editor page: new features without opening anything.
- **Open source:** read it, change it, build it yourself (below).

SmartMedia is a trademark of Toshiba; Roland and BOSS are trademarks of Roland Corporation.
SmartMare and Electronic Stable are not affiliated with them.

## Versions
The version is set in `CMakeLists.txt` (`project(... VERSION 1.2.0 ...)`), is part of each
firmware's file name, and is shown on the card's USB serial port when it starts.

## SmartMare 5V
A 4 MB 5 V SmartMedia card. Two firmwares, for the same card:

| Firmware | For | Loader page on the card's USB drive |
|---|---|---|
| `smartmare-5v-sp-202-firmware-v<version>.uf2` | the BOSS SP-202: pads, sample sets, backups of banks A/B | SP-202 Card Manager (`app/sp-202_loader.html`) |
| `smartmare-5v-generic-firmware-v<version>.uf2` | any gear with a 5 V 4 MB SmartMedia slot | Generic Card Manager (`app/generic_loader.html`) |

## SmartMare 3.3V
A 16 MB 3.3 V SmartMedia card, for the BOSS SP-303 and other 3.3 V gear. **Coming soon:** the
board is designed, its firmware is not in this repository yet. It will follow the same names
(`smartmare-3v3-..._v<version>.uf2`).

## What is here
- `src/` — the firmware: SmartMedia command set, the bus (PIO + DMA), the image in flash, USB.
- `boards/` — the board definition for the Pico SDK (RP2350A, 12 MHz crystal, 16 MB flash; SmartMare 5V).
- `app/` — the Card Manager pages. The build packs them into the firmware (`tools/build_drive.py`),
  so the card shows them on a small read-only USB drive. The latest ones are also online:
  https://smartmare.com/app/sp-202-card-manager.html and https://smartmare.com/app/generic-card-manager.html.
- `tools/self_update.py` — the one-click firmware update from a computer (what the pages' UPDATE does).
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
| `smartmare-5v-sp-202-firmware-v<version>.uf2` | SmartMare 5V, SP-202 firmware |
| `smartmare-5v-generic-firmware-v<version>.uf2` | SmartMare 5V, generic firmware |
| `smartmare-sp-202-card-manager-v<version>.html`, `smartmare-generic-card-manager-v<version>.html` | the Card Manager pages, as on the card |
| `smartmedia_selftest.uf2` | self test: checks the card against a simulated host. **It overwrites the card's memory**; load a normal firmware afterwards |
| `smartmedia_bringup.uf2` | first power-on checks of a new board |

## Load a firmware onto the card
**Take the card out of your gear (or switch the gear off) before connecting it to a computer.**
Then connect the card by USB-C.

- **From the Card Manager (firmware 1.2.0 and later):** open the page from the card's USB drive
  (or online) in Chrome or Edge, CONNECT, then CHOOSE .UF2 (or GET the latest) and UPDATE. The card
  receives the firmware over USB, checks its SHA-256, swaps it in and restarts; the previous one is
  kept, and GO BACK returns to it. The same from a computer:
  ```
  python tools/self_update.py build/smartmare-5v-sp-202-firmware-v1.2.0.uf2
  python tools/self_update.py --back
  ```
- **With picotool** (any firmware; the card restarts into its update mode by itself):
  ```
  picotool load -f -x build/smartmare-5v-sp-202-firmware-v1.2.0.uf2
  ```
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
