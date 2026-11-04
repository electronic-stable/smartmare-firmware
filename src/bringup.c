/*
 * SmartMare 5V - bring-up firmware: first power-on checks of a new board
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.0 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Bring-up firmware for the SmartMedia 5V emulator v0.2.
 *
 * - holds the card interface safe: R/B = BUSY (GPIO6 high), data bus disabled (GPIO7 high)
 * - blinks the LED on GPIO16
 * - measures card VCC on GPIO26 / ADC0 (divider /3)
 * - prints the flash JEDEC ID once, then a status line every 500 ms over USB serial
 *
 * The data pins are never driven: they stay inputs.
 */
#include <stdio.h>

#include "pico/stdlib.h"
#include "hardware/clocks.h"
#include "hardware/flash.h"
#include "hardware/sync.h"

#include "board_pins.h"
#include "card_if.h"

#define STATUS_PERIOD_MS 500
#define LED_PERIOD_MS    250

static const char *vcc_state(uint32_t mv) {
    if (mv < 1000) return "OFF";
    if (mv < 4500) return "LOW";
    if (mv <= 5500) return "OK";
    return "HIGH";
}

static uint8_t jedec[4];

static void read_flash_id(void) {
    uint8_t tx[4] = {0x9f, 0, 0, 0};
    uint32_t irq = save_and_disable_interrupts();
    flash_do_cmd(tx, jedec, sizeof tx);
    restore_interrupts(irq);
}

static void print_flash_id(void) {
    const uint8_t *rx = jedec;
    uint32_t size = rx[3] >= 10 && rx[3] <= 30 ? (1u << rx[3]) : 0;
    printf("flash JEDEC %02X %02X %02X -> %lu MB %s\n", rx[1], rx[2], rx[3],
           (unsigned long)(size >> 20),
           (rx[1] == 0xEF && rx[3] == 0x18) ? "(W25Q128, OK)" : "(UNEXPECTED, want EF 40 18)");
}

static void print_status(void) {
    uint32_t mv = card_if_vcc_mv();
    uint32_t io = gpio_get_all();
    printf("[%8.1f s] VCC %lu.%02lu V %-4s | CLE%u ALE%u /CE%u /RE%u /WE%u /WP%u | D=%02lX | R/B %s | bus %s\n",
           to_ms_since_boot(get_absolute_time()) / 1000.0,
           (unsigned long)(mv / 1000), (unsigned long)((mv % 1000) / 10), vcc_state(mv),
           (unsigned)((io >> PIN_CLE) & 1), (unsigned)((io >> PIN_ALE) & 1),
           (unsigned)((io >> PIN_CE_N) & 1), (unsigned)((io >> PIN_RE_N) & 1),
           (unsigned)((io >> PIN_WE_N) & 1), (unsigned)((io >> PIN_WP_N) & 1),
           (unsigned long)((io & DATA_MASK) >> PIN_D0),
           gpio_get_out_level(PIN_RB_CTL) ? "BUSY" : "READY",
           gpio_get_out_level(PIN_BUS_OE_N) ? "OFF" : "ON");
}

int main(void) {
    card_if_safe_init();

    gpio_init(PIN_LED);
    gpio_set_dir(PIN_LED, GPIO_OUT);

    card_if_vcc_init();

    stdio_init_all();

    read_flash_id();

    absolute_time_t next_led = get_absolute_time();
    absolute_time_t next_status = next_led;
    uint lines = 0;
    while (true) {
        absolute_time_t now = get_absolute_time();
        if (absolute_time_diff_us(now, next_led) <= 0) {
            gpio_xor_mask(1u << PIN_LED);
            next_led = delayed_by_ms(next_led, LED_PERIOD_MS);
        }
        if (absolute_time_diff_us(now, next_status) <= 0) {
            // The banner repeats, so a terminal opened late still sees it.
            if (lines++ % 20 == 0) {
                printf("-- SmartMedia emulator bring-up, clk_sys %lu MHz, ",
                       (unsigned long)(clock_get_hz(clk_sys) / 1000000));
                print_flash_id();
                printf("-- R/B held BUSY, data bus held OFF, data pins inputs --\n");
            }
            print_status();
            next_status = delayed_by_ms(next_status, STATUS_PERIOD_MS);
        }
        tight_loop_contents();
    }
}
