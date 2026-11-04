/*
 * SmartMare 5V - the emulator: SP-202 and generic firmwares, USB commands
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.1 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * SmartMedia 5V card emulator for the Boss SP-202: an S4M-5 (4 MB, ID 98h 6Bh).
 * Built with SMARTMARE_GENERIC=1 it is the plain 4 MB card for any device with a 5 V
 * SmartMedia slot: the same emulation and image commands over USB, and a drive with the
 * Card Manager page instead of the SP-202's Pad Editor, sample sets and pad table.
 *
 * - The image lives in the W25Q128 (sm_flash_storage), the command set in sm_core, the bus
 *   in PIO0 + core1 (sm_bus). Core0 runs the programs and erases, watches the card power
 *   and talks over USB. Works with or without USB: the SP-202 slot powers the card.
 * - The bus is active only while the SP-202 powers the card (VCC >= 4.3 V for 20 ms).
 *   Otherwise R/B stays busy, the data bus is disconnected and every /WE edge is
 *   discarded, so floating lines cannot write or erase anything.
 * - USB serial: a status line every 5 s with the health counters (reads checked / wrong,
 *   programs over unerased pages, data changing at the /WE rise...). Keys: s status,
 *   v log level (quiet / all / jobs), r raw bus samples and wrong reads, D dump the image
 *   (tools/dump_image.py), W write blocks from the PC (tools/write_image.py), E erase the image,
 *   h help. The log is kept in memory until a terminal connects.
 * - A watchdog restarts a stuck firmware; the next boot says which step it was stuck in.
 * - LED: slow blink = no card power; on = active, with a short blink-off on each flash job.
 */
#if SMARTMARE_RESEARCH
#include "research_listen.h"
#define RESEARCH_TAG "RESEARCH "
#else
#define RESEARCH_TAG ""
#endif
#include <stdio.h>

#include "hardware/clocks.h"
#include "hardware/watchdog.h"
#include "pico/stdio/driver.h"
#include "pico/stdio_usb.h"
#include "pico/stdlib.h"
#include "tusb.h"

#include "board_pins.h"
#include "card_if.h"
#include "crc32.h"
#include "fw_update.h"
#include "sm_bus.h"
#include "sm_core.h"
#include "sm_flash_storage.h"
#include "usb_drive.h"
#if SMARTMARE_GENERIC
#define HOST "device"                       // what powers the card, in messages
#else
#define HOST "SP-202"
#include "set_store.h"
#endif

#define MAKER_ID          0x98      // Toshiba
#define VCC_ON_MV         4300
#define VCC_OFF_MV        3800
#define VCC_STABLE_MS     20
#define STATUS_PERIOD_MS  5000
#define LINES_PER_PASS    8         // log lines printed between two job checks

static sm_core_t core;
static sm_storage_t storage;
static bool powered;
static uint32_t vcc_mv;

enum { LOG_QUIET, LOG_JOBS, LOG_ALL };
static int log_level = LOG_QUIET;    // the status line only; v for more

// ---------- flash jobs (core0) ----------
typedef struct {
    uint32_t t_us, dur_us, page;
    sm_job_t job;
    bool unerased;             // a program over a page that was not erased
} job_rec_t;

#define JOB_LOG 256
static job_rec_t jobs[JOB_LOG];
static uint32_t job_head, job_tail, job_drops;
static uint32_t n_reads, n_programs, n_erases;
static uint32_t led_dark_until;

// ---------- crash breadcrumbs ----------
// What core0 was doing, kept in watchdog scratch registers: they survive a watchdog reset,
// so the next boot can say where the firmware got stuck. scratch[0..3] (the SDK uses 4..7).
#define CRUMB_MAGIC   0x5A4D4352u
enum { CRUMB_IDLE, CRUMB_JOB, CRUMB_ERASE_ALL, CRUMB_WRITE };
static const char *crumb_name[] = {"idle", "flash job", "erase the whole image", "write a block from the PC"};
static bool wd_reboot;
static uint32_t last_crumb[3];

static void crumb(uint32_t what, uint32_t arg) {
    watchdog_hw->scratch[0] = CRUMB_MAGIC;
    watchdog_hw->scratch[1] = what;
    watchdog_hw->scratch[2] = arg;
    watchdog_hw->scratch[3] = time_us_32();
}

