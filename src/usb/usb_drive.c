/*
 * SmartMare 5V - the read-only SMARTMARE USB drive with the loader page
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.0.0 - 2 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The read-only SMARTMARE drive, built at run time: a FAT12 disk of 12 MB (4 KB clusters)
 * holding the Pad Editor page, a README, and a "Sample Sets" folder with one ".smartmare"
 * file per sample set kept on the card (set_store.c). Only the FAT and the directories
 * exist in RAM; file data is read from the firmware (page, README) or the flash (sets).
 * usb_drive_changed() rebuilds them after a set is saved or deleted and tells the host
 * the medium changed, so Explorer shows the new list.
 */
#include <stdio.h>
#include <string.h>

#include "hardware/sync.h"
#if !SMARTMARE_GENERIC
#include "set_store.h"
#endif
#include "tusb.h"
#include "usb_drive.h"

extern const uint16_t usb_drive_build_date, usb_drive_build_time;
extern const uint32_t usb_drive_page_len, usb_drive_readme_len;
extern const uint8_t usb_drive_page[], usb_drive_readme[];

#define SECTOR          512
#define SPC             8                       // sectors per cluster: 4 KB clusters
#define CLUSTER         (SECTOR * SPC)
#define TOTAL_SECTORS   24576                   // 12 MB: room for 8.9 MB of sets
#define FAT_SECTORS     9
#define ROOT_ENTRIES    256
#define ROOT_SECTORS    (ROOT_ENTRIES * 32 / SECTOR)
#define FIRST_FAT       1
#define FIRST_ROOT      (FIRST_FAT + 2 * FAT_SECTORS)
#define FIRST_DATA      (FIRST_ROOT + ROOT_SECTORS)
#define CLUSTERS        ((TOTAL_SECTORS - FIRST_DATA) / SPC)
#if SMARTMARE_GENERIC
#define MAX_FILES       2                  // the page and the README
#else
#define MAX_FILES       (2 + SET_MAX)
#endif

_Static_assert(CLUSTERS < 4085, "FAT12");
_Static_assert((CLUSTERS + 2) * 3 / 2 <= FAT_SECTORS * SECTOR, "FAT size");

typedef struct {
    const uint8_t *data;
    uint32_t size, first, count;                // clusters [first, first + count)
} file_t;

static file_t files[MAX_FILES];
static int nfiles;
static uint8_t fat[FAT_SECTORS * SECTOR];
static uint8_t root[ROOT_ENTRIES * 32];
#define FOLDER_CLUSTERS 2                       // 256 entries: 32 sets with long names
static uint8_t folder[FOLDER_CLUSTERS * CLUSTER];
static volatile bool media_changed;

// ---------- building the FAT and the root directory ----------
static void fat_set(uint32_t n, uint32_t v) {
    uint32_t o = n * 3 / 2;
    if (n & 1) {
        fat[o] = (uint8_t)((fat[o] & 0x0F) | (v << 4));
        fat[o + 1] = (uint8_t)(v >> 4);
    } else {
        fat[o] = (uint8_t)v;
        fat[o + 1] = (uint8_t)((fat[o + 1] & 0xF0) | ((v >> 8) & 0x0F));
    }
}

static uint8_t short_checksum(const uint8_t *n11) {
    uint8_t s = 0;
    for (int i = 0; i < 11; i++)
        s = (uint8_t)(((s & 1) << 7) + (s >> 1) + n11[i]);
    return s;
}

static bool leap(uint32_t y) {
    return y % 4 == 0 && (y % 100 || y % 400 == 0);
}

