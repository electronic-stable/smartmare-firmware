/*
 * SmartMare 5V - SmartMedia command set: reset, ID, read, program, erase
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.7 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * SmartMedia device behaviour (SmartMedia Electrical Spec 1999, §5, §6, §8), hardware free.
 *
 * The bus side reports each /WE latch (sm_core_latch) and asks for each /RE byte
 * (sm_core_read). Slow work (page load, program, erase) is queued as a job: the core turns
 * busy, and whoever owns the storage runs sm_core_run_job() and the core turns ready.
 * On the firmware, the bus runs on core1 and the jobs on core0; in the tests, both are
 * called in sequence.
 */
#ifndef SM_CORE_H
#define SM_CORE_H

#include <stdbool.h>
#include <stdint.h>

#define SM_DATA_SIZE      512
#define SM_SPARE_SIZE     16
#define SM_PAGE_SIZE      (SM_DATA_SIZE + SM_SPARE_SIZE)   // 528
#define SM_PAGES_PER_BLK  16
#define SM_BLOCKS         512
#define SM_PAGES          (SM_BLOCKS * SM_PAGES_PER_BLK)   // 8192 = 4 MB
#define SM_PAGE_MASK      (SM_PAGES - 1)                   // PA0..PA12

#define SM_DEVICE_ID_4MB_5V 0x6B
// The device code answered to Read ID: a research build may claim another card (0xE6 = 8 MB).
#ifdef SM_DEVICE_ID_OVERRIDE
#define SM_DEVICE_ID SM_DEVICE_ID_OVERRIDE
#else
#define SM_DEVICE_ID SM_DEVICE_ID_4MB_5V
#endif

// Latch flags, sampled with the byte on the rising edge of /WE
#define SM_LATCH_CLE 0x01
#define SM_LATCH_ALE 0x02

// Status bits (Table 6-4)
#define SM_STATUS_FAIL      0x01
#define SM_STATUS_READY     0x40
#define SM_STATUS_NOT_WP    0x80

typedef struct {
    void (*read_page)(void *ctx, uint32_t page, uint8_t *buf528);
    // NAND/NOR program: every bit can only go from 1 to 0 (stored &= buf)
    void (*program_page)(void *ctx, uint32_t page, const uint8_t *buf528);
    void (*erase_block)(void *ctx, uint32_t block);
    // Optional (NULL if not available): the bytes of a page from a column, directly readable
    // in memory (data area up to 512, spare area up to 528), and how many are contiguous.
    // Lets the bus stream a page with no load time.
    const uint8_t *(*direct)(void *ctx, uint32_t page, uint16_t column, uint16_t *len);
    void *ctx;
} sm_storage_t;

typedef enum { SM_JOB_NONE, SM_JOB_READ, SM_JOB_PROGRAM, SM_JOB_ERASE } sm_job_t;

typedef enum {
    SM_ST_IDLE,
    SM_ST_ADDR_READ,     // 00h/01h/50h, waiting for 3 address cycles
    SM_ST_ADDR_PROG,     // 80h, waiting for 3 address cycles
    SM_ST_PROG_DATA,     // 80h + address, taking data until 10h
    SM_ST_ADDR_ERASE,    // 60h, waiting for 2 address cycles
    SM_ST_ERASE_READY,   // 60h + address, waiting for D0h
    SM_ST_ADDR_ID,       // 90h, waiting for 1 address cycle
} sm_state_t;

typedef enum { SM_OUT_NONE, SM_OUT_DATA, SM_OUT_STATUS, SM_OUT_ID } sm_out_t;

typedef struct {
    sm_storage_t storage;
    uint8_t maker_id;

    sm_state_t state;
    sm_out_t out;
    uint8_t area;          // read pointer: 0 = 00h, 1 = 01h (one shot), 2 = 50h
    uint8_t addr[3];
    uint8_t addr_count;

    uint32_t page;
    uint16_t column;       // 0..528
    uint8_t id_index;

    volatile sm_job_t job; // pending slow work; busy while != NONE (set by the bus, cleared by the job runner)
    bool fail;             // result of the last program / erase
    bool wp_low;           // /WP level seen with the last latch

    uint8_t buf[SM_PAGE_SIZE];
} sm_core_t;

void sm_core_init(sm_core_t *c, const sm_storage_t *storage, uint8_t maker_id);

// One /WE rising edge: byte on D0-D7, CLE/ALE flags, /WP level.
void sm_core_latch(sm_core_t *c, uint8_t byte, uint8_t flags, bool wp_low);

// One /RE pulse: the byte the card drives.
uint8_t sm_core_read(sm_core_t *c);

// Fast path for the bus in data output: the bytes the card can send from the current column
// (0 while busy, outside data output, or past the end). The caller streams them, then
// consumes them; reaching the end of the page starts the next page of the block (§8.2).
uint16_t sm_core_data_avail(const sm_core_t *c, const uint8_t **p);
void sm_core_data_consume(sm_core_t *c, uint16_t n);

static inline bool sm_core_busy(const sm_core_t *c) { return c->job != SM_JOB_NONE; }
uint8_t sm_core_status(const sm_core_t *c);

// Runs the pending job against the storage, then the core is ready again.
void sm_core_run_job(sm_core_t *c);

#endif
