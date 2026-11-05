/*
 * SmartMare 5V - the read-only SMARTMARE USB drive with the loader page
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.8 - 5 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The read-only SMARTMARE drive, built at run time: a FAT16 disk of 64 MB (4 KB clusters)
 * holding the loader page, a README, and a "Sample Sets" folder with one folder per sample
 * set kept on the card (set_store.c): the set's ".smartmare" file and one WAV file per pad.
 * Nothing of the disk is stored: the FAT, the folders and the WAV files are made when the
 * computer reads them, from a small table of files (nodes). A WAV is decoded from the set's
 * SP-202 samples (or taken from its 16-bit audio waiting for a pad) through the pad index the
 * SP-202 Card Manager appends to each set (app/js/project.js). usb_drive_changed() rebuilds the table
 * after a set is saved or deleted and tells the host the medium changed.
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
#define TOTAL_SECTORS   131072u                 // 64 MB: room for the sets and their WAV files
#define FAT_SECTORS     65
#define ROOT_ENTRIES    512
#define ROOT_SECTORS    (ROOT_ENTRIES * 32 / SECTOR)
#define FIRST_FAT       1
#define FIRST_ROOT      (FIRST_FAT + 2 * FAT_SECTORS)
#define FIRST_DATA      (FIRST_ROOT + ROOT_SECTORS)
#define CLUSTERS        ((TOTAL_SECTORS - FIRST_DATA) / SPC)

_Static_assert(CLUSTERS >= 4085 && CLUSTERS < 65525, "FAT16");
_Static_assert((CLUSTERS + 2) * 2 <= FAT_SECTORS * SECTOR, "FAT size");

#if SMARTMARE_GENERIC
#define MAX_NODES       2
#else
#define PADS_MAX        48                      // C/D, A/B, and audio waiting for pads
#define MAX_NODES       (3 + SET_MAX * (2 + PADS_MAX))
#endif

enum { N_PAGE, N_README, N_SETS, N_SET_DIR, N_SET_FILE, N_WAV };
#define ROOT_DIR        0xFFFF                  // parent of the nodes in the root directory

typedef struct {
    uint8_t kind, set, pad, hidden;             // hidden: did not fit on the disk
    uint16_t parent;                            // node index, or ROOT_DIR
    uint16_t pad_unused;
    uint32_t first, count, size;                // clusters [first, first + count), bytes
} node_t;

static node_t nodes[MAX_NODES];
static int nnodes;
static uint16_t placed[MAX_NODES];              // nodes with clusters, by first cluster
static int nplaced;
static volatile bool media_changed;

static void put16(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

static void put32(uint8_t *p, uint32_t v) {
    put16(p, (uint16_t)v);
    put16(p + 2, (uint16_t)(v >> 16));
}

static uint32_t rd32(const uint8_t *p) {
    return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24);
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

// ---------- sets and their pad index ----------
#if !SMARTMARE_GENERIC
typedef struct {
    const uint8_t *data;                        // the set, through XIP
    uint32_t len, index, count, map, blocks;   // pad index, entry count, image map and blocks
} set_view_t;

// The pad index at the end of set i (see app/js/project.js), or false if it has none.
static bool set_view(int i, set_view_t *v) {
    const set_entry_t *e = set_store_entry(i);
    if (!e || e->length < 32)
        return false;
    v->data = set_store_data(i);
    v->len = e->length;
    const uint8_t *foot = v->data + v->len - 16;
    if (memcmp(foot, "SMPADIX1", 8))
        return false;
    uint32_t at = rd32(foot + 8), n = rd32(foot + 12);
    if (at > v->len - 16 || n > v->len - 16 - at || n < 16)
        return false;
    v->index = at;
    v->count = rd32(v->data + at);
    if (v->count > (n - 16) / 64)
        v->count = (n - 16) / 64;
    v->map = rd32(v->data + at + 4);
    v->blocks = rd32(v->data + at + 8);
    if (v->map > v->len || v->len - v->map < 1024)
        v->map = 0;
    return true;
}

static const uint8_t *pad_entry(const set_view_t *v, int pad) {
    return v->data + v->index + 16 + 64 * pad;
}

// Size of the WAV file of a pad, 0 if the entry is not usable.
static uint32_t wav_size(const set_view_t *v, const uint8_t *e) {
    uint32_t kind = e[40], ch = e[41], rate = rd32(e + 44), a = rd32(e + 48), b = rd32(e + 52), c = rd32(e + 56);
    if ((ch != 1 && ch != 2) || rate < 1000 || rate > 192000)
        return 0;
    uint64_t data;
    if (kind == 0) {
        if (!v->map)
            return 0;
        data = ch == 1 ? (uint64_t)(b / 8) * 16 * 2 : (uint64_t)(b / 16) * 16 * 2 * 2;
    } else if (kind == 1) {
        if (a > v->len || (uint64_t)c * 2 > v->len - a || (ch == 2 && (b > v->len || (uint64_t)c * 2 > v->len - b)))
            return 0;
        data = (uint64_t)c * ch * 2;
    } else {
        return 0;
    }
    return data > 0x7FFFFFF ? 0 : (uint32_t)data + 44;
}
#endif

// ---------- the table of files ----------
static int add_node(uint8_t kind, uint16_t parent, int set, int pad, uint32_t size) {
    if (nnodes >= MAX_NODES)
        return -1;
    node_t *n = &nodes[nnodes];
    memset(n, 0, sizeof *n);
    n->kind = kind;
    n->parent = parent;
    n->set = (uint8_t)set;
    n->pad = (uint8_t)pad;
    n->size = size;
    return nnodes++;
}

static uint32_t dir_entries(int dir);           // below, with the directories

static void build(void) {
    nnodes = 0;
    nplaced = 0;
    add_node(N_PAGE, ROOT_DIR, 0, 0, usb_drive_page_len);
    add_node(N_README, ROOT_DIR, 0, 0, usb_drive_readme_len);
#if !SMARTMARE_GENERIC
    int sets = add_node(N_SETS, ROOT_DIR, 0, 0, 0);
    for (int i = 0; i < SET_MAX; i++) {
        const set_entry_t *e = set_store_entry(i);
        if (!e)
            continue;
        int d = add_node(N_SET_DIR, (uint16_t)sets, i, 0, 0);
        if (d < 0)
            break;
        add_node(N_SET_FILE, (uint16_t)d, i, 0, e->length);
        set_view_t v;
        if (!set_view(i, &v))
            continue;
        for (uint32_t p = 0; p < v.count && p < PADS_MAX; p++) {
            uint32_t size = wav_size(&v, pad_entry(&v, (int)p));
            if (size)
                add_node(N_WAV, (uint16_t)d, i, (int)p, size);
        }
    }
#endif
    // clusters, in node order: a directory gets room for all its entries
    uint32_t next = 2;
    for (int k = 0; k < nnodes; k++) {
        node_t *n = &nodes[k];
        uint32_t bytes = n->kind == N_SETS || n->kind == N_SET_DIR ? dir_entries(k) * 32 : n->size;
        uint32_t count = (bytes + CLUSTER - 1) / CLUSTER;
        if ((n->parent != ROOT_DIR && nodes[n->parent].hidden) || next + count > CLUSTERS + 2) {
            n->hidden = 1;
            continue;
        }
        if (!count)
            continue;
        n->first = next;
        n->count = count;
        next += count;
        placed[nplaced++] = (uint16_t)k;
    }
}

// The node holding cluster cl, or -1.
static int node_of(uint32_t cl) {
    int lo = 0, hi = nplaced - 1;
    while (lo <= hi) {
        int mid = (lo + hi) / 2;
        const node_t *n = &nodes[placed[mid]];
        if (cl < n->first)
            hi = mid - 1;
        else if (cl >= n->first + n->count)
            lo = mid + 1;
        else
            return placed[mid];
    }
    return -1;
}

// ---------- directories, made as they are read ----------
// Entries [win_first, win_first + win_n) of the directory go to win; the others are counted.
static uint8_t *win, scratch[32];
static uint32_t win_first, win_n, ent_at;

static uint8_t *next_entry(void) {
    uint32_t i = ent_at++;
    if (i >= win_first && i - win_first < win_n)
        return win + 32 * (i - win_first);
    return scratch;
}

static uint8_t short_checksum(const uint8_t *n11) {
    uint8_t s = 0;
    for (int i = 0; i < 11; i++)
        s = (uint8_t)(((s & 1) << 7) + (s >> 1) + n11[i]);
    return s;
}

// UTF-8 -> UCS-2, at most max characters; returns the count.
static int ucs2(const char *s, uint16_t *out, int max) {
    const uint8_t *p = (const uint8_t *)s;
    int n = 0;
    while (*p && n < max) {
        uint32_t c = *p++;
        if (c >= 0xC0 && c < 0xE0 && (p[0] & 0xC0) == 0x80) {
            c = ((c & 0x1F) << 6) | (p[0] & 0x3F);
            p += 1;
        } else if (c >= 0xE0 && c < 0xF0 && (p[0] & 0xC0) == 0x80 && (p[1] & 0xC0) == 0x80) {
            c = ((c & 0x0F) << 12) | ((p[0] & 0x3F) << 6) | (p[1] & 0x3F);
            p += 2;
        } else if (c >= 0x80) {
            c = '_';                                   // not UTF-8, or outside UCS-2
            while ((*p & 0xC0) == 0x80)
                p++;
        }
        out[n++] = (uint16_t)c;
    }
    return n;
}

// One directory entry, preceded by its long-name entries when long_name is given.
static void add_entry(const char *long_name, const char *short11, uint8_t attr, uint32_t cluster,
                      uint32_t size, uint16_t date, uint16_t time) {
    if (long_name) {
        uint16_t chars[13 * 20];
        int len = ucs2(long_name, chars, 13 * 20 - 1);
        chars[len] = 0;
        int parts = (len + 1 + 12) / 13;
        for (int k = len + 1; k < parts * 13; k++)
            chars[k] = 0xFFFF;
        uint8_t cs = short_checksum((const uint8_t *)short11);
        for (int p = parts; p >= 1; p--) {            // the last part comes first
            uint8_t *e = next_entry();
            memset(e, 0, 32);
            const uint16_t *c = chars + (p - 1) * 13;
            e[0] = (uint8_t)(p | (p == parts ? 0x40 : 0));
            for (int i = 0; i < 5; i++) put16(e + 1 + 2 * i, c[i]);
            e[11] = 0x0F;
            e[13] = cs;
            for (int i = 0; i < 6; i++) put16(e + 14 + 2 * i, c[5 + i]);
            for (int i = 0; i < 2; i++) put16(e + 28 + 2 * i, c[11 + i]);
        }
    }
    uint8_t *e = next_entry();
    memset(e, 0, 32);
    memcpy(e, short11, 11);
    e[11] = attr;
    put16(e + 14, time);
    put16(e + 16, date);
    put16(e + 18, date);
    put16(e + 22, time);
    put16(e + 24, date);
    put16(e + 26, (uint16_t)cluster);
    put32(e + 28, size);
}

// A set's name as a file name: the characters Windows forbids become '_'.
static void set_name(int i, char *out, int cap) {
#if !SMARTMARE_GENERIC
    const set_entry_t *e = set_store_entry(i);
    int n = 0;
    for (int k = 0; e && k < SET_NAME_MAX && e->name[k] && n < cap - 1; k++) {
        char c = e->name[k];
        out[n++] = ((unsigned char)c < 32 || strchr("\\/:*?\"<>|", c)) ? '_' : c;
    }
    while (n && (out[n - 1] == ' ' || out[n - 1] == '.'))
        n--;
    if (!n)
        out[n++] = '_';
    out[n] = 0;
#else
    (void)i;
    snprintf(out, (size_t)cap, "_");
#endif
}

static void stamp_of(const node_t *n, uint16_t *date, uint16_t *time) {
#if !SMARTMARE_GENERIC
    if (n->kind == N_SET_DIR || n->kind == N_SET_FILE || n->kind == N_WAV) {
        const set_entry_t *e = set_store_entry(n->set);
        if (e) {
            fat_stamp(e->stamp, date, time);
            return;
        }
    }
#else
    (void)n;
#endif
    *date = usb_drive_build_date;
    *time = usb_drive_build_time;
}

// The entry of node k in its directory; seq makes the short names unique there.
static void node_entry(int k, int seq) {
    const node_t *n = &nodes[k];
    uint16_t date, time;
    stamp_of(n, &date, &time);
    char name[96], short11[12];
    switch (n->kind) {
    case N_PAGE:
#if SMARTMARE_GENERIC
        add_entry("smartmare-generic-card-manager-v" SMARTMARE_FW_VERSION ".html", "SMARTM~1HTM", 0x01, n->first, n->size, date, time);
#else
        add_entry("smartmare-sp-202-card-manager-v" SMARTMARE_FW_VERSION ".html", "SMARTM~1HTM", 0x01, n->first, n->size, date, time);
#endif
        break;
    case N_README:
        add_entry(NULL, "README  TXT", 0x01, n->first, n->size, date, time);
        break;
    case N_SETS:
        add_entry("Sample Sets", "SAMPLE~1   ", 0x10, n->first, 0, date, time);
        break;
    case N_SET_DIR:
        set_name(n->set, name, 60);
        snprintf(short11, sizeof short11, "SET%02d      ", n->set % 100);
        add_entry(name, short11, 0x10, n->first, 0, date, time);
        break;
    case N_SET_FILE:
        set_name(n->set, name, 60);
        strcat(name, ".smartmare");
        add_entry(name, "SET     SMA", 0x01, n->first, n->size, date, time);
        break;
#if !SMARTMARE_GENERIC
    case N_WAV: {
        set_view_t v;
        int len = 0;
        if (set_view(n->set, &v)) {
            const uint8_t *e = pad_entry(&v, n->pad);
            while (len < 40 && e[len])
                len++;
            memcpy(name, e, (size_t)len);
        }
        if (!len)
            len = snprintf(name, sizeof name, "Pad %d", n->pad + 1);
        memcpy(name + len, ".wav", 5);
        snprintf(short11, sizeof short11, "PAD%03d  WAV", seq % 1000);
        add_entry(name, short11, 0x01, n->first, n->size, date, time);
        break;
    }
#endif
    default:
        break;
    }
}

// Writes the directory (ROOT_DIR or a node) into the window; returns its entry count.
static uint32_t emit_dir(int dir) {
    ent_at = 0;
    if (dir == ROOT_DIR) {
        add_entry(NULL, "SMARTMARE  ", 0x08, 0, 0, usb_drive_build_date, usb_drive_build_time);
    } else {
        const node_t *d = &nodes[dir];
        uint32_t up = d->parent == ROOT_DIR ? 0 : nodes[d->parent].first;
        add_entry(NULL, ".          ", 0x10, d->first, 0, usb_drive_build_date, usb_drive_build_time);
        add_entry(NULL, "..         ", 0x10, up, 0, usb_drive_build_date, usb_drive_build_time);
    }
    int seq = 0;
    for (int k = 0; k < nnodes; k++)
        if (nodes[k].parent == (uint16_t)dir && !nodes[k].hidden)
            node_entry(k, ++seq);
    return ent_at;
}

static uint32_t dir_entries(int dir) {
    win_n = 0;
    return emit_dir(dir);
}

// Sector `sector` of a directory (zeros past its last entry).
static void dir_sector(int dir, uint32_t sector, uint8_t *out) {
    memset(out, 0, SECTOR);
    win = out;
    win_first = sector * (SECTOR / 32);
    win_n = SECTOR / 32;
    emit_dir(dir);
    win_n = 0;
}

// ---------- WAV files, decoded as they are read ----------
#if !SMARTMARE_GENERIC
// The SP-202 codec (as app/js/codec.js): frames of 4 bytes = 8 samples, big-endian words
// in pairs (A, B), the pair's top bits give the layout and the step; stereo pads alternate
// the 8-byte pairs left, right. Each frame ends on its level, so any frame decodes from the
// level of the frame before it.
enum { L_M0, L_M2, L_A0, L_A1, L_EF };
static const uint8_t widths[5][8] = {
    {2, 4, 2, 5, 2, 4, 2, 9}, {3, 4, 3, 5, 3, 4, 3, 5}, {2, 3, 2, 5, 2, 3, 2, 10},
    {2, 4, 2, 6, 2, 4, 2, 7}, {3, 3, 3, 3, 3, 3, 3, 7},
};
static const uint8_t order[8] = {1, 2, 3, 4, 5, 6, 7, 0};

typedef struct {
    const set_view_t *v;
    uint32_t addr, length;
    uint8_t channels;
} sample_src_t;

// A byte of the sample: card address -> the set's image blocks (absent blocks are blank).
static uint8_t card_byte(const set_view_t *v, uint32_t a) {
    uint32_t block = a / 8192, off = a % 8192;
    if (block >= 512 || !v->map)
        return 0xFF;
    const uint8_t *m = v->data + v->map + 2 * block;
    uint32_t slot = m[0] | (m[1] << 8);
    if (!slot)
        return 0xFF;
    uint32_t o = v->blocks + (slot - 1) * 8448 + (off / 512) * 528 + off % 512;
    return o < v->len ? v->data[o] : 0xFF;
}

static uint32_t card_word(const set_view_t *v, uint32_t a) {
    return ((uint32_t)card_byte(v, a) << 24) | (card_byte(v, a + 1) << 16) | (card_byte(v, a + 2) << 8) | card_byte(v, a + 3);
}

static void pair_header(uint32_t wa, uint32_t wb, int *layout, float *step, bool *abs4) {
    uint32_t ma = wa >> 30, mb = wb >> 30;
    *abs4 = false;
    if (ma < 3) {
        uint32_t code = ma * 4 + mb;
        if (code < 6) {
            *layout = L_M0;
            *step = (float)(1u << code);
        } else {
            *layout = L_M2;
            *step = 16.0f * (float)(1u << (code - 6));
            *abs4 = true;
        }
        return;
    }
    uint32_t a = (wa >> 29) & 1, b = (wb >> 29) & 7;
    if (a == 0) {
        *layout = L_A0;
        *step = 0.25f * (float)(1u << b);
    } else if (b < 7) {
        *layout = L_A1;
        *step = 4.0f * (float)(1u << b);
    } else {
        *layout = L_EF;
        *step = (wb >> 28) & 1 ? 0.5f : 0.25f;
    }
}

static void fields(uint32_t w, int layout, int32_t v[8]) {
    uint32_t at = 0;
    for (int i = 0; i < 8; i++) {
        uint32_t width = widths[layout][i], x = (w >> at) & ((1u << width) - 1);
        v[order[i]] = x >= (1u << (width - 1)) ? (int32_t)x - (int32_t)(1u << width) : (int32_t)x;
        at += width;
    }
}

// Frame fi of channel c: its 8 samples, and its level (the next frame's first sample).
static float frame_level(const sample_src_t *s, int c, uint32_t fi) {
    uint32_t pair = s->channels == 2 ? (fi / 2) * 2 + (uint32_t)c : fi / 2;
    uint32_t a = s->addr + pair * 8;
    uint32_t wa = card_word(s->v, a), wb = card_word(s->v, a + 4);
    int layout;
    float step;
    bool abs4;
    pair_header(wa, wb, &layout, &step, &abs4);
    int32_t v[8];
    fields(fi & 1 ? wb : wa, layout, v);
    return step * (float)v[0];
}

static void frame_decode(const sample_src_t *s, int c, uint32_t fi, float prev, float out[8]) {
    uint32_t pair = s->channels == 2 ? (fi / 2) * 2 + (uint32_t)c : fi / 2;
    uint32_t a = s->addr + pair * 8;
    uint32_t wa = card_word(s->v, a), wb = card_word(s->v, a + 4);
    int layout;
    float S;
    bool abs4;
    pair_header(wa, wb, &layout, &S, &abs4);
    int32_t v[8];
    fields(fi & 1 ? wb : wa, layout, v);
    float xa = prev, xb = S * (float)v[0];
    float x4 = (abs4 ? 0.0f : (xa + xb) / 2) + S * (float)v[4];
    float x2 = (xa + x4) / 2 + S * (float)v[2], x6 = (x4 + xb) / 2 + S * (float)v[6];
    out[0] = xa;
    out[1] = (xa + x2) / 2 + S * (float)v[1];
    out[2] = x2;
    out[3] = (x2 + x4) / 2 + S * (float)v[3];
    out[4] = x4;
    out[5] = (x4 + x6) / 2 + S * (float)v[5];
    out[6] = x6;
    out[7] = (x6 + xb) / 2 + S * (float)v[7];
}

// The last frame decoded on each channel: reads are sequential, so most frames decode once.
static struct {
    const uint8_t *data;
    uint32_t addr, fi;
    bool valid;
    float out[8], level;
} cache[2];

static int16_t codec_sample(const sample_src_t *s, int c, uint32_t j) {
    uint32_t fi = j / 8;
    if (!(cache[c].valid && cache[c].data == s->v->data && cache[c].addr == s->addr && cache[c].fi == fi)) {
        float prev;
        if (fi == 0)
            prev = 0;
        else if (cache[c].valid && cache[c].data == s->v->data && cache[c].addr == s->addr && cache[c].fi == fi - 1)
            prev = cache[c].level;
        else
            prev = frame_level(s, c, fi - 1);
        frame_decode(s, c, fi, prev, cache[c].out);
        cache[c].level = frame_level(s, c, fi);
        cache[c].data = s->v->data;
        cache[c].addr = s->addr;
        cache[c].fi = fi;
        cache[c].valid = true;
    }
    // The SP-202 Card Manager's full scale is 2048 codec units (the SP-202's own peaks stay near 1300).
    float x = cache[c].out[j % 8] * (32767.0f / 2048.0f);
    if (x > 32767.0f)
        return 32767;
    if (x < -32768.0f)
        return -32768;
    return (int16_t)(x < 0 ? x - 0.5f : x + 0.5f);
}

static void wav_sector(const node_t *n, uint32_t off, uint8_t *out) {
    memset(out, 0, SECTOR);
    set_view_t v;
    if (!set_view(n->set, &v))
        return;
    const uint8_t *e = pad_entry(&v, n->pad);
    uint32_t kind = e[40], ch = e[41], rate = rd32(e + 44), a = rd32(e + 48), b = rd32(e + 52);
    uint32_t data = n->size - 44;
    uint8_t head[44];
    memcpy(head, "RIFF", 4);
    put32(head + 4, n->size - 8);
    memcpy(head + 8, "WAVEfmt ", 8);
    put32(head + 16, 16);
    put16(head + 20, 1);                               // PCM
    put16(head + 22, (uint16_t)ch);
    put32(head + 24, rate);
    put32(head + 28, rate * ch * 2);
    put16(head + 32, (uint16_t)(ch * 2));
    put16(head + 34, 16);
    memcpy(head + 36, "data", 4);
    put32(head + 40, data);
    sample_src_t s = {&v, a, b, (uint8_t)ch};
    for (uint32_t i = 0; i < SECTOR && off + i < n->size; ) {
        uint32_t pos = off + i;
        if (pos < 44) {
            out[i++] = head[pos];
            continue;
        }
        uint32_t k = (pos - 44) / 2, j = k / ch;          // pos - 44 is even here
        int c = (int)(k % ch);
        int16_t x;
        if (kind == 0) {
            x = codec_sample(&s, c, j);
        } else {
            const uint8_t *p = v.data + (c ? b : a) + 2 * j;
            x = (int16_t)(p[0] | (p[1] << 8));
        }
        out[i++] = (uint8_t)x;
        if (i < SECTOR)
            out[i++] = (uint8_t)((uint16_t)x >> 8);
    }
}
#endif

static uint64_t removed_until;                      // the drive shows no medium until then

void usb_drive_changed(void) {
    uint32_t irq = save_and_disable_interrupts();     // no USB read sees a half-built table
    build();
#if !SMARTMARE_GENERIC
    cache[0].valid = cache[1].valid = false;
#endif
    media_changed = true;
    removed_until = time_us_64() + 1500000;            // 1.5 s without a medium: the host lets go of the old view
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
    put16(s + 19, 0);                                  // more than 65535 sectors: see offset 32
    s[21] = 0xF8;
    put16(s + 22, FAT_SECTORS);
    put16(s + 24, 32);                                 // sectors per track
    put16(s + 26, 64);                                 // heads
    put32(s + 32, TOTAL_SECTORS);
    s[36] = 0x80;
    s[38] = 0x29;
    put16(s + 39, 0x2026);                             // volume serial
    put16(s + 41, 0x5A4D);
    memcpy(s + 43, "SMARTMARE  ", 11);
    memcpy(s + 54, "FAT16   ", 8);
    s[510] = 0x55;
    s[511] = 0xAA;
}

static void fat_sector(uint32_t sector, uint8_t *out) {
    for (uint32_t i = 0; i < SECTOR / 2; i++) {
        uint32_t cl = sector * (SECTOR / 2) + i, v = 0;
        if (cl == 0) {
            v = 0xFFF8;
        } else if (cl == 1) {
            v = 0xFFFF;
        } else {
            int k = node_of(cl);
            if (k >= 0)
                v = cl + 1 < nodes[k].first + nodes[k].count ? cl + 1 : 0xFFFF;
        }
        put16(out + 2 * i, (uint16_t)v);
    }
}

static void read_sector(uint32_t lba, uint8_t *out) {
    if (lba == 0) {
        boot_sector(out);
    } else if (lba < FIRST_ROOT) {
        fat_sector((lba - FIRST_FAT) % FAT_SECTORS, out);
    } else if (lba < FIRST_DATA) {
        dir_sector(ROOT_DIR, lba - FIRST_ROOT, out);
    } else {
        memset(out, 0, SECTOR);
        uint32_t cl = (lba - FIRST_DATA) / SPC + 2;
        int k = node_of(cl);
        if (k < 0)
            return;
        const node_t *n = &nodes[k];
        uint32_t off = (cl - n->first) * CLUSTER + ((lba - FIRST_DATA) % SPC) * SECTOR;
        const uint8_t *src = NULL;
        switch (n->kind) {
        case N_PAGE: src = usb_drive_page; break;
        case N_README: src = usb_drive_readme; break;
        case N_SETS:
        case N_SET_DIR:
            dir_sector(k, off / SECTOR, out);
            return;
#if !SMARTMARE_GENERIC
        case N_SET_FILE: src = set_store_data(n->set); break;
        case N_WAV:
            wav_sector(n, off, out);
            return;
#endif
        default: return;
        }
        if (src && off < n->size)
            memcpy(out, src + off, n->size - off < SECTOR ? n->size - off : SECTOR);
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
    // After a set is saved or deleted: "no medium" for a moment, then "medium changed", as when a
    // card is swapped. Windows then mounts the drive afresh instead of showing its cached folders.
    if (time_us_64() < removed_until) {
        tud_msc_set_sense(lun, SCSI_SENSE_NOT_READY, 0x3A, 0x00);
        return false;
    }
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