static void service_jobs(void) {
    sm_job_t j = core.job;
    if (j == SM_JOB_NONE)
        return;
    uint32_t page = core.page;
    uint32_t t0 = time_us_32();
    crumb(CRUMB_JOB, (uint32_t)j << 24 | page);
    uint32_t unerased = sm_flash_unerased_programs;
    j = sm_bus_service_jobs();
    crumb(CRUMB_IDLE, 0);
    if (j == SM_JOB_NONE)
        return;
    uint32_t dt = time_us_32() - t0;

    if (j == SM_JOB_READ) n_reads++;
    else if (j == SM_JOB_PROGRAM) n_programs++;
    else if (j == SM_JOB_ERASE) n_erases++;
    if (job_head - job_tail < JOB_LOG)
        jobs[job_head++ % JOB_LOG] = (job_rec_t){t0, dt, page, j, sm_flash_unerased_programs != unerased};
    else
        job_drops++;
    gpio_put(PIN_LED, 0);
    led_dark_until = to_ms_since_boot(get_absolute_time()) + 30;
}

// ---------- log printing ----------
static void print_time(uint32_t t_us) {
    printf("[%5lu.%06lu] ", (unsigned long)(t_us / 1000000), (unsigned long)(t_us % 1000000));
}

static const char *cmd_name(uint8_t c) {
    switch (c) {
    case 0x00: return "READ (00h)";
    case 0x01: return "READ 2nd half (01h)";
    case 0x50: return "READ spare (50h)";
    case 0x80: return "PROGRAM setup (80h)";
    case 0x10: return "PROGRAM (10h)";
    case 0x60: return "ERASE setup (60h)";
    case 0xD0: return "ERASE (D0h)";
    case 0x70: return "STATUS (70h)";
    case 0x90: return "ID (90h)";
    case 0xFF: return "RESET (FFh)";
    default:   return "unknown";
    }
}

static bool line_open;      // a CMD line waiting for its address bytes / data run

static void end_line(void) {
    if (line_open) {
        printf("\n");
        line_open = false;
    }
}

static void print_event(const sm_bus_event_t *e) {
    switch (e->kind) {
    case SM_EV_CMD:
        end_line();
        print_time(e->t_us);
        printf("CMD %02X %s", e->value, cmd_name(e->value));
        line_open = true;
        break;
    case SM_EV_ADDR:
        if (!line_open) {
            print_time(e->t_us);
            printf("ADDR");
            line_open = true;
        }
        printf(" a:%02X", e->value);
        break;
    case SM_EV_DATA:
        if (!line_open) {
            print_time(e->t_us);
            line_open = true;
        }
        printf(" +%u data bytes", e->count);
        break;
    }
}

static void print_job(const job_rec_t *r) {
    end_line();
    print_time(r->t_us);
    uint32_t blk = r->page / SM_PAGES_PER_BLK;
    switch (r->job) {
    case SM_JOB_READ:
        printf("  load page %lu (block %lu) %lu us\n", (unsigned long)r->page, (unsigned long)blk,
               (unsigned long)r->dur_us);
        break;
    case SM_JOB_PROGRAM:
        printf("  program page %lu (block %lu) %lu us%s\n", (unsigned long)r->page, (unsigned long)blk,
               (unsigned long)r->dur_us, r->unerased ? "  !! NOT ERASED BEFORE: data mixed" : "");
        break;
    case SM_JOB_ERASE:
        printf("  erase block %lu %lu us\n", (unsigned long)blk, (unsigned long)r->dur_us);
        break;
    default:
        break;
    }
}

// Prints the oldest pending log item (bus event or flash job). False when nothing is left.
static bool print_next(void) {
    sm_bus_event_t e;
    bool have_e = sm_bus_event_peek(&e);
    bool have_j = job_tail != job_head;
    if (!have_e && !have_j)
        return false;
    if (have_j && (!have_e || (int32_t)(jobs[job_tail % JOB_LOG].t_us - e.t_us) < 0)) {
        if (log_level >= LOG_JOBS)
            print_job(&jobs[job_tail % JOB_LOG]);
        job_tail++;
    } else {
        if (log_level >= LOG_ALL)
            print_event(&e);
        sm_bus_event_drop();
    }
    return true;
}

