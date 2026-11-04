/*
 * SmartMare 5V - card interface: safe state, card power sense, data bus enable
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.7 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "card_if.h"

#include "hardware/adc.h"
#include "pico/stdlib.h"

#include "board_pins.h"

unsigned int pin_ale = 17, pin_we_n = 18, board_rev = 2;

// v0.3 ties GPIO19 low through R24 (1k); on v0.2 it is unconnected and reads high with the pull-up.
static void board_detect(void) {
    gpio_init(PIN_HW_ID);
    gpio_pull_up(PIN_HW_ID);
    busy_wait_us(20);
    if (!gpio_get(PIN_HW_ID)) {
        gpio_disable_pulls(PIN_HW_ID);     // R24 holds it
        pin_ale = 1;
        pin_we_n = 2;
        board_rev = 3;
    }
}

// Outputs first, value before direction, so neither line glitches low.
void card_if_safe_init(void) {
    board_detect();

    gpio_init(PIN_RB_CTL);
    gpio_put(PIN_RB_CTL, 1);               // busy
    gpio_set_dir(PIN_RB_CTL, GPIO_OUT);

    gpio_init(PIN_BUS_OE_N);
    gpio_put(PIN_BUS_OE_N, 1);             // bus disabled
    gpio_set_dir(PIN_BUS_OE_N, GPIO_OUT);

    // Control inputs are driven by the 74LVC244: no pulls.
    const uint ctrl[] = {PIN_CLE, PIN_RE_N, PIN_CE_N, PIN_WP_N, PIN_ALE, PIN_WE_N};
    for (uint i = 0; i < count_of(ctrl); i++) {
        gpio_init(ctrl[i]);
        gpio_disable_pulls(ctrl[i]);
    }

    // Data pins float while the 8T245 is disabled: pull-ups (not pull-downs, RP2350-E9).
    for (uint i = 0; i < DATA_PIN_COUNT; i++) {
        gpio_init(PIN_D0 + i);
        gpio_pull_up(PIN_D0 + i);
    }
}

#define ADC_SAMPLES  16
#define ADC_VREF_MV  3300   // ADC_AVDD is the +3V3 rail

void card_if_vcc_init(void) {
    adc_init();
    adc_gpio_init(PIN_VSENSE);
    adc_select_input(ADC_VSENSE);
}

uint32_t card_if_vcc_mv(void) {
    uint32_t sum = 0;
    for (int i = 0; i < ADC_SAMPLES; i++)
        sum += adc_read();
    return (sum * ADC_VREF_MV * VSENSE_DIVIDER) / (ADC_SAMPLES * 4096u);
}

void card_if_bus_enable(bool on) {
    gpio_put(PIN_BUS_OE_N, !on);
}
