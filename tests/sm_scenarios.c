/*
 * SmartMare 5V - SmartMedia command scenarios, as the SP-202 drives a card
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.2 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * SmartMedia command scenarios, shared by the host tests (RAM image) and the on-card
 * self test (W25Q128). Each scenario drives the card as the SP-202 would, through a host:
 * direct calls into sm_core, or (on the card) the real PIO bus.
 */
#include "sm_scenarios.h"

#include <stdio.h>
#include <string.h>

#include "sm_core.h"

// ---------- tiny test framework ----------
static int failures, checks;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; \
    printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(a, b) do { long _a = (long)(a), _b = (long)(b); checks++; if (_a != _b) { failures++; \
    printf("  FAIL %s:%d: %s == 0x%lX, want 0x%lX\n", __FILE__, __LINE__, #a, _a, _b); } } while (0)

// ---------- the host driving the card: direct calls, or the real bus (on the card) ----------
static const sm_host_t *H;

static sm_core_t direct_core;
static bool direct_wp_low;

static void d_reset(const sm_storage_t *st) { direct_wp_low = false; sm_core_init(&direct_core, st, 0x98); }
static void d_cmd(uint8_t v) { sm_core_latch(&direct_core, v, SM_LATCH_CLE, direct_wp_low); }
static void d_addr(uint8_t v) { sm_core_latch(&direct_core, v, SM_LATCH_ALE, direct_wp_low); }
static void d_data(uint8_t v) { sm_core_latch(&direct_core, v, 0, direct_wp_low); }
static uint8_t d_read(void) { return sm_core_read(&direct_core); }
static bool d_busy(void) { return sm_core_busy(&direct_core); }
static void d_wait_ready(void) { if (sm_core_busy(&direct_core)) sm_core_run_job(&direct_core); }
static void d_set_wp_low(bool low) { direct_wp_low = low; }

const sm_host_t sm_direct_host = {d_reset, d_cmd, d_addr, d_data, d_read, d_busy, d_wait_ready, d_set_wp_low};

// ---------- storage under test, wrapped to count and time the operations ----------
static sm_storage_t backend;
static uint32_t (*now_us)(void);
static int programs, erases, reads;
static uint32_t max_us[3];          // read, program, erase

static uint32_t tick(void) { return now_us ? now_us() : 0; }

static void cnt_read(void *ctx, uint32_t page, uint8_t *buf) {
    (void)ctx;
    uint32_t t = tick();
    backend.read_page(backend.ctx, page, buf);
    t = tick() - t;
    if (t > max_us[0]) max_us[0] = t;
    reads++;
}

static void cnt_program(void *ctx, uint32_t page, const uint8_t *buf) {
    (void)ctx;
    uint32_t t = tick();
    backend.program_page(backend.ctx, page, buf);
    t = tick() - t;
    if (t > max_us[1]) max_us[1] = t;
    programs++;
}

static void cnt_erase(void *ctx, uint32_t block) {
    (void)ctx;
    uint32_t t = tick();
    backend.erase_block(backend.ctx, block);
    t = tick() - t;
    if (t > max_us[2]) max_us[2] = t;
    erases++;
}

static const uint8_t *cnt_direct(void *ctx, uint32_t page, uint16_t column, uint16_t *len) {
    (void)ctx;
    reads++;
    return backend.direct(backend.ctx, page, column, len);
}

static sm_storage_t counted = {cnt_read, cnt_program, cnt_erase, NULL, NULL};

// Blocks the scenarios touch; each scenario starts with them erased.
static const uint32_t used_blocks[] = {0, 1, 2, 3, 6, 77, 511};

static void reset_all(void) {
    for (size_t i = 0; i < sizeof used_blocks / sizeof used_blocks[0]; i++)
        backend.erase_block(backend.ctx, used_blocks[i]);
    programs = erases = reads = 0;
    counted.direct = backend.direct ? cnt_direct : NULL;
    H->reset(&counted);
}

// host-side helpers, as the SP-202 would drive the bus
static void cmd(uint8_t c) { H->cmd(c); }
static void addr(uint8_t a) { H->addr(a); }
static void data(uint8_t d) { H->data(d); }
static uint8_t rd(void) { return H->read(); }
static void wait_ready(void) { H->wait_ready(); }

static void addr3(uint8_t col, uint32_t page) { addr(col); addr(page & 0xFF); addr((page >> 8) & 0xFF); }

static void read_setup(uint8_t command, uint8_t col, uint32_t page) {
    cmd(command);
    addr3(col, page);
    wait_ready();
}

static uint8_t pattern(uint32_t page, int i) { return (uint8_t)(page * 7 + i * 13 + 1); }

static void program_page(uint32_t page, int from, int n, uint8_t (*f)(uint32_t, int)) {
    cmd(0x80);
    addr3(0, page);
    for (int i = 0; i < from; i++) data(0xFF);
    for (int i = from; i < from + n; i++) data(f(page, i));
    cmd(0x10);
    wait_ready();
}

// ---------- tests ----------
static void test_reset_and_status(void) {
    reset_all();
    cmd(0xFF);
    cmd(0x70);
    CHECK_EQ(rd(), SM_STATUS_READY | SM_STATUS_NOT_WP);
    CHECK_EQ(rd(), SM_STATUS_READY | SM_STATUS_NOT_WP);     // status can be read repeatedly
}

static void test_id(void) {
    reset_all();
    cmd(0x90);
    addr(0x00);
    CHECK_EQ(rd(), 0x98);
    CHECK_EQ(rd(), 0x6B);
}

static void test_blank_reads_ff(void) {
    reset_all();
    read_setup(0x00, 0, 1234);
    int ok = 1;
    for (int i = 0; i < SM_PAGE_SIZE; i++) ok &= rd() == 0xFF;
    CHECK(ok);
}

static void test_program_then_read(void) {
    reset_all();
    program_page(100, 0, SM_PAGE_SIZE, pattern);
    CHECK_EQ(programs, 1);
    cmd(0x70);
    CHECK_EQ(rd(), SM_STATUS_READY | SM_STATUS_NOT_WP);       // pass
    read_setup(0x00, 0, 100);
    int ok = 1;
    for (int i = 0; i < SM_PAGE_SIZE; i++) ok &= rd() == pattern(100, i);
    CHECK(ok);
}

static void test_read_pointers(void) {
    reset_all();
    program_page(5, 0, SM_PAGE_SIZE, pattern);

    read_setup(0x00, 10, 5);                 // 00h: column 10
    CHECK_EQ(rd(), pattern(5, 10));
    read_setup(0x01, 10, 5);                 // 01h: column 256 + 10
    CHECK_EQ(rd(), pattern(5, 266));
    read_setup(0x50, 3, 5);                  // 50h: spare byte 3
    CHECK_EQ(rd(), pattern(5, 515));
    read_setup(0x50, 0xF3, 5);               // 50h: CA4-CA7 ignored, still spare byte 3
    CHECK_EQ(rd(), pattern(5, 515));
}

static void test_01h_is_one_shot_and_50h_persists(void) {
    reset_all();
    program_page(6, 0, SM_PAGE_SIZE, pattern);

    read_setup(0x01, 0, 6);
    CHECK_EQ(rd(), pattern(6, 256));
    cmd(0x80); addr3(0, 7);                  // a program right after 01h starts at 0 again
    data(0x12);
    cmd(0x10); wait_ready();
    read_setup(0x00, 0, 7);
    CHECK_EQ(rd(), 0x12);

    // 50h stays until 00h or FFh: 80h after 50h writes the spare area (§8.4)
    cmd(0xFF);
    cmd(0x50); addr3(0, 9); wait_ready();
    cmd(0x80); addr3(0, 9);
    data(0xA5);
    cmd(0x10); wait_ready();
    cmd(0x00); addr3(0, 9); wait_ready();
    CHECK_EQ(rd(), 0xFF);                    // data area untouched
    read_setup(0x50, 0, 9);
    CHECK_EQ(rd(), 0xA5);                    // spare byte 0 written
}

static void test_sequential_read_within_block(void) {
    reset_all();
    for (uint32_t p = 16; p < 32; p++) program_page(p, 0, SM_PAGE_SIZE, pattern);

    read_setup(0x00, 0, 30);                 // pages 30, 31 then the block ends
    int ok = 1;
    for (int i = 0; i < SM_PAGE_SIZE; i++) ok &= rd() == pattern(30, i);
    CHECK(ok);
    wait_ready();                  // next page loading (tR); a directly readable storage is ready at once
    ok = 1;
    for (int i = 0; i < SM_PAGE_SIZE; i++) ok &= rd() == pattern(31, i);
    CHECK(ok);
    CHECK(!H->busy());             // last page of the block: no further load
    CHECK_EQ(rd(), 0xFF);

    // 50h: sequential read gives the spare area of each page
    read_setup(0x50, 0, 16);
    for (int i = 512; i < SM_PAGE_SIZE; i++) rd();
    wait_ready();
    CHECK_EQ(rd(), pattern(17, 512));
}

static void test_erase(void) {
    reset_all();
    program_page(32, 0, SM_PAGE_SIZE, pattern);          // block 2
    program_page(48, 0, SM_PAGE_SIZE, pattern);          // block 3
    cmd(0x60);
    addr(37);                                             // any page of block 2
    addr(0);
    cmd(0xD0);
    CHECK(H->busy());
    cmd(0x70);
    CHECK_EQ(rd(), SM_STATUS_NOT_WP);                     // busy: D6 = 0
    wait_ready();
    CHECK_EQ(rd(), SM_STATUS_READY | SM_STATUS_NOT_WP);
    CHECK_EQ(erases, 1);
    read_setup(0x00, 0, 32);
    CHECK_EQ(rd(), 0xFF);
    read_setup(0x00, 0, 48);
    CHECK_EQ(rd(), pattern(48, 0));                       // the next block is untouched
}

static void test_write_protect(void) {
    reset_all();
    H->set_wp_low(true);
    program_page(10, 0, SM_PAGE_SIZE, pattern);
    CHECK_EQ(programs, 0);
    cmd(0x70);
    CHECK_EQ(rd(), SM_STATUS_READY | SM_STATUS_FAIL);    // D7 = 0: protected
    cmd(0x60); addr(0); addr(0); cmd(0xD0);
    CHECK_EQ(erases, 0);
}

static void test_busy_ignores_commands(void) {
    // A program keeps the card busy (a page read may be ready at once).
    reset_all();
    cmd(0x80); addr3(0, 1); data(0x12); cmd(0x10);
    CHECK(H->busy());
    cmd(0x90);                                            // ignored while busy
    addr(0);
    wait_ready();
    CHECK_EQ(rd(), 0xFF);                                 // no ID: the 90h was ignored
    cmd(0x80); addr3(0, 2); data(0x12); cmd(0x10);
    CHECK(H->busy());
    cmd(0xFF);                                            // reset aborts the busy state
    CHECK(!H->busy());
}

static void test_program_only_clears_bits(void) {
    reset_all();
    program_page(40, 0, SM_DATA_SIZE, pattern);           // data, spare left FF
    cmd(0x80); addr3(0, 40);                              // second pass: spare only (§8.3)
    for (int i = 0; i < SM_DATA_SIZE; i++) data(0xFF);
    for (int i = 0; i < SM_SPARE_SIZE; i++) data(0x00);
    cmd(0x10); wait_ready();
    read_setup(0x00, 0, 40);
    CHECK_EQ(rd(), pattern(40, 0));
    read_setup(0x50, 0, 40);
    CHECK_EQ(rd(), 0x00);
}

static void test_page_address_masked(void) {
    reset_all();
    program_page(8191, 0, 4, pattern);                    // last page
    read_setup(0x00, 0, 8191 | 0xE000);                   // PA13-15 set: ignored
    CHECK_EQ(rd(), pattern(8191, 0));
}

int sm_run_scenarios(const sm_storage_t *storage, const sm_host_t *host, uint32_t (*clock_us)(void)) {
    H = host;
    backend = *storage;
    now_us = clock_us;
    failures = checks = 0;
    memset(max_us, 0, sizeof max_us);
    struct { const char *name; void (*fn)(void); } tests[] = {
        {"reset and status", test_reset_and_status},
        {"ID read", test_id},
        {"blank card reads FF", test_blank_reads_ff},
        {"program then read", test_program_then_read},
        {"read pointers 00h/01h/50h", test_read_pointers},
        {"01h one shot, 50h persists", test_01h_is_one_shot_and_50h_persists},
        {"sequential read within a block", test_sequential_read_within_block},
        {"block erase", test_erase},
        {"write protect", test_write_protect},
        {"busy ignores commands", test_busy_ignores_commands},
        {"program only clears bits", test_program_only_clears_bits},
        {"page address masked to 4 MB", test_page_address_masked},
    };
    for (size_t i = 0; i < sizeof tests / sizeof tests[0]; i++) {
        int before = failures;
        tests[i].fn();
        printf("%-34s %s\n", tests[i].name, failures == before ? "ok" : "FAILED");
    }
    printf("\n%d checks, %d failed\n", checks, failures);
    if (now_us)
        printf("slowest storage ops: read %lu us (spec tR 100 us), program %lu us (tPROG 20 ms), "
               "erase %lu us (tBERASE 400 ms)\n",
               (unsigned long)max_us[0], (unsigned long)max_us[1], (unsigned long)max_us[2]);
    return failures;
}