static void print_status(void) {
    end_line();
    sm_bus_stats_t s = sm_bus_stats();
    print_time(time_us_32());
    printf("VCC %lu.%02lu V, card %s | pages read %lu, programs %lu, erases %lu | "
           "latches %lu, /CE high %lu, discarded %lu, FIFO overflows %lu | log drops %lu+%lu | "
           "programs over unerased pages %lu | data changing at /WE rise %lu | "
           "reads checked %lu, wrong %lu, with nothing queued %lu\n",
           (unsigned long)(vcc_mv / 1000), (unsigned long)(vcc_mv % 1000 / 10),
           powered ? "ACTIVE" : "off (no " HOST " power)",
           (unsigned long)(n_reads + s.direct_pages), (unsigned long)n_programs, (unsigned long)n_erases,
           (unsigned long)s.latches, (unsigned long)s.ignored, (unsigned long)s.discarded,
           (unsigned long)s.rx_overflows, (unsigned long)s.log_drops, (unsigned long)job_drops,
           (unsigned long)sm_flash_unerased_programs, (unsigned long)s.late_changes,
           (unsigned long)s.read_checked, (unsigned long)s.read_errors, (unsigned long)s.read_underruns);
}

static void print_help(void) {
    end_line();
#if SMARTMARE_GENERIC
    printf("\n== SmartMare 5V generic firmware v" SMARTMARE_FW_VERSION ", SmartMedia emulator, generic 4 MB 5 V card, ID %02Xh %02Xh, clk_sys %lu MHz, board v0.%u (ALE GPIO%u, WE GPIO%u) ==\n",
           MAKER_ID, SM_DEVICE_ID, (unsigned long)(clock_get_hz(clk_sys) / 1000000), board_rev, pin_ale, pin_we_n);
    printf("keys: s = status, r = raw bus samples and wrong reads, v = log level (quiet / all / jobs), D = dump the image (B = one block again), W = write blocks (tools/write_image.py), "
           "E = erase the whole image (blank card), U/K/u = firmware update / go back / previous, h = this help\n");
#else
    printf("\n== SmartMare 5V SP-202 " RESEARCH_TAG "firmware v" SMARTMARE_FW_VERSION ", SmartMedia emulator, S4M-5 4 MB, ID %02Xh %02Xh, clk_sys %lu MHz, board v0.%u (ALE GPIO%u, WE GPIO%u) ==\n",
           MAKER_ID, SM_DEVICE_ID, (unsigned long)(clock_get_hz(clk_sys) / 1000000), board_rev, pin_ale, pin_we_n);
    printf("keys: s = status, r = raw bus samples and wrong reads, v = log level (quiet / all / jobs), D = dump the image (B = one block again), W = write blocks (tools/write_image.py), p = pad table (also while on), L/S/G/X = sample sets, "
           "E = erase the 4 MB image, Z = erase everything (image and sample sets), U/K/u = firmware update / go back / previous, h = this help\n");
#endif
    printf("log level: %s\n", log_level == LOG_ALL ? "all" : log_level == LOG_JOBS ? "jobs" : "quiet");
    if (wd_reboot) {
        uint32_t what = last_crumb[0] < count_of(crumb_name) ? last_crumb[0] : 0;
        printf("!! the previous run was stopped by the watchdog: stuck in \"%s\"", crumb_name[what]);
        if (what == CRUMB_JOB)
            printf(" (job %lu, page %lu, block %lu)", (unsigned long)(last_crumb[1] >> 24),
                   (unsigned long)(last_crumb[1] & 0xFFFFFF),
                   (unsigned long)((last_crumb[1] & 0xFFFFFF) / SM_PAGES_PER_BLK));
        else if (what == CRUMB_ERASE_ALL || what == CRUMB_WRITE)
            printf(" (block %lu)", (unsigned long)last_crumb[1]);
        printf(" at %lu.%06lu s\n", (unsigned long)(last_crumb[2] / 1000000),
               (unsigned long)(last_crumb[2] % 1000000));
    }
}

// ---------- card power ----------
static void power_watch(void) {
    static uint32_t above_since;
    uint32_t now = to_ms_since_boot(get_absolute_time());
    vcc_mv = card_if_vcc_mv();
    if (!powered) {
        if (vcc_mv < VCC_ON_MV) {
            above_since = 0;
        } else if (!above_since) {
            above_since = now | 1;
        } else if (now - above_since >= VCC_STABLE_MS) {
            card_if_bus_enable(true);
            sm_bus_set_active(true);
            powered = true;
            end_line();
            print_time(time_us_32());
            printf("card power ON (%lu mV): bus active, card ready\n", (unsigned long)vcc_mv);
        }
    } else if (vcc_mv < VCC_OFF_MV) {
        sm_bus_set_active(false);
        card_if_bus_enable(false);
        powered = false;
        above_since = 0;
        end_line();
        print_time(time_us_32());
        printf("card power OFF (%lu mV): bus inactive\n", (unsigned long)vcc_mv);
    }
}

