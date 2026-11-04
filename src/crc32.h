/*
 * SmartMare 5V - CRC-32 for image dumps and sample sets
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.0 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * CRC-32 (zlib's), shared by the image dump (main.c) and the sample sets (set_store.c).
 */
#ifndef SMARTMARE_CRC32_H
#define SMARTMARE_CRC32_H

#include <stdint.h>

// Continues a CRC: start with 0, pass the result back in for the next piece.
uint32_t set_crc32(uint32_t crc, const uint8_t *p, uint32_t n);

#endif
