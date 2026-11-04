# SmartMare 5V - firmware build: SP-202 and generic firmwares, self test, bring-up
#
# Fabien Roffet for Electronic Stable - smartmare.com
# Version 1.2.0 - 4 Nov 2026
# SPDX-License-Identifier: GPL-3.0-or-later

cmake_minimum_required(VERSION 3.13)

# Custom board: boards/smartmedia_rp2350a.h (RP2350A, 12 MHz crystal, 16 MB W25Q128)
set(PICO_BOARD_HEADER_DIRS ${CMAKE_CURRENT_LIST_DIR}/boards)
set(PICO_BOARD smartmedia_rp2350a CACHE STRING "Board type")

include(pico_sdk_import.cmake)

# The firmware version: in the .uf2 names and the USB banner.
project(smartmedia_fw VERSION 1.2.0 LANGUAGES C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

pico_sdk_init()

# Step 1: bring-up
add_executable(smartmedia_bringup src/bringup.c src/card_if.c)
target_include_directories(smartmedia_bringup PRIVATE src)
target_link_libraries(smartmedia_bringup pico_stdlib hardware_adc hardware_flash)
pico_enable_stdio_usb(smartmedia_bringup 1)
pico_enable_stdio_uart(smartmedia_bringup 0)
pico_add_extra_outputs(smartmedia_bringup)

# Step 2: SmartMedia core + image in flash + PIO bus, self test over USB
add_executable(smartmedia_selftest
    src/selftest.c src/card_if.c src/sm_core.c src/sm_flash_storage.c src/sm_bus.c
    tests/sm_scenarios.c tests/sm_simhost.c)
target_include_directories(smartmedia_selftest PRIVATE src tests)
pico_generate_pio_header(smartmedia_selftest ${CMAKE_CURRENT_LIST_DIR}/src/sm_bus.pio)
target_link_libraries(smartmedia_selftest pico_stdlib pico_multicore hardware_adc hardware_flash hardware_pio hardware_dma)
# Core1 serves the bus while core0 writes the flash: nothing may run from XIP.
pico_set_binary_type(smartmedia_selftest copy_to_ram)
pico_enable_stdio_usb(smartmedia_selftest 1)
pico_enable_stdio_uart(smartmedia_selftest 0)
pico_add_extra_outputs(smartmedia_selftest)

# The emulator. On USB: the serial port, the picotool reset interface, and a read-only
# drive with the SP-202 Card Manager (app/), built into the firmware by tools/build_drive.py.
find_package(Python3 REQUIRED COMPONENTS Interpreter)
file(GLOB APP_FILES ${CMAKE_CURRENT_LIST_DIR}/app/*.html ${CMAKE_CURRENT_LIST_DIR}/app/*.css ${CMAKE_CURRENT_LIST_DIR}/app/js/*.js)
add_custom_command(
    OUTPUT ${CMAKE_BINARY_DIR}/drive_files.c ${CMAKE_BINARY_DIR}/smartmare-sp-202-card-manager-v${PROJECT_VERSION}.html
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_LIST_DIR}/tools/build_drive.py ${CMAKE_BINARY_DIR}/drive_files.c
            --html ${CMAKE_BINARY_DIR}/smartmare-sp-202-card-manager-v${PROJECT_VERSION}.html
    DEPENDS ${APP_FILES} ${CMAKE_CURRENT_LIST_DIR}/tools/build_drive.py
    COMMENT "Building the SP-202 Card Manager USB drive")
add_executable(smartmedia_emu
    src/main.c src/card_if.c src/sm_core.c src/sm_flash_storage.c src/sm_bus.c
    src/crc32.c src/fw_update.c src/set_store.c src/usb/usb_descriptors.c src/usb/usb_drive.c ${CMAKE_BINARY_DIR}/drive_files.c)
target_include_directories(smartmedia_emu PRIVATE src/usb src)
pico_generate_pio_header(smartmedia_emu ${CMAKE_CURRENT_LIST_DIR}/src/sm_bus.pio)
target_link_libraries(smartmedia_emu pico_stdlib pico_sha256 pico_multicore hardware_adc hardware_flash hardware_pio hardware_dma
    pico_unique_id tinyusb_device tinyusb_board pico_usb_reset)
# A slow or absent terminal must not hold up the flash jobs for long. The application
# provides the USB descriptors, so stdio_usb is told to keep running TinyUSB in the
# background and the reset interface (picotool, 1200 baud) is kept.
target_compile_definitions(smartmedia_emu PRIVATE
    SMARTMARE_FW_VERSION="${PROJECT_VERSION}"
    PICO_STDIO_USB_STDOUT_TIMEOUT_US=2000
    PICO_STDIO_USB_ENABLE_IRQ_BACKGROUND_TASK=1
    PICO_STDIO_USB_ENABLE_TINYUSB_INIT=1
    PICO_ENABLE_USB_RESET_VIA_VENDOR_INTERFACE=1
    PICO_ENABLE_USB_RESET_VIA_BAUD_RATE=1
    PICO_USB_RESET_SUPPORT_MS_OS_20_DESCRIPTOR=1
    PICO_USB_RESET_MS_OS_20_DESCRIPTOR_ITF=2
    PICO_USB_RESET_INCLUDE_DEFAULT_APP_DRIVER_CB=1)
set_target_properties(smartmedia_emu PROPERTIES OUTPUT_NAME smartmare-5v-sp-202-firmware-v${PROJECT_VERSION})
pico_set_binary_type(smartmedia_emu copy_to_ram)
pico_enable_stdio_usb(smartmedia_emu 1)
pico_enable_stdio_uart(smartmedia_emu 0)
pico_add_extra_outputs(smartmedia_emu)

# The generic card: the same 4 MB 5 V SmartMedia emulation for any instrument, with the
# serial port (image dump / write / erase), the reset interface and a drive with the Card
# Tools page (app/generic_loader.html), without the SP-202 Card Manager, sample sets and pad table.
set(GENERIC_FILES ${CMAKE_CURRENT_LIST_DIR}/app/generic_loader.html ${CMAKE_CURRENT_LIST_DIR}/app/style.css
    ${CMAKE_CURRENT_LIST_DIR}/app/js/card.js ${CMAKE_CURRENT_LIST_DIR}/app/js/serial.js
    ${CMAKE_CURRENT_LIST_DIR}/app/js/segments.js ${CMAKE_CURRENT_LIST_DIR}/app/js/firmware.js ${CMAKE_CURRENT_LIST_DIR}/app/js/update.js
    ${CMAKE_CURRENT_LIST_DIR}/app/js/generic.js)
add_custom_command(
    OUTPUT ${CMAKE_BINARY_DIR}/drive_files_generic.c ${CMAKE_BINARY_DIR}/smartmare-generic-card-manager-v${PROJECT_VERSION}.html
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_LIST_DIR}/tools/build_drive.py ${CMAKE_BINARY_DIR}/drive_files_generic.c
            --generic --html ${CMAKE_BINARY_DIR}/smartmare-generic-card-manager-v${PROJECT_VERSION}.html
    DEPENDS ${GENERIC_FILES} ${CMAKE_CURRENT_LIST_DIR}/tools/build_drive.py
    COMMENT "Building the Generic Card Manager USB drive")
add_executable(smartmedia_generic
    src/main.c src/card_if.c src/sm_core.c src/sm_flash_storage.c src/sm_bus.c
    src/crc32.c src/fw_update.c src/usb/usb_descriptors.c src/usb/usb_drive.c ${CMAKE_BINARY_DIR}/drive_files_generic.c)
target_include_directories(smartmedia_generic PRIVATE src/usb src)
pico_generate_pio_header(smartmedia_generic ${CMAKE_CURRENT_LIST_DIR}/src/sm_bus.pio)
target_link_libraries(smartmedia_generic pico_stdlib pico_sha256 pico_multicore hardware_adc hardware_flash hardware_pio hardware_dma
    pico_unique_id tinyusb_device tinyusb_board pico_usb_reset)
target_compile_definitions(smartmedia_generic PRIVATE
    SMARTMARE_GENERIC=1
    SMARTMARE_FW_VERSION="${PROJECT_VERSION}"
    PICO_STDIO_USB_STDOUT_TIMEOUT_US=2000
    PICO_STDIO_USB_ENABLE_IRQ_BACKGROUND_TASK=1
    PICO_STDIO_USB_ENABLE_TINYUSB_INIT=1
    PICO_ENABLE_USB_RESET_VIA_VENDOR_INTERFACE=1
    PICO_ENABLE_USB_RESET_VIA_BAUD_RATE=1
    PICO_USB_RESET_SUPPORT_MS_OS_20_DESCRIPTOR=1
    PICO_USB_RESET_MS_OS_20_DESCRIPTOR_ITF=2
    PICO_USB_RESET_INCLUDE_DEFAULT_APP_DRIVER_CB=1)
set_target_properties(smartmedia_generic PROPERTIES OUTPUT_NAME smartmare-5v-generic-firmware-v${PROJECT_VERSION})
pico_set_binary_type(smartmedia_generic copy_to_ram)
pico_enable_stdio_usb(smartmedia_generic 1)
pico_enable_stdio_uart(smartmedia_generic 0)
pico_add_extra_outputs(smartmedia_generic)