// ---------- erase the image ----------
// Writes everything, waiting for room in the USB buffer: stdio drops output after 2 ms
// (so that a slow terminal never holds up the card), which would cut the dump. The bytes
// go through the stdio driver, which holds its mutex: TinyUSB also runs from an interrupt
// (the USB drive), and writing to the CDC FIFO beside it lost lines when the reader was
// slow. Only this code writes, so the room seen can only grow before the write.
static void usb_write_all(const char *p, int n) {
    while (n > 0 && stdio_usb_connected()) {
        int room = (int)tud_cdc_write_available();
        if (room <= 0) {
            watchdog_update();
            stdio_usb.out_flush();
            sleep_us(50);
            continue;
        }
        int k = n < room ? n : room;
        stdio_usb.out_chars(p, k);
        p += k;
        n -= k;
    }
    stdio_usb.out_flush();
}

// ---------- dump the image ----------
// Every page that is not all FF, as one text line: "P <page> <1056 hex digits>", and after
// each block "C <block> <crc32>" over its 16 pages (blank ones as FF), so that the reader
// can tell a line damaged on the way and ask for that block again (key B). Read by
// tools/dump_image.py and the Pad Editor. Only without card power, like the erase.
static char dump_line[16 + 2 * SM_PAGE_SIZE + 2];

static uint32_t dump_block(uint32_t block) {
    static uint8_t buf[SM_PAGE_SIZE];
    static const char hex[] = "0123456789ABCDEF";
    uint32_t crc = 0, written = 0;
    for (uint32_t page = block * SM_PAGES_PER_BLK; page < (block + 1) * SM_PAGES_PER_BLK; page++) {
        watchdog_update();
        storage.read_page(storage.ctx, page, buf);
        crc = set_crc32(crc, buf, SM_PAGE_SIZE);
        bool blank = true;
        for (int i = 0; i < SM_PAGE_SIZE && blank; i++)
            blank = buf[i] == 0xFF;
        if (blank)
            continue;
        int n = snprintf(dump_line, sizeof dump_line, "P %lu ", (unsigned long)page);
        for (int i = 0; i < SM_PAGE_SIZE; i++) {
            dump_line[n++] = hex[buf[i] >> 4];
            dump_line[n++] = hex[buf[i] & 15];
        }
        dump_line[n++] = '\n';
        usb_write_all(dump_line, n);
        written++;
    }
    int n = snprintf(dump_line, sizeof dump_line, "C %lu %08lx\n", (unsigned long)block, (unsigned long)crc);
    usb_write_all(dump_line, n);
    return written;
}

static void dump_image(void) {
    end_line();
    if (powered) {
        printf("refused: the card is powered by the " HOST ". Switch it off first.\n");
        return;
    }
    fflush(stdout);
    // Everything below goes through usb_write_all, in order.
    int n0 = snprintf(dump_line, sizeof dump_line, "DUMP %u pages %u bytes\n", SM_PAGES, SM_PAGE_SIZE);
    usb_write_all(dump_line, n0);
    uint32_t written = 0;
    for (uint32_t block = 0; block < SM_BLOCKS; block++)
        written += dump_block(block);
    n0 = snprintf(dump_line, sizeof dump_line, "END %lu pages\n", (unsigned long)written);
    usb_write_all(dump_line, n0);
}

// Key B, then the block number (2 bytes, high first): that block again, as in the dump,
// then "BEND <block>".
static int read_byte(void);
static void dump_one_block(void) {
    int hi = read_byte(), lo = read_byte();
    end_line();
    if (hi < 0 || lo < 0 || ((hi << 8) | lo) >= SM_BLOCKS) {
        printf("ERR block number\n");
        return;
    }
    if (powered) {
        printf("refused: the card is powered by the " HOST ". Switch it off first.\n");
        return;
    }
    fflush(stdout);
    uint32_t block = (uint32_t)((hi << 8) | lo);
    dump_block(block);
    int n = snprintf(dump_line, sizeof dump_line, "BEND %lu\n", (unsigned long)block);
    usb_write_all(dump_line, n);
}

