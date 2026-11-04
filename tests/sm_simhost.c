/*
 * SmartMare 5V - simulated SP-202 driving the real bus, for the self test
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.7 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A simulated SP-202 for the on-card self test, driving the real PIO bus engine.
 *
 * The card cannot drive its own control lines (the 74LVC244 drives them), but the RP2350
 * can override what its peripherals see on an input (GPIO INOVER). Core0 forces /WE, /RE,
 * /CE, CLE, ALE, /WP and D0-D7 that way; the PIO programs and core1 see a real bus.
 * Reads take D0-D7 back from the pads, which the read state machine drives. The data bus
 * buffer stays disabled (/OE high), so nothing leaves the card. Slow (microseconds per
 * cycle): this checks the logic, not the timing.
 */
#include "sm_simhost.h"

#include <stdio.h>

#include "hardware/gpio.h"
#include "pico/stdlib.h"

#include "board_pins.h"
#include "sm_bus.h"

#define WAIT_READY_TIMEOUT_US 2000000

static sm_core_t *core;
static bool wp_low;
static uint32_t timeouts;

static void force(uint pin, bool level) {
    gpio_set_inover(pin, level ? GPIO_OVERRIDE_HIGH : GPIO_OVERRIDE_LOW);
}

static void idle_lines(void) {
    force(PIN_WE_N, 1);
    force(PIN_RE_N, 1);
    force(PIN_CE_N, 0);
    force(PIN_CLE, 0);
    force(PIN_ALE, 0);
    force(PIN_WP_N, !wp_low);
    for (uint i = 0; i < DATA_PIN_COUNT; i++)
        gpio_set_inover(PIN_D0 + i, GPIO_OVERRIDE_NORMAL);
}

static void write_cycle(uint8_t v, bool cle, bool ale) {
    force(PIN_CLE, cle);
    force(PIN_ALE, ale);
    for (uint i = 0; i < DATA_PIN_COUNT; i++)
        force(PIN_D0 + i, (v >> i) & 1);
    busy_wait_us_32(1);
    force(PIN_WE_N, 0);
    busy_wait_us_32(1);
    force(PIN_WE_N, 1);                          // rising edge: the latch SM samples here
    busy_wait_us_32(1);
    idle_lines();
    busy_wait_us_32(5);                          // let core1 handle it
}

static void h_reset(const sm_storage_t *st) {
    sm_bus_pause();
    wp_low = false;
    idle_lines();
    sm_core_init(core, st, 0x98);
    sm_bus_resume();
    busy_wait_us_32(10);
}

static void h_cmd(uint8_t v) { write_cycle(v, true, false); }
static void h_addr(uint8_t v) { write_cycle(v, false, true); }
static void h_data(uint8_t v) { write_cycle(v, false, false); }

static uint8_t h_read(void) {
    force(PIN_RE_N, 0);
    busy_wait_us_32(1);
    uint8_t v = (uint8_t)(gpio_get_all() >> PIN_D0);
    force(PIN_RE_N, 1);
    busy_wait_us_32(2);
    return v;
}

static bool h_busy(void) {
    return gpio_get(PIN_RB_CTL);                 // high = R/B pulled low = busy (PIO drives it)
}

static void h_wait_ready(void) {
    uint32_t t0 = time_us_32();
    while (h_busy()) {
        sm_bus_service_jobs();
        if (time_us_32() - t0 > WAIT_READY_TIMEOUT_US) {
            timeouts++;
            printf("  sim host: R/B still busy after %d ms\n", WAIT_READY_TIMEOUT_US / 1000);
            return;
        }
    }
    busy_wait_us_32(10);                          // core1 queues the first bytes
}

static void h_set_wp_low(bool low) {
    wp_low = low;
    force(PIN_WP_N, !low);
}

static const sm_host_t sim_host = {h_reset, h_cmd, h_addr, h_data, h_read, h_busy, h_wait_ready, h_set_wp_low};

const sm_host_t *sm_simhost_get(sm_core_t *c) {
    core = c;
    return &sim_host;
}

void sm_simhost_release(void) {
    const uint pins[] = {PIN_WE_N, PIN_RE_N, PIN_CE_N, PIN_CLE, PIN_ALE, PIN_WP_N};
    for (uint i = 0; i < count_of(pins); i++)
        gpio_set_inover(pins[i], GPIO_OVERRIDE_NORMAL);
    for (uint i = 0; i < DATA_PIN_COUNT; i++)
        gpio_set_inover(PIN_D0 + i, GPIO_OVERRIDE_NORMAL);
}

uint32_t sm_simhost_timeouts(void) {
    return timeouts;
}
