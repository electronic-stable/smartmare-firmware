/*
 * SmartMare 5V - one-click firmware update over the USB serial link
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.1 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The first MB of flash: the running firmware from 0 (at most STAGE_MAX), a staging area from
 * STAGE_OFFSET, and a record of what the staging area holds in its last sector. The card image
 * (1-7 MB) and the sample sets (7-16 MB) are never touched.
 *
 *   U <len:4> <sha256:32>   receive a firmware: "UPDATE ready", then per 4 KB chunk
 *                           'C' <4096 bytes> <sum:2> -> "OK <n>"; then the SHA-256 of the whole
 *                           staged image is checked ("UPDATE verified" / "ERR sha"), the two
 *                           halves are SWAPPED sector by sector (the old firmware moves into the
 *                           staging area, for K) and the card restarts ("UPDATE done").
 *   K                       go back: swaps again with the previous firmware, if its record and
 *                           SHA-256 are right, and restarts.
 *   u                       "update: previous <version> <len>" or "update: none".
 *
 * The firmware runs from RAM (copy_to_ram), so rewriting flash under it is safe. If power is cut
 * during the swap, the RP2350 boot ROM finds no valid image and shows its RP2350 drive: drag the
 * .uf2 onto it to repair the card.
 */
#include "fw_update.h"

#include <stdio.h>
#include <string.h>

#include "hardware/flash.h"
#include "hardware/sync.h"
#include "hardware/watchdog.h"
#include "pico/sha256.h"
#include "pico/stdlib.h"

#define SECTOR        FLASH_SECTOR_SIZE                 // 4 KB
#define STAGE_OFFSET  (512u * 1024u)
#define RECORD_OFFSET (1024u * 1024u - SECTOR)          // the record: last sector of the first MB
#define STAGE_MAX     (RECORD_OFFSET - STAGE_OFFSET)    // 508 KB
#define RECORD_MAGIC  0x50554D53u                       // "SMUP"

typedef struct {
    uint32_t magic, len;
    uint8_t sha[32];
    char version[32];                                   // e.g. "SP-202 firmware v1.2.0"
} record_t;

extern char __flash_binary_end;
static uint8_t buf_a[SECTOR], buf_b[SECTOR];

static const uint8_t *xip(uint32_t offset) { return (const uint8_t *)(XIP_BASE + offset); }

static int rd(void) {
    // up to 3 s, in slices: the watchdog (2 s) must keep being fed while the PC is slow
    for (int i = 0; i < 6; i++) {
        watchdog_update();
        int c = getchar_timeout_us(500000);
        if (c != PICO_ERROR_TIMEOUT) return c;
    }
    return PICO_ERROR_TIMEOUT;
}

static void sector_write(uint32_t offset, const uint8_t *data) {
    uint32_t irq = save_and_disable_interrupts();
    flash_range_erase(offset, SECTOR);
    flash_range_program(offset, data, SECTOR);
    restore_interrupts(irq);
    watchdog_update();
}

static void sha_of(uint32_t offset, uint32_t len, uint8_t out[32]) {
    pico_sha256_state_t st;
    pico_sha256_start_blocking(&st, SHA256_BIG_ENDIAN, false);
    for (uint32_t o = 0; o < len; o += SECTOR) {
        uint32_t n = len - o < SECTOR ? len - o : SECTOR;
        memcpy(buf_a, xip(offset + o), n);                // through RAM: flash reads stay simple
        pico_sha256_update_blocking(&st, buf_a, n);
        watchdog_update();
    }
    sha256_result_t r;
    pico_sha256_finish(&st, &r);
    memcpy(out, r.bytes, 32);
}

// The version string inside a firmware image: the "SP-202 firmware v1.2.0" of its banner.
static void version_of(uint32_t offset, uint32_t len, char out[32]) {
    static const char key[] = "firmware v";
    strcpy(out, "unknown");
    const uint8_t *p = xip(offset);
    for (uint32_t i = 16; i + sizeof key + 8 < len; i++)
        if (p[i] == 'f' && memcmp(p + i, key, sizeof key - 1) == 0) {
            uint32_t s = i;                               // back to the word before: "SP-202 " / "generic "
            while (s > i - 16 && p[s - 1] != '"' && p[s - 1] >= ' ' && p[s - 1] < 127) s--;
            uint32_t e = i + sizeof key - 1;
            while (e < len && e - s < 31 && ((p[e] >= '0' && p[e] <= '9') || p[e] == '.')) e++;
            memcpy(out, p + s, e - s);
            out[e - s] = 0;
            const char *v = strstr(out, "5V ");
            if (v) memmove(out, v + 3, strlen(v + 3) + 1);
            return;
        }
}

static uint32_t running_len(void) {
    return (uint32_t)((uintptr_t)&__flash_binary_end - XIP_BASE);
}

