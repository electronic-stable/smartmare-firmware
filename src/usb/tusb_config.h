/*
 * SmartMare 5V - TinyUSB settings: serial port, reset interface, drive
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.0 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * TinyUSB for the emulator: the serial port (stdio, the card's commands), the
 * Raspberry Pi reset interface (picotool), and a read-only drive with the card's page (the
 * Pad Editor, or the Card Manager on the generic card).
 * Descriptors in usb_descriptors.c, the drive in usb_drive.c.
 */
#ifndef SMARTMARE_TUSB_CONFIG_H
#define SMARTMARE_TUSB_CONFIG_H

#define CFG_TUSB_RHPORT0_MODE    OPT_MODE_DEVICE
#define CFG_TUD_ENDPOINT0_SIZE   64

#define CFG_TUD_CDC              1
#define CFG_TUD_MSC              1
#define CFG_TUD_HID              0
#define CFG_TUD_MIDI             0
#define CFG_TUD_VENDOR           0

// Bigger CDC buffers make the image dump faster.
#define CFG_TUD_CDC_RX_BUFSIZE   256
#define CFG_TUD_CDC_TX_BUFSIZE   256
#define CFG_TUD_CDC_EP_BUFSIZE   64

#define CFG_TUD_MSC_EP_BUFSIZE   512

#endif