#if !SMARTMARE_GENERIC
// The SP-202 pad table (physical block 1, page 0) as one line "PARAM <1056 hex digits>",
// also while the SP-202 is on: core0 runs every flash job, so none runs during this read.
static void print_param_page(void) {
    static uint8_t buf[SM_PAGE_SIZE];
    static char line[8 + 2 * SM_PAGE_SIZE + 2];
    static const char hex[] = "0123456789ABCDEF";
    end_line();
    service_jobs();                         // a write the SP-202 just made lands first
    storage.read_page(storage.ctx, 1 * SM_PAGES_PER_BLK, buf);
    int n = snprintf(line, sizeof line, "PARAM ");
    for (int i = 0; i < SM_PAGE_SIZE; i++) {
        line[n++] = hex[buf[i] >> 4];
        line[n++] = hex[buf[i] & 15];
    }
    line[n++] = '\n';
    fflush(stdout);
    usb_write_all(line, n);
}
#endif

static void erase_image(void) {
    end_line();
    if (powered) {
        printf("refused: the card is powered by the " HOST ". Remove it first.\n");
        return;
    }
    printf("Erase the whole 4 MB image (a blank card)? Press Y to confirm.\n");
    int c = getchar_timeout_us(10000000);
    if (c != 'Y') {
        printf("cancelled\n");
        return;
    }
    uint32_t t0 = time_us_32();
    for (uint32_t b = 0; b < SM_BLOCKS; b++) {
        crumb(CRUMB_ERASE_ALL, b);
        storage.erase_block(storage.ctx, b);
        watchdog_update();
        if (b % 64 == 63)
            printf("  %lu / %u blocks\n", (unsigned long)b + 1, SM_BLOCKS);
    }
    printf("image erased in %lu ms\n", (unsigned long)((time_us_32() - t0) / 1000));
}

#if !SMARTMARE_GENERIC
static void erase_tick(void);

// Key Z, then Y: a blank card. The SmartMedia image (what the SP-202 sees) and the sample
// sets, all erased. The drive then shows no set.
static void erase_everything(void) {
    end_line();
    if (powered) {
        printf("refused: the card is powered by the " HOST ". Switch it off first.\n");
        return;
    }
    printf("Erase the whole card: the 4 MB image and every sample set? Press Y to confirm.\n");
    int c = getchar_timeout_us(10000000);
    if (c != 'Y') {
        printf("cancelled\n");
        return;
    }
    uint32_t t0 = time_us_32();
    for (uint32_t b = 0; b < SM_BLOCKS; b++) {
        crumb(CRUMB_ERASE_ALL, b);
        storage.erase_block(storage.ctx, b);
        watchdog_update();
        if (b % 128 == 127)
            printf("  image %lu / %u blocks\n", (unsigned long)b + 1, SM_BLOCKS);
    }
    printf("  sample sets...\n");
    set_store_erase_all(erase_tick);
    usb_drive_changed();
    printf("card erased in %lu ms\n", (unsigned long)((time_us_32() - t0) / 1000));
}
#endif

// ---------- write blocks from the PC ----------
// Sent by tools/write_image.py, only without card power. After 'W' the card answers
// "WRITE ready", then for each block: 'B', block number (2 bytes, big-endian), the 16 pages
// of 528 bytes (data + spare), a 16-bit sum of those bytes (big-endian). The card erases the
// block, programs it, reads it back and answers "OK <block>" or "ERR <block> <why>".
// 'Q' ends. Nothing is written if a byte is missing for 3 s.
#define WRITE_BLOCK_BYTES (SM_PAGES_PER_BLK * SM_PAGE_SIZE)

static int read_byte(void) {
    // up to 3 s, in slices: the watchdog (2 s) must keep being fed while the PC is slow
    for (int i = 0; i < 6; i++) {
        watchdog_update();
        int c = getchar_timeout_us(500000);
        if (c != PICO_ERROR_TIMEOUT) return c;
    }
    return PICO_ERROR_TIMEOUT;
}

