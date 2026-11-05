/*
 * SmartMare 5V - GPIO map of the card, per board version
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.8 - 5 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * GPIO map of the SmartMare card, v0.2 and v0.3.
 * Source of truth: the board design script (RP_NETS in design.py, kept with the hardware files).
 * v0.3 moved ALE and /WE from GPIO17/18 to GPIO1/2, next to the other bus control pins.
 * GPIO19 tells the boards apart: tied low through R24 on v0.3, unconnected on v0.2.
 * card_if_safe_init() reads it first, so one firmware runs on both boards.
 */
#ifndef BOARD_PINS_H
#define BOARD_PINS_H

// Card control inputs, through the 74LVC244 (always driven, 3.3 V levels)
#define PIN_CLE      0
#define PIN_RE_N     3
#define PIN_CE_N     4
#define PIN_WP_N     5
#define PIN_ALE      pin_ale     // GPIO1 on v0.3, GPIO17 on v0.2
#define PIN_WE_N     pin_we_n    // GPIO2 on v0.3, GPIO18 on v0.2
extern unsigned int pin_ale, pin_we_n;

#define PIN_HW_ID    19          // board marker: low = v0.3
extern unsigned int board_rev;   // 2 or 3, set by card_if_safe_init()

// Outputs to the card side
#define PIN_RB_CTL   6   // BSS138 gate: HIGH = card R/B pulled low = BUSY (R9 pull-up = busy at reset)
#define PIN_BUS_OE_N 7   // SN74LVC8T245 /OE: HIGH = data bus disabled (R10 pull-up = disabled at reset)

// Data D0..D7, through 68R arrays and the SN74LVC8T245.
// The 8T245 DIR = NOR(/CE, /RE): it drives the MCU side at all times except while
// /CE and /RE are both low. The MCU may only drive these pins inside such a pulse.
#define PIN_D0       8
#define DATA_PIN_COUNT 8
#define DATA_MASK    (0xFFu << PIN_D0)

#define PIN_LED      16

// Card VCC sense: R19 20k / R20 10k divider -> ADC0
#define PIN_VSENSE   26
#define ADC_VSENSE   0
#define VSENSE_DIVIDER 3

#define CTRL_IN_MASK ((1u << PIN_CLE) | (1u << PIN_RE_N) | (1u << PIN_CE_N) | \
                      (1u << PIN_WP_N) | (1u << PIN_ALE) | (1u << PIN_WE_N))

#endif
