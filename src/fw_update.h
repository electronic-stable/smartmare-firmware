/*
 * SmartMare 5V - one-click firmware update over the USB serial link
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.0 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef FW_UPDATE_H
#define FW_UPDATE_H

#include <stdbool.h>

// Left in watchdog scratch[0] before the restart that ends an update: the next boot then
// knows it was meant, not a stuck firmware.
#define FW_UPDATE_RESTART 0x55504454u   // "UPDT"

void fw_update_receive(bool powered);   // key U
void fw_update_back(bool powered);      // key K
void fw_update_info(void);              // key u

#endif
