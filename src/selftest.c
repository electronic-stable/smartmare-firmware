/*
 * SmartMare 5V - self-test firmware: checks the card against a simulated SP-202
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.2 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * On-card self test: the SmartMedia scenarios against the image in the W25Q128.
 *
 * - card interface held safe (R/B busy, bus off) the whole time
 * - waits for a terminal on the USB serial port, then:
 *   1. persistence: a counter in block 500 that must survive unplugging the card
 *   2. the same scenarios as the host tests, on the real flash, with timings
 *   3. the same scenarios again through the PIO bus engine (core1), driven by a simulated
 *      SP-202 on core0 (GPIO input overrides; the data bus stays disabled)
 * - then prints a one-line summary every 5 s. LED: slow blink = pass, fast = fail.
 */
#include <stdio.h>
#include <string.h>

#include "pico/stdlib.h"
#include "pico/stdio_usb.h"

#include "board_pins.h"
#include "card_if.h"
#include "sm_core.h"
#include "sm_flash_storage.h"
#include "sm_bus.h"
#include "sm_scenarios.h"
#include "sm_simhost.h"

#define PERSIST_PAGE  (500u * SM_PAGES_PER_BLK)     // block 500, unused by the scenarios
static const char persist_tag[16] = "SMEMU-PERSIST-01";

static uint32_t clock_us(void) { return time_us_32(); }

static uint8_t page_buf[SM_PAGE_SIZE];

// Returns the counter found from the previous boot (0 if none) and stores counter + 1.
static uint32_t persistence_step(const sm_storage_t *st) {
    uint32_t found = 0;
    st->read_page(st->ctx, PERSIST_PAGE, page_buf);
    if (memcmp(page_buf, persist_tag, sizeof persist_tag) == 0)
        memcpy(&found, page_buf + sizeof persist_tag, sizeof found);

    uint32_t next = found + 1;
    st->erase_block(st->ctx, PERSIST_PAGE / SM_PAGES_PER_BLK);
    memset(page_buf, 0xFF, sizeof page_buf);
    memcpy(page_buf, persist_tag, sizeof persist_tag);
    memcpy(page_buf + sizeof persist_tag, &next, sizeof next);
    st->program_page(st->ctx, PERSIST_PAGE, page_buf);
    return found;
}

int main(void) {
    card_if_safe_init();
    gpio_init(PIN_LED);
    gpio_set_dir(PIN_LED, GPIO_OUT);
    stdio_init_all();

    while (!stdio_usb_connected()) {             // wait for a terminal, LED on
        gpio_put(PIN_LED, 1);
        sleep_ms(50);
    }
    sleep_ms(200);
    printf("\n== SmartMedia emulator self test (flash image) ==\n");

    sm_storage_t st;
    sm_flash_storage_get(&st);
    bool layout_ok = sm_flash_storage_layout_ok();
    printf("firmware fits below the image area (1 MB): %s\n", layout_ok ? "yes" : "NO");

    uint32_t found = persistence_step(&st);
    if (found)
        printf("persistence: counter from the previous boot = %lu (now %lu)\n",
               (unsigned long)found, (unsigned long)found + 1);
    else
        printf("persistence: no counter yet (first run); unplug, replug and reopen to check\n");

    printf("\n-- direct (sm_core on core0) --\n");
    int failures = sm_run_scenarios(&st, &sm_direct_host, clock_us);

    static sm_core_t bus_core;
    sm_core_init(&bus_core, &st, 0x98);
    sm_bus_init(&bus_core);
    sm_bus_set_active(true);
    printf("\n-- through the PIO bus (core1), simulated SP-202 on core0 --\n");
    failures += sm_run_scenarios(&st, sm_simhost_get(&bus_core), clock_us);
    sm_simhost_release();
    sm_bus_stats_t bs = sm_bus_stats();
    printf("bus: %lu latches, %lu with /CE high, %lu latch FIFO overflows, %lu R/B timeouts\n",
           (unsigned long)bs.latches, (unsigned long)bs.ignored, (unsigned long)bs.rx_overflows,
           (unsigned long)sm_simhost_timeouts());
    bool pass = layout_ok && failures == 0 && bs.rx_overflows == 0 && sm_simhost_timeouts() == 0;
    printf("\nRESULT: %s\n", pass ? "PASS" : "FAIL");

    uint32_t last = 0;
    while (true) {
        gpio_xor_mask(1u << PIN_LED);
        sleep_ms(pass ? 500 : 100);
        if (time_us_32() - last > 5000000) {
            last = time_us_32();
            printf("self test %s, %d failed checks, persistence counter %lu\n",
                   pass ? "PASS" : "FAIL", failures, (unsigned long)found + 1);
        }
    }
}
