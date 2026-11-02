/*
 * SmartMare 5V - SmartMedia command scenarios, as the SP-202 drives a card
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.0.0 - 2 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef SM_SCENARIOS_H
#define SM_SCENARIOS_H

#include <stdbool.h>
#include <stdint.h>

#include "sm_core.h"

// What the scenarios drive: the SP-202 side of the bus.
typedef struct {
    void (*reset)(const sm_storage_t *storage);   // card back to power-on state, /WP high
    void (*cmd)(uint8_t v);                       // /WE cycle with CLE
    void (*addr)(uint8_t v);                      // /WE cycle with ALE
    void (*data)(uint8_t v);                      // /WE cycle, data input
    uint8_t (*read)(void);                        // /RE cycle
    bool (*busy)(void);                           // R/B low
    void (*wait_ready)(void);                     // wait for R/B high
    void (*set_wp_low)(bool low);
} sm_host_t;

// Calls straight into sm_core, jobs run inside wait_ready (PC and card).
extern const sm_host_t sm_direct_host;

// Runs every scenario against the storage through the host and prints the results.
// clock_us may be NULL; when given, the slowest storage operations are reported.
// The scenarios erase and use blocks 0-3, 6, 77 and 511 only.
// Returns the number of failed checks.
int sm_run_scenarios(const sm_storage_t *storage, const sm_host_t *host, uint32_t (*clock_us)(void));

#endif
