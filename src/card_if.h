/*
 * SmartMare 5V - card interface: safe state, card power sense, data bus enable
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.0 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef CARD_IF_H
#define CARD_IF_H

#include <stdbool.h>
#include <stdint.h>

// Puts the card interface in its safe state: R/B = BUSY, data bus disabled,
// control and data pins as inputs. Call first thing in main().
void card_if_safe_init(void);

// Card VCC (from the SP-202 slot) on ADC0, divider /3.
void card_if_vcc_init(void);
uint32_t card_if_vcc_mv(void);

// SN74LVC8T245 /OE: true connects D0-D7 to the card contacts.
void card_if_bus_enable(bool on);

#endif
