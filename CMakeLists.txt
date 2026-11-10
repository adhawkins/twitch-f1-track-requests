cmake_minimum_required(VERSION 3.20)

project(f1-track-requests VERSION 1.0.0 LANGUAGES NONE)

add_subdirectory(server)
add_subdirectory(streamdeck-plugin)

set(CPACK_GENERATOR "TGZ")
set(CPACK_PACKAGE_NAME "f1-track-requests")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_PACKAGE_FILE_NAME "${CPACK_PACKAGE_NAME}-${CPACK_PACKAGE_VERSION}")
include(CPack)
