/*
 * SmartMare 5V - SmartMedia bus engine: PIO, DMA and core1
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.1 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * SmartMedia bus engine: PIO0 + one DMA channel + core1.
 *
 * - SM0 (sm_latch) keeps sampling the bus while /WE is low and hands core1 the last
 *   sample before /WE rises; core1 feeds it to sm_core. On a command it also sets R/B busy
 *   within ~50 ns (the SP-202 checks R/B ~1 us after a command).
 * - SM1 (sm_read) drives D0-D7 during each /RE pulse with /CE low. Core1 keeps its FIFO
 *   filled: page data by DMA straight from the flash (no load time), ID bytes, status.
 * - R/B: set busy by SM0, written by core1 through SM0. After a read command it stays
 *   busy until the first byte of the page has reached SM1 (a byte read earlier would
 *   shift the whole page by one).
 * - SM2 (sm_re_probe) samples D0-D7 during each /RE pulse: core1 checks every data byte
 *   the host reads against the one queued (stats read_checked / read_errors).
 * - Programs and erases run on core0 through sm_bus_service_jobs(), so core1 never waits
 *   on the flash. The firmware must be built copy_to_ram: core1 must not run from XIP
 *   while core0 writes the flash.
 *
 * The engine starts inactive: latches are discarded and R/B shows busy, so a host-less or
 * unpowered bus cannot start a program or an erase. sm_bus_set_active(true) once the card
 * has power. The data bus (/OE) is not touched here: it stays as the caller left it.
 */
#ifndef SM_BUS_H
#define SM_BUS_H

#include <stdbool.h>
#include <stdint.h>

#include "sm_core.h"

typedef struct {
    uint32_t latches;          // /WE edges handled with /CE low
    uint32_t ignored;          // /WE edges with /CE high
    uint32_t discarded;        // /WE edges while inactive
    uint32_t rx_overflows;     // the latch FIFO filled up: /WE edges were lost
    uint32_t log_drops;        // events lost because the log was full
    uint32_t direct_pages;     // pages streamed straight from the storage (no load time)
    uint32_t late_changes;     // /WE edges where D0-D7 changed right after the rise
    uint32_t read_checked;     // data bytes read by the host and checked
    uint32_t read_errors;      // ... that were not the byte queued
    uint32_t read_underruns;   // data reads with nothing queued (the host got FF)
} sm_bus_stats_t;

enum { SM_EV_CMD, SM_EV_ADDR, SM_EV_DATA };

typedef struct {
    uint32_t t_us;
    uint8_t kind;              // SM_EV_*
    uint8_t value;             // command or address byte
    uint16_t count;            // SM_EV_DATA: number of data input bytes
} sm_bus_event_t;

// Starts PIO, DMA and the core1 engine on this core instance.
void sm_bus_init(sm_core_t *core);

// Core0: runs the pending flash job, if any. Call it often. Page loads are served by
// core1 straight from the storage when it can stream them. Returns the job run.
sm_job_t sm_bus_service_jobs(void);

// Stops / restarts the engine, so core0 can re-initialise the core instance safely.
void sm_bus_pause(void);
void sm_bus_resume(void);

// Active: card powered, the core starts in its power-on state. Inactive: R/B busy,
// latches discarded.
void sm_bus_set_active(bool on);

// Counts core1 engine loops: if it stops moving, the engine is stuck.
uint32_t sm_bus_heartbeat(void);

// Command / address / data-run log, oldest first.
bool sm_bus_event_peek(sm_bus_event_t *e);
void sm_bus_event_drop(void);

// The first wrong bytes read by the host since the bus went active: want << 8 | got, and
// the /RE pulse number.
uint32_t sm_bus_read_errors(uint32_t *want_got, uint32_t *pulse, uint32_t max);

// The first raw /WE samples (GPIO0-31) since the bus went active, oldest first.
uint32_t sm_bus_raw(uint32_t *out, uint32_t max);

// GPIOs ~60 ns into the first /RE pulses since the bus went active (what the card
// presented on D0-D7), how long each /RE stayed low (ns, +-7), and the number of pulses.
uint32_t sm_bus_raw_re(uint32_t *out, uint32_t *len_ns, uint32_t max, uint32_t *pulses);

sm_bus_stats_t sm_bus_stats(void);

#endif
