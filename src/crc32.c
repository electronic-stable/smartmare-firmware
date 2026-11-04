/*
 * SmartMare 5V - CRC-32 for image dumps and sample sets
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.1 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "crc32.h"

uint32_t set_crc32(uint32_t crc, const uint8_t *p, uint32_t n) {
    crc = ~crc;
    while (n--) {
        crc ^= *p++;
        for (int k = 0; k < 8; k++)
            crc = crc >> 1 ^ (0xEDB88320u & -(crc & 1));
    }
    return ~crc;
}
