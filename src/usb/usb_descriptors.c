/*
 * SmartMare 5V - USB descriptors: serial port, picotool reset, drive
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.2 - 4 Nov 2026
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * USB descriptors of the SmartMare card: CDC serial (interfaces 0-1), the Raspberry Pi
 * reset interface for picotool (2), the drive with the card's page (3). Modelled on the SDK's
 * pico_stdio_usb descriptors, which are not used once the application provides its own.
 */
#include "pico/unique_id.h"
#include "pico/usb_reset.h"
#include "tusb.h"

#define USBD_VID            0x2E8A      // Raspberry Pi: tools find the card by this
#define USBD_PID            0x0009      // Raspberry Pi Pico SDK CDC
#define USBD_BCD_DEVICE     0x0200      // 2.00: the interfaces changed (drive added)

enum { ITF_CDC = 0, ITF_CDC_DATA, ITF_RESET, ITF_MSC, ITF_COUNT };
_Static_assert(ITF_RESET == PICO_USB_RESET_MS_OS_20_DESCRIPTOR_ITF, "reset interface number");

#define EP_CDC_CMD          0x81
#define EP_CDC_OUT          0x02
#define EP_CDC_IN           0x82
#define EP_MSC_OUT          0x03
#define EP_MSC_IN           0x83

enum { STR_LANG, STR_MANUF, STR_PRODUCT, STR_SERIAL, STR_CDC, STR_RESET, STR_MSC };

#define CONFIG_LEN (TUD_CONFIG_DESC_LEN + TUD_CDC_DESC_LEN + TUD_RPI_RESET_DESC_LEN + TUD_MSC_DESC_LEN)

static const tusb_desc_device_t desc_device = {
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0210,                   // with the Microsoft OS 2.0 descriptor (usb_reset.c)
    .bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = USBD_VID,
    .idProduct = USBD_PID,
    .bcdDevice = USBD_BCD_DEVICE,
    .iManufacturer = STR_MANUF,
    .iProduct = STR_PRODUCT,
    .iSerialNumber = STR_SERIAL,
    .bNumConfigurations = 1,
};

static const uint8_t desc_config[CONFIG_LEN] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_COUNT, 0, CONFIG_LEN, 0, 250),
    TUD_CDC_DESCRIPTOR(ITF_CDC, STR_CDC, EP_CDC_CMD, 8, EP_CDC_OUT, EP_CDC_IN, 64),
    TUD_RPI_RESET_DESCRIPTOR(ITF_RESET, STR_RESET),
    TUD_MSC_DESCRIPTOR(ITF_MSC, STR_MSC, EP_MSC_OUT, EP_MSC_IN, 64),
};

static char serial_str[PICO_UNIQUE_BOARD_ID_SIZE_BYTES * 2 + 1];

static const char *const strings[] = {
    [STR_MANUF] = "Electronic Stable",
#if SMARTMARE_GENERIC
    [STR_PRODUCT] = "SmartMare 5V Generic",
#else
    [STR_PRODUCT] = "SmartMare 5V SP-202",
#endif
    [STR_SERIAL] = serial_str,
    [STR_CDC] = "SmartMare serial",
    [STR_RESET] = "Reset",
    [STR_MSC] = "SmartMare drive",
};

const uint8_t *tud_descriptor_device_cb(void) {
    return (const uint8_t *)&desc_device;
}

const uint8_t *tud_descriptor_configuration_cb(uint8_t index) {
    (void)index;
    return desc_config;
}

const uint16_t *tud_descriptor_string_cb(uint8_t index, uint16_t langid) {
    (void)langid;
    static uint16_t buf[32];
    if (!serial_str[0])
        pico_get_unique_board_id_string(serial_str, sizeof serial_str);
    uint8_t len;
    if (index == STR_LANG) {
        buf[1] = 0x0409;
        len = 1;
    } else {
        if (index >= sizeof strings / sizeof strings[0] || !strings[index])
            return NULL;
        const char *s = strings[index];
        for (len = 0; len < 31 && s[len]; len++)
            buf[1 + len] = (uint8_t)s[len];
    }
    buf[0] = (uint16_t)((TUSB_DESC_STRING << 8) | (2 * len + 2));
    return buf;
}
