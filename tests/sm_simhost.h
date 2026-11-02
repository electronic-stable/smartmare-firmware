/*
 * SmartMare 5V - simulated SP-202 driving the real bus, for the self test
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.0.0 - 2 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef SM_SIMHOST_H
#define SM_SIMHOST_H

#include <stdint.h>

#include "sm_core.h"
#include "sm_scenarios.h"

// A host that drives the real PIO bus through GPIO input overrides (see sm_simhost.c).
// sm_bus_init(core) must have been called with the same core.
const sm_host_t *sm_simhost_get(sm_core_t *core);

// Gives the inputs back to the pads.
void sm_simhost_release(void);

uint32_t sm_simhost_timeouts(void);

#endif
