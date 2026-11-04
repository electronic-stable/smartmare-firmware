/*
 * SmartMare 5V - the 4 MB SmartMedia image in the W25Q128 flash
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.7 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "sm_flash_storage.h"

#include <string.h>

#include "hardware/flash.h"
#include "hardware/sync.h"
#include "pico/stdlib.h"

#define BLOCK_DATA_SIZE (SM_PAGES_PER_BLK * SM_DATA_SIZE)   // 8 KB

extern char __flash_binary_end;

static inline uint32_t data_offset(uint32_t page) {
    return SM_FLASH_DATA_OFFSET + page * SM_DATA_SIZE;
}

static inline uint32_t spare_offset(uint32_t page) {
    return SM_FLASH_SPARE_OFFSET + (page / SM_PAGES_PER_BLK) * FLASH_SECTOR_SIZE
           + (page % SM_PAGES_PER_BLK) * SM_SPARE_SIZE;
}

static inline const uint8_t *xip(uint32_t offset) {
    return (const uint8_t *)(XIP_BASE + offset);
}

static bool all_ff(const uint8_t *p, uint32_t len) {
    const uint32_t *w = (const uint32_t *)p;
    for (uint32_t i = 0; i < len / 4; i++)
        if (w[i] != 0xFFFFFFFFu)
            return false;
    return true;
}

static void fl_read(void *ctx, uint32_t page, uint8_t *buf) {
    (void)ctx;
    memcpy(buf, xip(data_offset(page)), SM_DATA_SIZE);
    memcpy(buf + SM_DATA_SIZE, xip(spare_offset(page)), SM_SPARE_SIZE);
}

volatile bool sm_flash_writing;
volatile uint32_t sm_flash_unerased_programs;

static const uint8_t *fl_direct(void *ctx, uint32_t page, uint16_t column, uint16_t *len) {
    (void)ctx;
    if (column < SM_DATA_SIZE) {
        *len = (uint16_t)(SM_DATA_SIZE - column);
        return xip(data_offset(page) + column);
    }
    *len = (uint16_t)(SM_PAGE_SIZE - column);
    return xip(spare_offset(page) + (column - SM_DATA_SIZE));
}

static void fl_program(void *ctx, uint32_t page, const uint8_t *buf) {
    (void)ctx;
    // The spare bytes of a page sit inside a 256-byte flash page: program FF everywhere
    // else, which leaves the other pages' spare bytes unchanged.
    static uint8_t spare[FLASH_PAGE_SIZE];
    uint32_t so = spare_offset(page);
    memset(spare, 0xFF, sizeof spare);
    memcpy(spare + so % FLASH_PAGE_SIZE, buf + SM_DATA_SIZE, SM_SPARE_SIZE);

    sm_flash_writing = true;
    uint32_t irq = save_and_disable_interrupts();
    for (uint32_t half = 0; half < SM_DATA_SIZE; half += FLASH_PAGE_SIZE)
        if (!all_ff(buf + half, FLASH_PAGE_SIZE))        // programming FF changes nothing
            flash_range_program(data_offset(page) + half, buf + half, FLASH_PAGE_SIZE);
    if (!all_ff(buf + SM_DATA_SIZE, SM_SPARE_SIZE))
        flash_range_program(so - so % FLASH_PAGE_SIZE, spare, FLASH_PAGE_SIZE);
    restore_interrupts(irq);
    sm_flash_writing = false;
    if (memcmp(xip(data_offset(page)), buf, SM_DATA_SIZE) != 0 ||
        memcmp(xip(so), buf + SM_DATA_SIZE, SM_SPARE_SIZE) != 0)
        sm_flash_unerased_programs++;
}

static void fl_erase(void *ctx, uint32_t block) {
    (void)ctx;
    uint32_t d = SM_FLASH_DATA_OFFSET + block * BLOCK_DATA_SIZE;
    uint32_t s = SM_FLASH_SPARE_OFFSET + block * FLASH_SECTOR_SIZE;
    sm_flash_writing = true;
    uint32_t irq = save_and_disable_interrupts();
    if (!all_ff(xip(d), BLOCK_DATA_SIZE))                // already blank: skip the slow erase
        flash_range_erase(d, BLOCK_DATA_SIZE);
    if (!all_ff(xip(s), FLASH_SECTOR_SIZE))
        flash_range_erase(s, FLASH_SECTOR_SIZE);
    restore_interrupts(irq);
    sm_flash_writing = false;
}

void sm_flash_storage_get(sm_storage_t *s) {
    s->read_page = fl_read;
    s->program_page = fl_program;
    s->erase_block = fl_erase;
    s->direct = fl_direct;
    s->ctx = NULL;
}

bool sm_flash_storage_layout_ok(void) {
    return (uintptr_t)&__flash_binary_end <= XIP_BASE + SM_FLASH_DATA_OFFSET;
}