// Swaps the first `len` bytes of the firmware and the staging area, sector by sector, then
// records what the staging area holds now (the previous firmware) and restarts.
static void swap_and_restart(uint32_t new_len) {
    uint32_t old_len = running_len();
    uint32_t n = ((new_len > old_len ? new_len : old_len) + SECTOR - 1) / SECTOR;
    record_t rec = {RECORD_MAGIC, old_len, {0}, ""};
    sha_of(0, old_len, rec.sha);
    version_of(0, old_len, rec.version);
    printf("UPDATE swapping %lu sectors\n", (unsigned long)n);
    stdio_flush();
    sleep_ms(300);                          // the lines must leave over USB before interrupts go off
    for (uint32_t i = 0; i < n; i++) {
        memcpy(buf_a, xip(i * SECTOR), SECTOR);                    // the running firmware
        memcpy(buf_b, xip(STAGE_OFFSET + i * SECTOR), SECTOR);     // the new one
        sector_write(i * SECTOR, buf_b);
        sector_write(STAGE_OFFSET + i * SECTOR, buf_a);
    }
    memset(buf_a, 0xFF, SECTOR);
    memcpy(buf_a, &rec, sizeof rec);
    sector_write(RECORD_OFFSET, buf_a);
    printf("UPDATE done, restarting\n");
    stdio_flush();
    sleep_ms(300);
    watchdog_hw->scratch[0] = FW_UPDATE_RESTART;   // a restart on purpose, not a stuck firmware
    watchdog_reboot(0, 0, 10);
    while (true) tight_loop_contents();
}

void fw_update_receive(bool powered) {
    if (powered) { printf("refused: switch the SP-202 off first\n"); return; }
    uint8_t hdr[36];
    for (int i = 0; i < 36; i++) {
        int v = rd();
        if (v < 0) { printf("ERR header\n"); return; }
        hdr[i] = (uint8_t)v;
    }
    uint32_t len = (uint32_t)hdr[0] << 24 | (uint32_t)hdr[1] << 16 | (uint32_t)hdr[2] << 8 | hdr[3];
    if (len < 1024 || len > STAGE_MAX || running_len() > STAGE_MAX) {
        printf("ERR size %lu (at most %lu)\n", (unsigned long)len, (unsigned long)STAGE_MAX);
        return;
    }
    // the staging area is about to change: forget the previous firmware it held (no GO BACK)
    memset(buf_a, 0xFF, SECTOR);
    sector_write(RECORD_OFFSET, buf_a);
    printf("UPDATE ready %lu\n", (unsigned long)len);
    fflush(stdout);
    uint32_t chunks = (len + SECTOR - 1) / SECTOR;
    for (uint32_t c = 0; c < chunks; c++) {
        int k = rd();
        if (k != 'C') { printf("ERR chunk %lu\n", (unsigned long)c); return; }
        uint16_t sum = 0;
        for (int i = 0; i < SECTOR; i++) {
            int v = rd();
            if (v < 0) { printf("ERR chunk %lu missing bytes\n", (unsigned long)c); return; }
            buf_b[i] = (uint8_t)v;
            sum += (uint8_t)v;
        }
        int s1 = rd(), s0 = rd();
        if (s0 < 0 || (uint16_t)(s1 << 8 | s0) != sum) { printf("ERR chunk %lu checksum\n", (unsigned long)c); return; }
        sector_write(STAGE_OFFSET + c * SECTOR, buf_b);
        if (memcmp(xip(STAGE_OFFSET + c * SECTOR), buf_b, SECTOR) != 0) { printf("ERR chunk %lu read back\n", (unsigned long)c); return; }
        printf("OK %lu\n", (unsigned long)c);
        fflush(stdout);
    }
    uint8_t sha[32];
    sha_of(STAGE_OFFSET, len, sha);
    if (memcmp(sha, hdr + 4, 32) != 0) { printf("ERR sha: the firmware received is not the one sent\n"); return; }
    printf("UPDATE verified\n");
    stdio_flush();
    swap_and_restart(len);
}

void fw_update_back(bool powered) {
    if (powered) { printf("refused: switch the SP-202 off first\n"); return; }
    record_t rec;
    memcpy(&rec, xip(RECORD_OFFSET), sizeof rec);
    uint8_t sha[32];
    if (rec.magic != RECORD_MAGIC || rec.len < 1024 || rec.len > STAGE_MAX) { printf("ERR no previous firmware\n"); return; }
    sha_of(STAGE_OFFSET, rec.len, sha);
    if (memcmp(sha, rec.sha, 32) != 0) { printf("ERR the previous firmware is damaged\n"); return; }
    printf("UPDATE back to %s\n", rec.version);
    swap_and_restart(rec.len);
}

void fw_update_info(void) {
    record_t rec;
    memcpy(&rec, xip(RECORD_OFFSET), sizeof rec);
    if (rec.magic == RECORD_MAGIC && rec.len >= 1024 && rec.len <= STAGE_MAX) {
        rec.version[31] = 0;
        printf("update: previous %s %lu\n", rec.version, (unsigned long)rec.len);
    } else
        printf("update: none\n");
}
