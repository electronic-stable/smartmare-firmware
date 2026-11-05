/*
 * SmartMare 5V - the 4 MB SmartMedia image in the W25Q128 flash
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.8 - 5 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * SmartMedia image in the W25Q128:
 *   0 .. 1 MB   firmware
 *   1 .. 5 MB   data areas, page p at 1 MB + p * 512 (block b = 8 KB at 1 MB + b * 8 KB)
 *   5 .. 7 MB   spare areas, block b in its own 4 KB sector at 5 MB + b * 4 KB (16 x 16 B used)
 * A block erase is 2 data sectors + 1 spare sector. A program only clears bits, as on NAND.
 */
#ifndef SM_FLASH_STORAGE_H
#define SM_FLASH_STORAGE_H

#include <stdbool.h>

#include "sm_core.h"

#define SM_FLASH_DATA_OFFSET   (1u << 20)
#define SM_FLASH_SPARE_OFFSET  (5u << 20)
#define SM_FLASH_IMAGE_END     (7u << 20)

void sm_flash_storage_get(sm_storage_t *s);

// True while a program or erase is running: the flash is not readable through XIP.
extern volatile bool sm_flash_writing;

// Programs whose result differs from the data written: the page was not erased first
// (programming only clears bits). Counts since boot.
extern volatile uint32_t sm_flash_unerased_programs;

// False if the firmware has grown into the image area.
bool sm_flash_storage_layout_ok(void);

#endif
