/*
 * SmartMare 5V - SmartMedia command set: reset, ID, read, program, erase
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.7 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "sm_core.h"

#include <string.h>

// Column where a read or a program starts for each pointer area (§5 Note 1, §8.4)
static const uint16_t area_base[3] = {0, 256, SM_DATA_SIZE};

void sm_core_init(sm_core_t *c, const sm_storage_t *storage, uint8_t maker_id) {
    sm_storage_t st = *storage;         // storage may point into *c (re-init in place)
    memset(c, 0, sizeof *c);
    c->storage = st;
    c->maker_id = maker_id;
    memset(c->buf, 0xFF, sizeof c->buf);
}

uint8_t sm_core_status(const sm_core_t *c) {
    uint8_t s = 0;
    if (!sm_core_busy(c)) s |= SM_STATUS_READY;
    if (!c->wp_low) s |= SM_STATUS_NOT_WP;
    if (c->fail) s |= SM_STATUS_FAIL;
    return s;
}

static uint16_t start_column(uint8_t area, uint8_t ca) {
    // In the spare area only CA0-CA3 matter (16 bytes).
    return area == 2 ? (uint16_t)(SM_DATA_SIZE + (ca & 0x0F)) : (uint16_t)(area_base[area] + ca);
}

static uint32_t page_from_addr(const uint8_t *a) {
    return ((uint32_t)a[1] | ((uint32_t)a[2] << 8)) & SM_PAGE_MASK;
}

static void command(sm_core_t *c, uint8_t cmd) {
    // While busy only Status Read and Reset are accepted (§8.6 (2)).
    if (sm_core_busy(c) && cmd != 0x70 && cmd != 0xFF)
        return;
    // After 80h only 10h or FFh (§8.6 (3)).
    if (c->state == SM_ST_PROG_DATA && cmd != 0x10 && cmd != 0xFF && cmd != 0x70)
        return;

    switch (cmd) {
    case 0xFF:                                   // Reset
        c->job = SM_JOB_NONE;
        c->state = SM_ST_IDLE;
        c->out = SM_OUT_NONE;
        c->area = 0;
        c->fail = false;
        break;
    case 0x00: case 0x01: case 0x50:             // Read (1) (2) (3)
        c->area = cmd == 0x00 ? 0 : cmd == 0x01 ? 1 : 2;
        c->state = SM_ST_ADDR_READ;
        c->addr_count = 0;
        c->out = SM_OUT_NONE;
        break;
    case 0x80:                                   // Serial data input
        c->state = SM_ST_ADDR_PROG;
        c->addr_count = 0;
        c->out = SM_OUT_NONE;
        break;
    case 0x10:                                   // Auto program
        if (c->state != SM_ST_PROG_DATA)
            break;
        c->state = SM_ST_IDLE;
        if (c->area == 1)
            c->area = 0;                         // 01h pointer is one shot
        if (c->wp_low) {
            c->fail = true;
        } else {
            c->fail = false;
            c->job = SM_JOB_PROGRAM;
        }
        break;
    case 0x60:                                   // Auto block erase setup
        c->state = SM_ST_ADDR_ERASE;
        c->addr_count = 0;
        c->out = SM_OUT_NONE;
        break;
    case 0xD0:                                   // Erase
        if (c->state != SM_ST_ERASE_READY)
            break;
        c->state = SM_ST_IDLE;
        if (c->wp_low) {
            c->fail = true;
        } else {
            c->fail = false;
            c->job = SM_JOB_ERASE;
        }
        break;
    case 0x70:                                   // Status read
        c->out = SM_OUT_STATUS;
        break;
    case 0x90:                                   // ID read
        c->state = SM_ST_ADDR_ID;
        c->addr_count = 0;
        // Armed now, not after the address: a fast host reads right after the address
        // cycle, and the bus needs the bytes queued by then.
        c->out = SM_OUT_ID;
        c->id_index = 0;
        break;
    default:                                     // not a command (§8.6 (1))
        break;
    }
}

static void address(sm_core_t *c, uint8_t byte) {
    if (c->addr_count < sizeof c->addr)
        c->addr[c->addr_count] = byte;
    c->addr_count++;

    switch (c->state) {
    case SM_ST_ADDR_READ:
        if (c->addr_count == 3) {
            c->page = page_from_addr(c->addr);
            c->column = start_column(c->area, c->addr[0]);
            if (c->area == 1)
                c->area = 0;                     // one shot: the next page starts at 0
            c->state = SM_ST_IDLE;
            c->out = SM_OUT_DATA;
            c->job = SM_JOB_READ;
        }
        break;
    case SM_ST_ADDR_PROG:
        if (c->addr_count == 3) {
            c->page = page_from_addr(c->addr);
            c->column = start_column(c->area, c->addr[0]);
            memset(c->buf, 0xFF, sizeof c->buf);
            c->state = SM_ST_PROG_DATA;
        }
        break;
    case SM_ST_ADDR_ERASE:
        // Two cycles: PA0-PA7, PA8-PA15. PA0-PA3 (page in block) are ignored.
        if (c->addr_count == 2) {
            uint8_t a[3] = {0, c->addr[0], c->addr[1]};
            c->page = page_from_addr(a) & ~(uint32_t)(SM_PAGES_PER_BLK - 1);
            c->state = SM_ST_ERASE_READY;
        }
        break;
    case SM_ST_ADDR_ID:
        c->state = SM_ST_IDLE;
        c->out = SM_OUT_ID;
        c->id_index = 0;
        break;
    default:
        break;
    }
}

void sm_core_latch(sm_core_t *c, uint8_t byte, uint8_t flags, bool wp_low) {
    c->wp_low = wp_low;
    if (flags & SM_LATCH_CLE)
        command(c, byte);
    else if (flags & SM_LATCH_ALE)
        address(c, byte);
    else if (c->state == SM_ST_PROG_DATA && c->column < SM_PAGE_SIZE)
        c->buf[c->column++] = byte;
}

uint8_t sm_core_read(sm_core_t *c) {
    switch (c->out) {
    case SM_OUT_STATUS:
        return sm_core_status(c);
    case SM_OUT_ID: {
        uint8_t v = c->id_index == 0 ? c->maker_id : c->id_index == 1 ? SM_DEVICE_ID : 0xFF;
        if (c->id_index < 2)
            c->id_index++;
        return v;
    }
    case SM_OUT_DATA: {
        const uint8_t *p;
        if (sm_core_data_avail(c, &p) == 0)
            return 0xFF;
        uint8_t v = *p;
        sm_core_data_consume(c, 1);
        return v;
    }
    default:
        return 0xFF;
    }
}

uint16_t sm_core_data_avail(const sm_core_t *c, const uint8_t **p) {
    if (c->out != SM_OUT_DATA || sm_core_busy(c) || c->column >= SM_PAGE_SIZE)
        return 0;
    *p = c->buf + c->column;
    return (uint16_t)(SM_PAGE_SIZE - c->column);
}

void sm_core_data_consume(sm_core_t *c, uint16_t n) {
    c->column += n;
    // Sequential read (§8.2): after the last byte, the next page of the same block.
    if (c->column >= SM_PAGE_SIZE && (c->page + 1) % SM_PAGES_PER_BLK != 0) {
        c->page++;
        c->column = c->area == 2 ? SM_DATA_SIZE : 0;
        c->job = SM_JOB_READ;
    }
}

void sm_core_run_job(sm_core_t *c) {
    switch (c->job) {
    case SM_JOB_READ:
        c->storage.read_page(c->storage.ctx, c->page, c->buf);
        break;
    case SM_JOB_PROGRAM:
        c->storage.program_page(c->storage.ctx, c->page, c->buf);
        break;
    case SM_JOB_ERASE:
        c->storage.erase_block(c->storage.ctx, c->page / SM_PAGES_PER_BLK);
        break;
    default:
        break;
    }
    __sync_synchronize();   // the page buffer is complete before the bus sees "ready"
    c->job = SM_JOB_NONE;
}
