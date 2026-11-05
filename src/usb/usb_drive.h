/*
 * SmartMare 5V - the read-only SMARTMARE USB drive with the loader page
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.8 - 5 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* The SMARTMARE USB drive (usb_drive.c): the Pad Editor, a README, the sample sets. */
#ifndef USB_DRIVE_H
#define USB_DRIVE_H

void usb_drive_init(void);        // after set_store_init()
void usb_drive_changed(void);     // a set was saved or deleted: rebuild, tell the host

#endif
