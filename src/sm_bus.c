/*
 * SmartMare 5V - SmartMedia bus engine: PIO, DMA and core1
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.1 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "sm_bus.h"

#include <assert.h>

#include "hardware/clocks.h"
#include "hardware/dma.h"
#include "hardware/pio.h"
#include "hardware/sync.h"
#include "pico/multicore.h"
#include "pico/stdlib.h"

#include "board_pins.h"
#include "sm_bus.pio.h"
#include "sm_flash_storage.h"

static_assert(PIN_RE_N == 3 && PIN_CE_N == 4 && PIN_D0 == 8, "src/sm_bus.pio hard-codes these GPIOs");
// /WE moved between board revisions (GPIO18 on v0.2, GPIO2 on v0.3): sm_bus_init() patches the
// "wait 0 gpio" that starts sm_latch with the pin card_if_safe_init() found.
static uint16_t latch_code[32];

#define BUS_PIO   pio0
#define SM_LATCH  0
#define SM_OUT    1
#define SM_PROBE  2

static sm_core_t *core;
static uint read_offset;
static int dma_ch;
static volatile bool pause_req, paused;
static volatile bool active;    // false: no card power, latches discarded, R/B busy
static volatile sm_bus_stats_t stats;

// The first raw /WE samples (all GPIOs) since the last activation, for diagnosis
#define RAW_MAX 64
static uint32_t raw[RAW_MAX];
static volatile uint32_t raw_n;
static uint32_t raw_re[RAW_MAX];         // GPIOs during the first /RE pulses
static uint32_t raw_re_len[RAW_MAX];     // their /RE low time, loop counts
static volatile uint32_t raw_re_n, re_pulses;
static int32_t pending_re = -1;          // pulse waiting for its length word

// Event log, core1 -> core0, single producer / single consumer
#define LOG_SIZE 2048
static sm_bus_event_t log_buf[LOG_SIZE];
static volatile uint32_t log_head, log_tail;
static uint16_t data_run;       // data input latches not logged yet

static void log_push(uint8_t kind, uint8_t value, uint16_t count) {
    uint32_t h = log_head;
    if (h - log_tail >= LOG_SIZE) {
        stats.log_drops++;
        return;
    }
    sm_bus_event_t *e = &log_buf[h % LOG_SIZE];
    e->t_us = time_us_32();
    e->kind = kind;
    e->value = value;
    e->count = count;
    __dmb();
    log_head = h + 1;
}

static void log_data_run(void) {
    if (data_run) {
        log_push(SM_EV_DATA, 0, data_run);
        data_run = 0;
    }
}

// Output side, core1 only
static uint16_t dma_len;        // bytes handed to the DMA, consumed once it is done
static int last_status;         // status byte queued, -1 = none
static uint8_t id_sent;

// Back to "nothing queued": called on every command latch, with /RE high, so sm_read is
// not driving (it releases D0-D7 after each /RE pulse). Kept short: the host may read
// a few hundred ns after the command.
// A page read is ready for the host only once its first byte has reached sm_read: until
// then R/B stays busy (the SP-202 reads ~1 us after R/B goes ready, and a byte read too
// early shifts the whole page by one).
static bool stream_live;       // data of the current page is flowing to sm_read
static bool first_pending;     // a DMA has started, its first byte not moved yet

static void out_flush(void) {
    if (dma_len)
        dma_channel_abort(dma_ch);
    dma_len = 0;
    stream_live = false;
    first_pending = false;
    pio_sm_set_enabled(BUS_PIO, SM_OUT, false);
    pio_sm_clear_fifos(BUS_PIO, SM_OUT);
    pio_sm_restart(BUS_PIO, SM_OUT);
    pio_sm_exec(BUS_PIO, SM_OUT, pio_encode_jmp(read_offset));           // to "fetch"
    pio_sm_set_enabled(BUS_PIO, SM_OUT, true);
    last_status = -1;
    id_sent = 0;
}

static inline void out_put(uint8_t b) {
    pio_sm_put(BUS_PIO, SM_OUT, b);
}

// Read check: the data bytes handed to sm_read, in order, compared with what the probe saw
// on D0-D7 during each /RE pulse. Catches wrong bytes and reads with nothing queued.
#define SEG_MAX 8
static const uint8_t *seg_p[SEG_MAX];
static uint16_t seg_n[SEG_MAX];
static uint8_t seg_head, seg_tail;
#define BAD_MAX 16
static uint32_t bad[BAD_MAX];                // want << 16 | got << 8, and the pulse index
static uint32_t bad_pulse[BAD_MAX];
static volatile uint32_t bad_n;

static void verify_queue(const uint8_t *p, uint16_t n) {
    if ((uint8_t)(seg_head - seg_tail) < SEG_MAX) {
        seg_p[seg_head % SEG_MAX] = p;
        seg_n[seg_head % SEG_MAX] = n;
        seg_head++;
    }
}

static void verify_byte(uint8_t got) {
    if (seg_head == seg_tail) {
        if (core->out == SM_OUT_DATA && core->column < SM_PAGE_SIZE)
            stats.read_underruns++;              // the host read with nothing queued
        return;
    }
    uint8_t i = seg_tail % SEG_MAX;
    uint8_t want = sm_flash_writing ? got : *seg_p[i];   // never read XIP during a write
    seg_p[i]++;
    if (--seg_n[i] == 0)
        seg_tail++;
    stats.read_checked++;
    if (want != got) {
        stats.read_errors++;
        if (bad_n < BAD_MAX) {
            bad[bad_n] = (uint32_t)want << 8 | got;
            bad_pulse[bad_n] = re_pulses;
            bad_n++;
        }
    }
}

static void out_service(void) {
    switch (core->out) {
    case SM_OUT_STATUS: {
        // Status can be read any number of times: keep the FIFO full of the current value.
        int s = sm_core_status(core);
        if (last_status >= 0 && s != last_status) {
            // The queued status is stale (e.g. busy -> ready). Replace it, but never
            // in the middle of a /RE pulse.
            if (!gpio_get(PIN_RE_N))
                break;
            out_flush();
        }
        while (!pio_sm_is_tx_fifo_full(BUS_PIO, SM_OUT))
            out_put((uint8_t)s);
        last_status = s;
        break;
    }
    case SM_OUT_ID:
        while (id_sent < 3 && !pio_sm_is_tx_fifo_full(BUS_PIO, SM_OUT)) {
            out_put(sm_core_read(core));                 // maker, device, FF; then nothing
            id_sent++;
        }
        break;
    case SM_OUT_DATA:
        if (dma_len) {
            if (dma_channel_is_busy(dma_ch))
                break;
            // Every byte is in the FIFO now: the page buffer may be reused.
            uint32_t page = core->page;
            stream_live = true;
            first_pending = false;
            sm_core_data_consume(core, dma_len);
            dma_len = 0;
            if (core->page != page)
                stream_live = false;                     // sequential read: a new page
        }
        // A fast host reads a few us after the address, before a page could be copied.
        // When the storage is directly readable, stream from it: the page is "loaded" at
        // once. Never while a program or erase runs (the flash is not readable then).
        if (core->job == SM_JOB_READ && core->storage.direct && !sm_flash_writing) {
            core->job = SM_JOB_NONE;
            stats.direct_pages++;
        }
        if (!sm_core_busy(core) && core->column < SM_PAGE_SIZE) {
            const uint8_t *p;
            uint16_t n;
            if (core->storage.direct) {
                if (sm_flash_writing)
                    break;
                p = core->storage.direct(core->storage.ctx, core->page, core->column, &n);
            } else {
                n = sm_core_data_avail(core, &p);
            }
            if (n) {                                     // past the end: nothing queued, FF
                dma_channel_transfer_from_buffer_now(dma_ch, p, n);
                dma_len = n;
                if (!stream_live)
                    first_pending = true;
                verify_queue(p, n);
            }
        }
        break;
    default:
        break;
    }
}

// R/B is driven by the latch state machine (it sets busy on every command); core1 writes
// it through that SM. rb_level mirrors the pin.
static int rb_level = 1;

static void rb_set(bool busy) {
    pio_sm_exec(BUS_PIO, SM_LATCH, pio_encode_set(pio_pins, busy));
    rb_level = busy;
}

static void rb_update(void) {
    bool busy = true;
    if (first_pending && (dma_channel_hw_addr(dma_ch)->transfer_count & 0x0FFFFFFFu) < dma_len) {
        first_pending = false;                           // the first byte has moved
        stream_live = true;
    }
    if (active) {
        busy = sm_core_busy(core);
        // Sequential read: the next page starts loading while the last bytes of this one
        // are still queued. Show busy only once the host has taken them all.
        if (busy && core->out == SM_OUT_DATA && !pio_sm_is_tx_fifo_empty(BUS_PIO, SM_OUT))
            busy = false;
        // A read: busy from the command until the first byte of the page is in sm_read.
        if (core->state == SM_ST_ADDR_READ ||
            (core->out == SM_OUT_DATA && core->column < SM_PAGE_SIZE && !stream_live))
            busy = true;
    }
    if (busy == rb_level)
        return;
    // Release only with no command waiting: one may have just set busy in the SM.
    if (!busy && !pio_sm_is_rx_fifo_empty(BUS_PIO, SM_LATCH))
        return;
    rb_set(busy);
    if (!busy && !pio_sm_is_rx_fifo_empty(BUS_PIO, SM_LATCH))
        rb_set(true);              // a command landed meanwhile: keep its busy
}

static void handle_probe(void);

static void handle_latches(void) {
    while (pio_sm_get_rx_fifo_level(BUS_PIO, SM_LATCH) >= 2) {
        uint32_t s = pio_sm_get(BUS_PIO, SM_LATCH);          // last sample with /WE low
        uint32_t after = pio_sm_get(BUS_PIO, SM_LATCH);      // just after the rise
        if (active && !(s & (1u << PIN_CE_N)) && ((s ^ after) & DATA_MASK))
            stats.late_changes++;
        if (active && raw_n < RAW_MAX)
            raw[raw_n++] = s;
        if (!active) {
            stats.discarded++;
            continue;
        }
        if (s & (1u << PIN_CE_N)) {
            stats.ignored++;
            continue;
        }
        uint8_t byte = (uint8_t)(s >> PIN_D0);
        uint8_t flags = 0;
        if (s & (1u << PIN_CLE)) flags |= SM_LATCH_CLE;
        if (s & (1u << PIN_ALE)) flags |= SM_LATCH_ALE;
        sm_core_latch(core, byte, flags, !(s & (1u << PIN_WP_N)));
        if (flags & SM_LATCH_CLE) {
            rb_level = 1;          // the latch SM has set R/B busy for this command
            handle_probe();        // check the reads of the previous command first
            seg_head = seg_tail = 0;
            // A new command: drop what was queued and queue its answer (ID, status) now,
            // before anything else.
            out_flush();
            out_service();
        }
        stats.latches++;
        if (flags) {
            log_data_run();
            log_push(flags & SM_LATCH_CLE ? SM_EV_CMD : SM_EV_ADDR, byte, 0);
        } else {
            data_run++;
        }
    }
    const uint32_t stall = 1u << (PIO_FDEBUG_RXSTALL_LSB + SM_LATCH);
    if (BUS_PIO->fdebug & stall) {
        BUS_PIO->fdebug = stall;
        stats.rx_overflows++;
    }
}

static void handle_probe(void) {
    while (!pio_sm_is_rx_fifo_empty(BUS_PIO, SM_PROBE)) {
        uint32_t s = pio_sm_get(BUS_PIO, SM_PROBE);
        if (!active)
            continue;
        if (!(s >> 30)) {                     // a GPIO0-29 sample (lengths have bits 30-31 set): a new pulse
            re_pulses++;
            if (!(s & (1u << PIN_CE_N)))
                verify_byte((uint8_t)(s >> PIN_D0));
            pending_re = -1;
            if (raw_re_n < RAW_MAX) {
                raw_re[raw_re_n] = s;
                raw_re_len[raw_re_n] = 0;
                pending_re = (int32_t)raw_re_n++;
            }
        } else if (pending_re >= 0) {         // its length: the loop count, sent as the down-counter x
            raw_re_len[pending_re] = ~s;
            pending_re = -1;
        }
    }
}

static volatile uint32_t heartbeat;

static void core1_main(void) {
    out_flush();
    while (true) {
        heartbeat++;
        if (pause_req) {
            paused = true;
            while (pause_req)
                tight_loop_contents();
            pio_sm_clear_fifos(BUS_PIO, SM_LATCH);
            out_flush();
            paused = false;
        }
        handle_latches();
        handle_probe();
        if (active)
            out_service();
        rb_update();
    }
}

void sm_bus_init(sm_core_t *c) {
    core = c;

    pio_program_t latch = sm_latch_program;
    hard_assert(latch.length <= count_of(latch_code) && latch.instructions[0] == pio_encode_wait_gpio(false, 18));
    for (uint i = 0; i < latch.length; i++)
        latch_code[i] = latch.instructions[i];
    latch_code[0] = pio_encode_wait_gpio(false, PIN_WE_N);
    latch.instructions = latch_code;
    uint latch_offset = pio_add_program(BUS_PIO, &latch);
    pio_sm_config cl = sm_latch_program_get_default_config(latch_offset);
    sm_config_set_in_pins(&cl, 0);
    sm_config_set_in_shift(&cl, false, true, 32);
    sm_config_set_fifo_join(&cl, PIO_FIFO_JOIN_RX);
    sm_config_set_jmp_pin(&cl, PIN_WE_N);
    sm_config_set_out_shift(&cl, true, false, 32);
    sm_config_set_set_pins(&cl, PIN_RB_CTL, 1);
    pio_sm_init(BUS_PIO, SM_LATCH, latch_offset, &cl);
    // Hand R/B over to the SM without a glitch: output latch busy, output on, then the pin.
    pio_sm_exec(BUS_PIO, SM_LATCH, pio_encode_set(pio_pins, 1));
    pio_sm_set_consecutive_pindirs(BUS_PIO, SM_LATCH, PIN_RB_CTL, 1, true);
    pio_gpio_init(BUS_PIO, PIN_RB_CTL);

    read_offset = pio_add_program(BUS_PIO, &sm_read_program);
    pio_sm_config cr = sm_read_program_get_default_config(read_offset);
    sm_config_set_out_pins(&cr, PIN_D0, DATA_PIN_COUNT);
    sm_config_set_out_shift(&cr, true, false, 32);
    sm_config_set_jmp_pin(&cr, PIN_CE_N);
    sm_config_set_fifo_join(&cr, PIO_FIFO_JOIN_TX);
    for (uint i = 0; i < DATA_PIN_COUNT; i++)
        pio_gpio_init(BUS_PIO, PIN_D0 + i);
    pio_sm_init(BUS_PIO, SM_OUT, read_offset, &cr);

    // The /WE sample must land inside tDH (20 ns): skip the 2-cycle input synchroniser.
    BUS_PIO->input_sync_bypass |= CTRL_IN_MASK | DATA_MASK;

    dma_ch = dma_claim_unused_channel(true);
    dma_channel_config dc = dma_channel_get_default_config(dma_ch);
    channel_config_set_transfer_data_size(&dc, DMA_SIZE_8);
    channel_config_set_read_increment(&dc, true);
    channel_config_set_write_increment(&dc, false);
    channel_config_set_dreq(&dc, pio_get_dreq(BUS_PIO, SM_OUT, true));
    dma_channel_configure(dma_ch, &dc, &BUS_PIO->txf[SM_OUT], NULL, 0, false);

    uint probe_offset = pio_add_program(BUS_PIO, &sm_re_probe_program);
    pio_sm_config cp = sm_re_probe_program_get_default_config(probe_offset);
    sm_config_set_in_pins(&cp, 0);
    sm_config_set_in_shift(&cp, false, false, 32);
    sm_config_set_jmp_pin(&cp, PIN_RE_N);
    sm_config_set_fifo_join(&cp, PIO_FIFO_JOIN_RX);
    pio_sm_init(BUS_PIO, SM_PROBE, probe_offset, &cp);
    pio_sm_set_enabled(BUS_PIO, SM_PROBE, true);

    pio_sm_set_enabled(BUS_PIO, SM_LATCH, true);
    multicore_launch_core1(core1_main);
}

sm_job_t sm_bus_service_jobs(void) {
    sm_job_t j = core->job;
    if (j == SM_JOB_NONE || (j == SM_JOB_READ && core->storage.direct))
        return SM_JOB_NONE;                              // core1 streams reads itself
    sm_core_run_job(core);
    return j;
}

void sm_bus_pause(void) {
    pause_req = true;
    while (!paused)
        tight_loop_contents();
}

void sm_bus_resume(void) {
    pause_req = false;
    while (paused)
        tight_loop_contents();
}

void sm_bus_set_active(bool on) {
    sm_bus_pause();
    active = on;
    if (on) {                       // the probes keep the last session until the next power-on
        raw_n = 0;
        raw_re_n = 0;
        re_pulses = 0;
        bad_n = 0;
        sm_core_init(core, &core->storage, core->maker_id);   // power-on state, ready
    }
    sm_bus_resume();
}

uint32_t sm_bus_heartbeat(void) {
    return heartbeat;
}

bool sm_bus_event_peek(sm_bus_event_t *e) {
    uint32_t t = log_tail;
    if (t == log_head)
        return false;
    __dmb();
    *e = log_buf[t % LOG_SIZE];
    return true;
}

void sm_bus_event_drop(void) {
    if (log_tail != log_head)
        log_tail = log_tail + 1;
}

uint32_t sm_bus_raw_re(uint32_t *out, uint32_t *len_ns, uint32_t max, uint32_t *pulses) {
    uint32_t n = raw_re_n < max ? raw_re_n : max;
    uint32_t ns_per_cycle = 1000000000u / clock_get_hz(clk_sys);
    for (uint32_t i = 0; i < n; i++) {
        out[i] = raw_re[i];
        len_ns[i] = (11 + 2 * raw_re_len[i]) * ns_per_cycle;
    }
    *pulses = re_pulses;
    return n;
}

uint32_t sm_bus_read_errors(uint32_t *want_got, uint32_t *pulse, uint32_t max) {
    uint32_t n = bad_n < max ? bad_n : max;
    for (uint32_t i = 0; i < n; i++) {
        want_got[i] = bad[i];
        pulse[i] = bad_pulse[i];
    }
    return n;
}

uint32_t sm_bus_raw(uint32_t *out, uint32_t max) {
    uint32_t n = raw_n < max ? raw_n : max;
    for (uint32_t i = 0; i < n; i++)
        out[i] = raw[i];
    return n;
}

sm_bus_stats_t sm_bus_stats(void) {
    sm_bus_stats_t s = {stats.latches, stats.ignored, stats.discarded, stats.rx_overflows,
                        stats.log_drops, stats.direct_pages, stats.late_changes,
                        stats.read_checked, stats.read_errors, stats.read_underruns};
    return s;
}