static void write_image(void) {
    static uint8_t blk[WRITE_BLOCK_BYTES], check[SM_PAGE_SIZE];
    end_line();
    if (powered) {
        printf("refused: the card is powered by the " HOST ". Switch it off first.\n");
        return;
    }
    printf("WRITE ready\n");
    uint32_t done = 0;
    while (true) {
        int c = read_byte();
        if (c == 'Q' || c == PICO_ERROR_TIMEOUT)
            break;
        if (c != 'B')
            continue;
        int hi = read_byte(), lo = read_byte();
        if (hi < 0 || lo < 0)
            break;
        uint32_t b = (uint32_t)hi << 8 | (uint32_t)lo;
        uint16_t sum = 0;
        int i = 0;
        for (; i < WRITE_BLOCK_BYTES; i++) {
            int v = read_byte();
            if (v < 0)
                break;
            blk[i] = (uint8_t)v;
            sum += (uint8_t)v;
        }
        int s1 = i == WRITE_BLOCK_BYTES ? read_byte() : -1;
        int s0 = s1 >= 0 ? read_byte() : -1;
        if (s0 < 0) {
            printf("ERR %lu missing bytes\n", (unsigned long)b);
            break;
        }
        if (b >= SM_BLOCKS || ((uint16_t)(s1 << 8 | s0)) != sum) {
            printf("ERR %lu %s\n", (unsigned long)b, b >= SM_BLOCKS ? "bad block number" : "checksum");
            continue;
        }
        crumb(CRUMB_WRITE, b);
        storage.erase_block(storage.ctx, b);
        watchdog_update();
        bool ok = true;
        for (uint32_t p = 0; p < SM_PAGES_PER_BLK; p++) {
            const uint8_t *src = blk + p * SM_PAGE_SIZE;
            bool blank = true;
            for (int k = 0; k < SM_PAGE_SIZE && blank; k++)
                blank = src[k] == 0xFF;
            if (!blank)
                storage.program_page(storage.ctx, b * SM_PAGES_PER_BLK + p, src);
            storage.read_page(storage.ctx, b * SM_PAGES_PER_BLK + p, check);
            for (int k = 0; k < SM_PAGE_SIZE; k++)
                ok &= check[k] == src[k];
            watchdog_update();
        }
        crumb(CRUMB_IDLE, 0);
        if (ok) {
            printf("OK %lu\n", (unsigned long)b);
            done++;
        } else {
            printf("ERR %lu read back differs\n", (unsigned long)b);
        }
        fflush(stdout);
    }
    printf("WRITE end, %lu blocks written\n", (unsigned long)done);
}

#if !SMARTMARE_GENERIC
// ---------- sample sets on the card (set_store.c) ----------
// For the Pad Editor, only without card power:
//   L                      list: "SET <i> <length> <crc> <stamp> <name>"..., "SETS END <free> <capacity>"
//   S n name len crc stamp save: n = name length (1 byte), len/crc/stamp little-endian u32;
//                          the card erases the space, answers "SET READY", takes `len`
//                          bytes, answers "SET SAVED <i>" or "ERR ..."
//   G i                    get: "SETDATA <length> <crc>", the raw bytes, then "SETDATA END"
//   X i                    delete: "SET DELETED <i>" or "ERR ..."
static bool sets_allowed(void) {
    if (!powered)
        return true;
    printf("ERR the card is powered by the " HOST ". Switch it off first.\n");
    return false;
}

static void sets_list(void) {
    for (int i = 0; i < SET_MAX; i++) {
        const set_entry_t *e = set_store_entry(i);
        if (e)
            printf("SET %d %lu %08lx %lu %.*s\n", i, (unsigned long)e->length, (unsigned long)e->crc,
                   (unsigned long)e->stamp, SET_NAME_MAX, e->name);
    }
    printf("SETS END %lu %lu\n", (unsigned long)set_store_free(), (unsigned long)set_store_capacity());
}

static bool read_u32(uint32_t *v) {
    *v = 0;
    for (int k = 0; k < 4; k++) {
        int c = read_byte();
        if (c < 0)
            return false;
        *v |= (uint32_t)c << (8 * k);
    }
    return true;
}

static void erase_tick(void) {
    watchdog_update();
}

