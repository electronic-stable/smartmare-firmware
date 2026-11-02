# Locates the Raspberry Pi Pico SDK (same behaviour as the SDK's external/pico_sdk_import.cmake).
# Either set PICO_SDK_PATH (environment or -D), or configure with -DPICO_SDK_FETCH_FROM_GIT=ON.

if (DEFINED ENV{PICO_SDK_PATH} AND (NOT PICO_SDK_PATH))
    set(PICO_SDK_PATH $ENV{PICO_SDK_PATH})
    message("Using PICO_SDK_PATH from environment ('${PICO_SDK_PATH}')")
endif ()

if (DEFINED ENV{PICO_SDK_FETCH_FROM_GIT} AND (NOT PICO_SDK_FETCH_FROM_GIT))
    set(PICO_SDK_FETCH_FROM_GIT $ENV{PICO_SDK_FETCH_FROM_GIT})
endif ()

set(PICO_SDK_FETCH_FROM_GIT_TAG "2.3.1" CACHE STRING "Pico SDK tag to fetch")
set(PICO_SDK_PATH "${PICO_SDK_PATH}" CACHE PATH "Path to the Raspberry Pi Pico SDK")
set(PICO_SDK_FETCH_FROM_GIT "${PICO_SDK_FETCH_FROM_GIT}" CACHE BOOL "Fetch the SDK from git if not found")

if (NOT PICO_SDK_PATH)
    if (PICO_SDK_FETCH_FROM_GIT)
        include(FetchContent)
        FetchContent_Declare(
            pico_sdk
            GIT_REPOSITORY https://github.com/raspberrypi/pico-sdk
            GIT_TAG ${PICO_SDK_FETCH_FROM_GIT_TAG}
            GIT_SUBMODULES_RECURSE FALSE
        )
        FetchContent_GetProperties(pico_sdk)
        if (NOT pico_sdk_POPULATED)
            message("Downloading Raspberry Pi Pico SDK ${PICO_SDK_FETCH_FROM_GIT_TAG}")
            FetchContent_Populate(pico_sdk)
        endif ()
        set(PICO_SDK_PATH ${pico_sdk_SOURCE_DIR})
    else ()
        message(FATAL_ERROR "Pico SDK not found. Set PICO_SDK_PATH, or configure with -DPICO_SDK_FETCH_FROM_GIT=ON.")
    endif ()
endif ()

get_filename_component(PICO_SDK_PATH "${PICO_SDK_PATH}" REALPATH BASE_DIR "${CMAKE_BINARY_DIR}")
if (NOT EXISTS ${PICO_SDK_PATH}/pico_sdk_init.cmake)
    message(FATAL_ERROR "'${PICO_SDK_PATH}' does not contain the Raspberry Pi Pico SDK")
endif ()

set(PICO_SDK_PATH ${PICO_SDK_PATH} CACHE PATH "Path to the Raspberry Pi Pico SDK" FORCE)
include(${PICO_SDK_PATH}/pico_sdk_init.cmake)
