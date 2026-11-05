/*
 * SmartMare 5V - Pico SDK board definition: RP2350A, 12 MHz crystal, 16 MB flash
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.8 - 5 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Board header: SmartMedia 5V card emulator v0.2 (RP2350A QFN-60).
 *
 * - 12 MHz crystal (Abracon ABM8-272-T3, same part and load caps as Pico 2)
 * - 16 MB W25Q128JVSIQ QSPI flash
 * - No UART brought out: stdio goes over USB
 *
 * Board-specific GPIOs (card bus, LED, VCC sense) live in src/board_pins.h.
 */

// -----------------------------------------------------
// NOTE: THIS HEADER IS ALSO INCLUDED BY ASSEMBLER SO
//       SHOULD ONLY CONSIST OF PREPROCESSOR DIRECTIVES
// -----------------------------------------------------

// pico_cmake_set PICO_PLATFORM=rp2350

#ifndef _BOARDS_SMARTMEDIA_RP2350A_H
#define _BOARDS_SMARTMEDIA_RP2350A_H

// For board detection
#define SMARTMEDIA_RP2350A

// --- RP2350 VARIANT ---
// QFN-60, 30 GPIOs
#define PICO_RP2350A 1

// --- CLOCK ---
// 12 MHz is the SDK default; stated here so it is not a silent assumption.
#ifndef XOSC_HZ
#define XOSC_HZ 12000000u
#endif

// --- LED ---
#ifndef PICO_DEFAULT_LED_PIN
#define PICO_DEFAULT_LED_PIN 16
#endif

// --- UART ---
// No UART pins on this board; leave PICO_DEFAULT_UART undefined.

// --- FLASH ---
// W25Q128JV is command-compatible with the W25Q080 boot stage 2.
#define PICO_BOOT_STAGE2_CHOOSE_W25Q080 1

#ifndef PICO_FLASH_SPI_CLKDIV
#define PICO_FLASH_SPI_CLKDIV 2
#endif

// pico_cmake_set_default PICO_FLASH_SIZE_BYTES = (16 * 1024 * 1024)
#ifndef PICO_FLASH_SIZE_BYTES
#define PICO_FLASH_SIZE_BYTES (16 * 1024 * 1024)
#endif

// pico_cmake_set_default PICO_RP2350_A2_SUPPORTED = 1
#ifndef PICO_RP2350_A2_SUPPORTED
#define PICO_RP2350_A2_SUPPORTED 1
#endif

#endif