static void sets_save(void) {
    char name[SET_NAME_MAX + 1] = {0};
    int n = read_byte();
    if (n <= 0 || n > SET_NAME_MAX) {
        printf("ERR bad name\n");
        return;
    }
    for (int i = 0; i < n; i++) {
        int c = read_byte();
        if (c < 0) { printf("ERR missing bytes\n"); return; }
        name[i] = (char)c;
    }
    uint32_t len, crc, stamp;
    if (!read_u32(&len) || !read_u32(&crc) || !read_u32(&stamp)) {
        printf("ERR missing bytes\n");
        return;
    }
    if (!sets_allowed())
        return;
    crumb(CRUMB_WRITE, 0xFFFF);
    const char *err = set_store_begin(name, len, crc, stamp, erase_tick);
    if (err) {
        crumb(CRUMB_IDLE, 0);
        printf("ERR %s\n", err);
        return;
    }
    printf("SET READY\n");
    fflush(stdout);
    static uint8_t buf[256];
    uint32_t got = 0;
    while (got < len) {                     // many bytes per call: far faster than getchar
        uint32_t k = len - got < sizeof buf ? len - got : sizeof buf, fill = 0;
        while (fill < k) {
            watchdog_update();
            int rc = stdio_get_until((char *)buf + fill, (int)(k - fill), make_timeout_time_ms(3000));
            if (rc <= 0) {
                crumb(CRUMB_IDLE, 0);
                printf("ERR missing bytes after %lu\n", (unsigned long)(got + fill));
                return;
            }
            fill += (uint32_t)rc;
        }
        set_store_write(buf, k);
        got += k;
    }
    int idx;
    err = set_store_end(&idx);
    crumb(CRUMB_IDLE, 0);
    if (err)
        printf("ERR %s\n", err);
    else {
        usb_drive_changed();                // the drive shows the new set as a file
        printf("SET SAVED %d\n", idx);
    }
}

static void sets_get(void) {
    int i = read_byte();
    const set_entry_t *e = set_store_entry(i);
    if (!e) {
        printf("ERR no such set\n");
        return;
    }
    static char head[64];
    int n = snprintf(head, sizeof head, "SETDATA %lu %08lx\n", (unsigned long)e->length, (unsigned long)e->crc);
    fflush(stdout);
    usb_write_all(head, n);
    const uint8_t *p = set_store_data(i);
    for (uint32_t at = 0; at < e->length; at += 4096) {
        watchdog_update();
        uint32_t k = e->length - at < 4096 ? e->length - at : 4096;
        usb_write_all((const char *)p + at, (int)k);
    }
    usb_write_all("\nSETDATA END\n", 13);
}

static void sets_delete(void) {
    int i = read_byte();
    if (!sets_allowed())
        return;
    const char *err = set_store_delete(i);
    if (err)
        printf("ERR %s\n", err);
    else {
        usb_drive_changed();
        printf("SET DELETED %d\n", i);
    }
}
#endif

// Raw /WE samples since the card went active: what each line was at each rising edge.
static void print_raw(void) {
    static uint32_t r[64];
    uint32_t n = sm_bus_raw(r, 64);
    end_line();
    printf("%lu raw /WE samples since card power ON:\n", (unsigned long)n);
    for (uint32_t i = 0; i < n; i++) {
        uint32_t s = r[i];
        printf("  #%02lu CLE%lu ALE%lu /CE%lu /RE%lu /WP%lu D=%02lX  (raw %08lX)\n", (unsigned long)i,
               (unsigned long)((s >> PIN_CLE) & 1), (unsigned long)((s >> PIN_ALE) & 1),
               (unsigned long)((s >> PIN_CE_N) & 1), (unsigned long)((s >> PIN_RE_N) & 1),
               (unsigned long)((s >> PIN_WP_N) & 1), (unsigned long)((s >> PIN_D0) & 0xFF),
               (unsigned long)s);
    }
    static uint32_t wg[16], wp[16];
    uint32_t nb = sm_bus_read_errors(wg, wp, 16);
    printf("%lu wrong data bytes read by the host (first ones):\n", (unsigned long)nb);
    for (uint32_t i = 0; i < nb; i++)
        printf("  /RE #%lu: want %02lX got %02lX (bits %02lX)\n", (unsigned long)wp[i],
               (unsigned long)(wg[i] >> 8), (unsigned long)(wg[i] & 0xFF),
               (unsigned long)((wg[i] >> 8 ^ wg[i]) & 0xFF));
    uint32_t pulses;
    static uint32_t len[64];
    n = sm_bus_raw_re(r, len, 64, &pulses);
    printf("%lu /RE pulses; the first %lu, ~60 ns after /RE fell:\n", (unsigned long)pulses,
           (unsigned long)n);
    for (uint32_t i = 0; i < n; i++) {
        uint32_t s = r[i];
        printf("  R%02lu /CE%lu D=%02lX  /RE low %lu ns  (raw %08lX)\n", (unsigned long)i,
               (unsigned long)((s >> PIN_CE_N) & 1), (unsigned long)((s >> PIN_D0) & 0xFF),
               (unsigned long)len[i], (unsigned long)s);
    }
}

