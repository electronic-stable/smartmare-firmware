/*
 * SmartMare 5V - sample sets kept in the card's flash
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.0 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Sample sets kept on the card, in the flash above the SmartMedia image (7 .. 16 MB).
 * A set is an opaque blob from the Pad Editor (a compressed .smartmare file) with a name.
 *   7 MB          directory: 64 KB reserved, one 4 KB sector used (header + 32 entries)
 *   7 MB + 64 KB  set data, each set starting on a 64 KB boundary (fast block erase)
 * Only used while the SP-202 is off: erasing and programming stop the flash reads.
 */
#ifndef SET_STORE_H
#define SET_STORE_H

#include <stdbool.h>
#include <stdint.h>
#include "crc32.h"

#define SET_MAX       32
#define SET_NAME_MAX  40

typedef struct {
    uint32_t used;                 // SET_ENTRY_USED, or anything else for a free slot
    char name[SET_NAME_MAX];       // not terminated when 40 long
    uint32_t offset, length, crc, stamp;
    uint8_t pad[4];
} set_entry_t;

#define SET_ENTRY_USED 0x45544553u  // "SETE"

void set_store_init(void);
const set_entry_t *set_store_entry(int i);       // NULL if the slot is free
uint32_t set_store_free(void);                   // the largest free run, in bytes
uint32_t set_store_capacity(void);

// Saving: begin finds and erases the space (calling tick() between 64 KB erases), then
// write takes the data in order, end checks the CRC and records the set (replacing a
// set of the same name). Returns NULL or the reason it failed.
const char *set_store_begin(const char *name, uint32_t length, uint32_t crc, uint32_t stamp, void (*tick)(void));
void set_store_write(const uint8_t *data, uint32_t n);
const char *set_store_end(int *index);

const uint8_t *set_store_data(int i);            // the set's bytes, read through XIP
const char *set_store_delete(int i);

// Erases the whole store, directory and data (7 .. 16 MB), calling tick() between 64 KB
// erases. Afterwards the store is empty.
void set_store_erase_all(void (*tick)(void));


#endif
