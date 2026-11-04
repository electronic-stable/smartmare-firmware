/*
 * SmartMare 5V - sample sets kept in the card's flash
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.1 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "set_store.h"

#include <string.h>

#include "hardware/flash.h"
#include "hardware/sync.h"
#include "pico/stdlib.h"

#define DIR_OFFSET   (7u << 20)
#define DATA_START   (DIR_OFFSET + 0x10000u)
#define DATA_END     (16u << 20)
#define ERASE_BLOCK  0x10000u
#define DIR_MAGIC    "SMSETDIR"

typedef struct {
    char magic[8];
    uint32_t version;
    uint8_t pad[52];
    set_entry_t e[SET_MAX];
} set_dir_t;

_Static_assert(sizeof(set_entry_t) == 64, "entry size");
_Static_assert(sizeof(set_dir_t) <= FLASH_SECTOR_SIZE, "directory fits one sector");

static set_dir_t dir;                         // RAM copy of the directory
static uint8_t sector[FLASH_SECTOR_SIZE];     // the directory sector to program
static uint8_t page[FLASH_PAGE_SIZE];
static struct { bool on; set_entry_t e; uint32_t at, fill, crc, want_crc; } wr;

static inline const uint8_t *xip(uint32_t offset) {
    return (const uint8_t *)(XIP_BASE + offset);
}

static bool valid(const set_entry_t *e) {
    return e->used == SET_ENTRY_USED && e->offset >= DATA_START && e->length &&
           e->offset + e->length <= DATA_END && e->offset % ERASE_BLOCK == 0;
}

void set_store_init(void) {
    memcpy(&dir, xip(DIR_OFFSET), sizeof dir);
    if (memcmp(dir.magic, DIR_MAGIC, 8) != 0) {          // blank or unknown: empty store
        memset(&dir, 0xFF, sizeof dir);
        memcpy(dir.magic, DIR_MAGIC, 8);
        dir.version = 1;
    }
}

static void save_dir(void) {
    memset(sector, 0xFF, sizeof sector);
    memcpy(sector, &dir, sizeof dir);
    uint32_t irq = save_and_disable_interrupts();
    flash_range_erase(DIR_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(DIR_OFFSET, sector, FLASH_SECTOR_SIZE);
    restore_interrupts(irq);
}

const set_entry_t *set_store_entry(int i) {
    return i >= 0 && i < SET_MAX && valid(&dir.e[i]) ? &dir.e[i] : NULL;
}

static uint32_t span(uint32_t length) {
    return (length + ERASE_BLOCK - 1) / ERASE_BLOCK * ERASE_BLOCK;
}

// The first free run of `need` bytes, and the largest one. A set being replaced stays
// in place until the new copy is complete, so its space does not count as free.
static uint32_t find_space(uint32_t need, uint32_t *largest) {
    uint32_t at = DATA_START, best = 0, found = 0;
    while (at < DATA_END) {
        uint32_t next = DATA_END;                          // start of the next set after `at`
        bool inside = false;
        for (int i = 0; i < SET_MAX; i++) {
            if (!valid(&dir.e[i]))
                continue;
            uint32_t a = dir.e[i].offset, b = a + span(dir.e[i].length);
            if (a <= at && at < b) { at = b; inside = true; break; }
            if (a > at && a < next) next = a;
        }
        if (inside)
            continue;
        uint32_t run = next - at;
        if (run > best) best = run;
        if (!found && run >= need) found = at;
        at = next;
    }
    if (largest) *largest = best;
    return found;
}

uint32_t set_store_free(void) {
    uint32_t largest;
    find_space(DATA_END, &largest);
    return largest;
}

uint32_t set_store_capacity(void) {
    return DATA_END - DATA_START;
}

const char *set_store_begin(const char *name, uint32_t length, uint32_t crc, uint32_t stamp, void (*tick)(void)) {
    wr.on = false;
    if (!length || length > DATA_END - DATA_START)
        return "bad length";
    int slot = -1;
    for (int i = 0; i < SET_MAX && slot < 0; i++)
        if (!valid(&dir.e[i]))
            slot = i;
    bool replacing = false;
    for (int i = 0; i < SET_MAX; i++)
        if (valid(&dir.e[i]) && strncmp(dir.e[i].name, name, SET_NAME_MAX) == 0)
            replacing = true;
    if (slot < 0 && !replacing)
        return "no free slot (32 sets)";
    uint32_t at = find_space(span(length), NULL);
    if (!at)
        return "not enough space on the card";
    for (uint32_t o = at; o < at + span(length); o += ERASE_BLOCK) {
        if (tick) tick();
        uint32_t irq = save_and_disable_interrupts();
        flash_range_erase(o, ERASE_BLOCK);
        restore_interrupts(irq);
    }
    memset(&wr.e, 0, sizeof wr.e);
    wr.e.used = SET_ENTRY_USED;
    strncpy(wr.e.name, name, SET_NAME_MAX);
    wr.e.offset = at;
    wr.e.length = length;
    wr.e.crc = crc;
    wr.e.stamp = stamp;
    memset(wr.e.pad, 0xFF, sizeof wr.e.pad);
    wr.at = at;
    wr.fill = 0;
    wr.crc = 0;
    wr.want_crc = crc;
    wr.on = true;
    return NULL;
}

static void flush_page(void) {
    if (!wr.fill)
        return;
    memset(page + wr.fill, 0xFF, FLASH_PAGE_SIZE - wr.fill);
    uint32_t irq = save_and_disable_interrupts();
    flash_range_program(wr.at, page, FLASH_PAGE_SIZE);
    restore_interrupts(irq);
    wr.at += FLASH_PAGE_SIZE;
    wr.fill = 0;
}

void set_store_write(const uint8_t *data, uint32_t n) {
    if (!wr.on)
        return;
    wr.crc = set_crc32(wr.crc, data, n);
    while (n) {
        uint32_t k = FLASH_PAGE_SIZE - wr.fill;
        if (k > n) k = n;
        memcpy(page + wr.fill, data, k);
        wr.fill += k;
        data += k;
        n -= k;
        if (wr.fill == FLASH_PAGE_SIZE)
            flush_page();
    }
}

const char *set_store_end(int *index) {
    if (!wr.on)
        return "no save in progress";
    flush_page();
    wr.on = false;
    if (wr.crc != wr.want_crc)
        return "CRC differs: data damaged on the way";
    if (set_crc32(0, xip(wr.e.offset), wr.e.length) != wr.want_crc)
        return "CRC differs after writing the flash";
    int slot = -1;
    for (int i = 0; i < SET_MAX; i++)                     // replace a set of the same name
        if (valid(&dir.e[i]) && strncmp(dir.e[i].name, wr.e.name, SET_NAME_MAX) == 0) {
            if (slot < 0) slot = i;
            else memset(&dir.e[i], 0xFF, sizeof dir.e[i]);
        }
    for (int i = 0; i < SET_MAX && slot < 0; i++)
        if (!valid(&dir.e[i]))
            slot = i;
    dir.e[slot] = wr.e;
    save_dir();
    *index = slot;
    return NULL;
}

const uint8_t *set_store_data(int i) {
    const set_entry_t *e = set_store_entry(i);
    return e ? xip(e->offset) : NULL;
}

void set_store_erase_all(void (*tick)(void)) {
    wr.on = false;
    for (uint32_t o = DIR_OFFSET; o < DATA_END; o += ERASE_BLOCK) {
        if (tick) tick();
        uint32_t irq = save_and_disable_interrupts();
        flash_range_erase(o, ERASE_BLOCK);
        restore_interrupts(irq);
    }
    set_store_init();                         // blank directory: an empty store
}

const char *set_store_delete(int i) {
    if (!set_store_entry(i))
        return "no such set";
    memset(&dir.e[i], 0xFF, sizeof dir.e[i]);
    save_dir();
    return NULL;
}