static void handle_key(int c) {
    switch (c) {
#if SMARTMARE_RESEARCH
    case 'q': research_listen_print(); break;
    case 'Q': research_listen_clear(); break;
    case 't': research_timing_print(); break;
    case 'T': research_timing_clear(); printf("timing: cleared\n"); break;
#endif
    case 's': print_status(); break;
    case 'r': print_raw(); break;
    case 'v':
        log_level = (log_level + 2) % 3;     // all -> jobs -> quiet -> all
        end_line();
        printf("log level: %s\n", log_level == LOG_ALL ? "all" : log_level == LOG_JOBS ? "jobs" : "quiet");
        break;
    case 'E': erase_image(); break;
    case 'D': dump_image(); break;
    case 'B': dump_one_block(); break;
    case 'W': write_image(); break;
    case 'U': end_line(); fw_update_receive(powered); break;
    case 'K': end_line(); fw_update_back(powered); break;
    case 'u': end_line(); fw_update_info(); break;
#if !SMARTMARE_GENERIC
    case 'Z': erase_everything(); break;
    case 'p': print_param_page(); break;
    case 'L': end_line(); sets_list(); break;
    case 'S': end_line(); sets_save(); break;
    case 'G': end_line(); sets_get(); break;
    case 'X': end_line(); sets_delete(); break;
#endif
    case 'h': case '?': print_help(); break;
    default: break;
    }
}

int main(void) {
    card_if_safe_init();
    gpio_init(PIN_LED);
    gpio_set_dir(PIN_LED, GPIO_OUT);
    card_if_vcc_init();
    stdio_init_all();

    // the restart that ends a firmware update is the watchdog's too, but on purpose
    bool update_restart = watchdog_hw->scratch[0] == FW_UPDATE_RESTART;
    wd_reboot = watchdog_caused_reboot() && !update_restart;
    if (watchdog_hw->scratch[0] == CRUMB_MAGIC)
        for (int i = 0; i < 3; i++)
            last_crumb[i] = watchdog_hw->scratch[1 + i];
    crumb(CRUMB_IDLE, 0);

    sm_flash_storage_get(&storage);
#if !SMARTMARE_GENERIC
    set_store_init();
#endif
    usb_drive_init();
    sm_core_init(&core, &storage, MAKER_ID);
    bool layout_ok = sm_flash_storage_layout_ok();
    if (layout_ok)
        sm_bus_init(&core);                  // starts inactive
#if SMARTMARE_RESEARCH
    research_listen_init();                  // pio1, input only
    research_timing_init();                  // pio2, input only
#endif

    // A stuck firmware restarts by itself after 2 s (the longest flash job is ~0.4 s).
    watchdog_enable(2000, true);

    bool was_connected = false;
    uint32_t last_status = 0, last_power = 0, last_beat_ms = 0, last_beat = 0;
    bool core1_stuck = false;
    while (true) {
        watchdog_update();
#if SMARTMARE_RESEARCH
        research_listen_poll();
        research_timing_poll();
#endif
        service_jobs();
        uint32_t now = to_ms_since_boot(get_absolute_time());

        if (layout_ok && now != last_power) {
            last_power = now;
            power_watch();
        }

        // LED
        if (powered)
            gpio_put(PIN_LED, (int32_t)(now - led_dark_until) >= 0);
        else
            gpio_put(PIN_LED, (now / 500) & 1);

        bool connected = stdio_usb_connected();
        if (connected && !was_connected) {
            print_help();
            if (!layout_ok)
                printf("ERROR: the firmware overlaps the image area; bus disabled\n");
            print_status();
        }
        was_connected = connected;

        // Without a terminal the log waits in its buffers instead of being printed into the void.
        for (int i = 0; connected && i < LINES_PER_PASS && core.job == SM_JOB_NONE; i++)
            if (!print_next())
                break;

        // Core1 serves the bus: if its loop stops turning while the card is active, say so.
        if (powered && now - last_beat_ms >= 500) {
            uint32_t beat = sm_bus_heartbeat();
            if (beat == last_beat && !core1_stuck) {
                end_line();
                print_time(time_us_32());
                printf("!! the bus engine (core1) has stopped\n");
            }
            core1_stuck = beat == last_beat;
            last_beat = beat;
            last_beat_ms = now;
        }

        if (now - last_status >= STATUS_PERIOD_MS) {
            last_status = now;
            if (connected)
                print_status();
        }

        int c = getchar_timeout_us(0);
        if (c != PICO_ERROR_TIMEOUT)
            handle_key(c);
    }
}