// Unix time -> FAT date and time (UTC).
static void fat_stamp(uint32_t t, uint16_t *date, uint16_t *time) {
    uint32_t days = t / 86400, secs = t % 86400, y = 1970, m = 0;
    while (days >= (leap(y) ? 366u : 365u))
        days -= leap(y++) ? 366 : 365;
    static const uint8_t mdays[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    while (true) {
        uint32_t len = mdays[m] + (m == 1 && leap(y));
        if (days < len)
            break;
        days -= len;
        m++;
    }
    if (y < 1980) {
        *date = (1 << 5) | 1;
        *time = 0;
        return;
    }
    *date = (uint16_t)(((y - 1980) << 9) | ((m + 1) << 5) | (days + 1));
    *time = (uint16_t)(((secs / 3600) << 11) | (((secs / 60) % 60) << 5) | ((secs % 60) / 2));
}

// The directory being filled: the root, then the Sample Sets folder.
static uint8_t *dir;
static int dir_at, dir_cap;

static void dir_begin(uint8_t *buf, int entries) {
    dir = buf;
    dir_at = 0;
    dir_cap = entries;
}

static uint8_t *root_entry(void) {
    return dir_at < dir_cap ? dir + 32 * dir_at++ : NULL;
}

static void put16(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

// One directory entry, preceded by its long-name entries when long_name is given.
static void add_entry(const char *long_name, const char *short11, uint8_t attr, uint32_t cluster,
                      uint32_t size, uint16_t date, uint16_t time) {
    if (long_name) {
        uint16_t chars[13 * 20];
        int len = 0;
        while (long_name[len] && len < 13 * 20 - 1) {
            chars[len] = (uint8_t)long_name[len];
            len++;
        }
        chars[len] = 0;
        int parts = (len + 1 + 12) / 13;
        for (int k = len + 1; k < parts * 13; k++)
            chars[k] = 0xFFFF;
        uint8_t cs = short_checksum((const uint8_t *)short11);
        for (int p = parts; p >= 1; p--) {            // the last part comes first
            uint8_t *e = root_entry();
            if (!e)
                return;
            const uint16_t *c = chars + (p - 1) * 13;
            e[0] = (uint8_t)(p | (p == parts ? 0x40 : 0));
            for (int i = 0; i < 5; i++) put16(e + 1 + 2 * i, c[i]);
            e[11] = 0x0F;
            e[13] = cs;
            for (int i = 0; i < 6; i++) put16(e + 14 + 2 * i, c[5 + i]);
            for (int i = 0; i < 2; i++) put16(e + 28 + 2 * i, c[11 + i]);
        }
    }
    uint8_t *e = root_entry();
    if (!e)
        return;
    memcpy(e, short11, 11);
    e[11] = attr;
    put16(e + 14, time);
    put16(e + 16, date);
    put16(e + 18, date);
    put16(e + 22, time);
    put16(e + 24, date);
    put16(e + 26, (uint16_t)cluster);
    put16(e + 28, (uint16_t)size);
    put16(e + 30, (uint16_t)(size >> 16));
}

static uint32_t next_cluster;

// Clusters for `size` bytes of `data`; the first cluster, or 0 if it does not fit.
static uint32_t place(const uint8_t *data, uint32_t size) {
    uint32_t count = (size + CLUSTER - 1) / CLUSTER;
    if (nfiles >= MAX_FILES || next_cluster + count > CLUSTERS + 2)
        return 0;
    file_t *f = &files[nfiles++];
    f->data = data;
    f->size = size;
    f->first = count ? next_cluster : 0;
    f->count = count;
    for (uint32_t k = 0; k < count; k++)
        fat_set(next_cluster + k, k + 1 < count ? next_cluster + k + 1 : 0xFFF);
    next_cluster += count;
    return f->first;
}

static void add_file(const char *long_name, const char *short11, const uint8_t *data, uint32_t size,
                     uint16_t date, uint16_t time) {
    uint32_t first = place(data, size);
    if (first || !size)
        add_entry(long_name, short11, 0x01, first, size, date, time);      // read-only
}

static void build(void) {
    const uint16_t bd = usb_drive_build_date, bt = usb_drive_build_time;
    memset(fat, 0, sizeof fat);
    memset(root, 0, sizeof root);
    memset(folder, 0, sizeof folder);
    nfiles = 0;
    next_cluster = 2;
    fat_set(0, 0xFF8);
    fat_set(1, 0xFFF);
    dir_begin(root, ROOT_ENTRIES);
    add_entry(NULL, "SMARTMARE  ", 0x08, 0, 0, bd, bt);
#if SMARTMARE_GENERIC
    add_file("SmartMare Card Manager.html", "SMARTM~1HTM", usb_drive_page, usb_drive_page_len, bd, bt);
    add_file(NULL, "README  TXT", usb_drive_readme, usb_drive_readme_len, bd, bt);
#else
    add_file("SmartMare Pad Editor.html", "SMARTM~1HTM", usb_drive_page, usb_drive_page_len, bd, bt);
    add_file(NULL, "README  TXT", usb_drive_readme, usb_drive_readme_len, bd, bt);
    uint32_t sets_dir = place(folder, sizeof folder);
    add_entry("Sample Sets", "SAMPLE~1   ", 0x10, sets_dir, 0, bd, bt);
    dir_begin(folder, (int)(sizeof folder / 32));
    add_entry(NULL, ".          ", 0x10, sets_dir, 0, bd, bt);
    add_entry(NULL, "..         ", 0x10, 0, 0, bd, bt);
    for (int i = 0; i < SET_MAX; i++) {
        const set_entry_t *e = set_store_entry(i);
        if (!e)
            continue;
        char name[SET_NAME_MAX + 16];
        int n = 0;
        for (int k = 0; k < SET_NAME_MAX && e->name[k]; k++) {
            char c = e->name[k];                       // characters Windows forbids in names
            name[n++] = ((unsigned char)c < 32 || strchr("\\/:*?\"<>|", c)) ? '_' : c;
        }
        memcpy(name + n, ".smartmare", 11);
        char short11[12];
        snprintf(short11, sizeof short11, "SET%02d   SMA", i);
        uint16_t date, time;
        fat_stamp(e->stamp, &date, &time);
        add_file(name, short11, set_store_data(i), e->length, date, time);
    }
#endif
}

void usb_drive_changed(void) {
    uint32_t irq = save_and_disable_interrupts();     // no USB read sees a half-built table
    build();
    media_changed = true;
    restore_interrupts(irq);
}

void usb_drive_init(void) {
    build();
}

// ---------- sectors ----------
static void boot_sector(uint8_t *s) {
    static const uint8_t head[] = {0xEB, 0x3C, 0x90, 'M', 'S', 'D', 'O', 'S', '5', '.', '0'};
    memset(s, 0, SECTOR);
    memcpy(s, head, sizeof head);
    put16(s + 11, SECTOR);
    s[13] = SPC;
    put16(s + 14, 1);                                  // reserved sectors
    s[16] = 2;                                         // FATs
    put16(s + 17, ROOT_ENTRIES);
    put16(s + 19, TOTAL_SECTORS);
    s[21] = 0xF8;
    put16(s + 22, FAT_SECTORS);
    put16(s + 24, 32);                                 // sectors per track
    put16(s + 26, 2);                                  // heads
    s[36] = 0x80;
    s[38] = 0x29;
    put16(s + 39, 0x2026);                             // volume serial
    put16(s + 41, 0x5A4D);
    memcpy(s + 43, "SMARTMARE  ", 11);
    memcpy(s + 54, "FAT12   ", 8);
    s[510] = 0x55;
    s[511] = 0xAA;
}

static void read_sector(uint32_t lba, uint8_t *out) {
    if (lba == 0) {
        boot_sector(out);
    } else if (lba < FIRST_ROOT) {
        memcpy(out, fat + ((lba - FIRST_FAT) % FAT_SECTORS) * SECTOR, SECTOR);
    } else if (lba < FIRST_DATA) {
        memcpy(out, root + (lba - FIRST_ROOT) * SECTOR, SECTOR);
    } else {
        memset(out, 0, SECTOR);
        uint32_t cl = (lba - FIRST_DATA) / SPC + 2, inner = (lba - FIRST_DATA) % SPC;
        for (int i = 0; i < nfiles; i++) {
            const file_t *f = &files[i];
            if (f->count && cl >= f->first && cl < f->first + f->count) {
                uint32_t off = (cl - f->first) * CLUSTER + inner * SECTOR;
                if (off < f->size)
                    memcpy(out, f->data + off, f->size - off < SECTOR ? f->size - off : SECTOR);
                break;
            }
        }
    }
}

// ---------- TinyUSB MSC callbacks ----------
void tud_msc_inquiry_cb(uint8_t lun, uint8_t vendor_id[8], uint8_t product_id[16], uint8_t product_rev[4]) {
    (void)lun;
    memcpy(vendor_id, "DHE     ", 8);
    memcpy(product_id, "SmartMare drive ", 16);
    memcpy(product_rev, "1.1 ", 4);
}

bool tud_msc_test_unit_ready_cb(uint8_t lun) {
    if (media_changed) {                               // once: the host reads the disk again
        media_changed = false;
        tud_msc_set_sense(lun, SCSI_SENSE_UNIT_ATTENTION, 0x28, 0x00);
        return false;
    }
    return true;
}

void tud_msc_capacity_cb(uint8_t lun, uint32_t *block_count, uint16_t *block_size) {
    (void)lun;
    *block_count = TOTAL_SECTORS;
    *block_size = SECTOR;
}

bool tud_msc_start_stop_cb(uint8_t lun, uint8_t power_condition, bool start, bool load_eject) {
    (void)lun; (void)power_condition; (void)start; (void)load_eject;
    return true;
}

bool tud_msc_is_writable_cb(uint8_t lun) {
    (void)lun;
    return false;
}

int32_t tud_msc_read10_cb(uint8_t lun, uint32_t lba, uint32_t offset, void *buffer, uint32_t bufsize) {
    (void)lun;
    static uint8_t sec[SECTOR];
    uint8_t *out = buffer;
    uint32_t done = 0;
    while (done < bufsize) {
        if (lba >= TOTAL_SECTORS)
            return -1;
        read_sector(lba, sec);
        uint32_t k = SECTOR - offset < bufsize - done ? SECTOR - offset : bufsize - done;
        memcpy(out + done, sec + offset, k);
        done += k;
        offset = 0;
        lba++;
    }
    return (int32_t)bufsize;
}

int32_t tud_msc_write10_cb(uint8_t lun, uint32_t lba, uint32_t offset, uint8_t *buffer, uint32_t bufsize) {
    (void)lba; (void)offset; (void)buffer; (void)bufsize;
    tud_msc_set_sense(lun, SCSI_SENSE_DATA_PROTECT, 0x27, 0x00);    // write protected
    return -1;
}

int32_t tud_msc_scsi_cb(uint8_t lun, const uint8_t scsi_cmd[16], void *buffer, uint16_t bufsize) {
    (void)buffer; (void)bufsize;
    switch (scsi_cmd[0]) {
    case SCSI_CMD_PREVENT_ALLOW_MEDIUM_REMOVAL:
        return 0;
    default:
        tud_msc_set_sense(lun, SCSI_SENSE_ILLEGAL_REQUEST, 0x20, 0x00);
        return -1;
    }
}
