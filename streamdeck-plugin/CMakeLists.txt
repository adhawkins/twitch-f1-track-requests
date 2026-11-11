find_program(NPM_EXECUTABLE npm REQUIRED)

set(PLUGIN_BUILD_VERSION "20")
if(NOT PLUGIN_BUILD_VERSION MATCHES "^[0-9]+$")
    message(FATAL_ERROR "PLUGIN_BUILD_VERSION must be a non-negative integer")
endif()

set(PLUGIN_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
set(PLUGIN_BUILD_DIR "${CMAKE_CURRENT_BINARY_DIR}")
set(PLUGIN_STAGE_DIR "${PLUGIN_BUILD_DIR}/package")
set(PLUGIN_DIRECTORY "com.gently.f1-track-requests.sdPlugin")
set(PLUGIN_SOURCE_MANIFEST "${PLUGIN_SOURCE_DIR}/${PLUGIN_DIRECTORY}/manifest.json")
set(PLUGIN_VERSIONED_MANIFEST
    "${PLUGIN_BUILD_DIR}/generated/${PLUGIN_DIRECTORY}/manifest.json"
)
set(PLUGIN_INSTALLER "${PLUGIN_BUILD_DIR}/com.gently.f1-track-requests.streamDeckPlugin")

file(READ "${PLUGIN_SOURCE_MANIFEST}" PLUGIN_MANIFEST_CONTENT)
string(JSON PLUGIN_MANIFEST_CONTENT SET "${PLUGIN_MANIFEST_CONTENT}" Version
    "\"${PROJECT_VERSION}.${PLUGIN_BUILD_VERSION}\""
)
if(NOT EXISTS "${PLUGIN_VERSIONED_MANIFEST}")
    file(MAKE_DIRECTORY "${PLUGIN_BUILD_DIR}/generated/${PLUGIN_DIRECTORY}")
    file(WRITE "${PLUGIN_VERSIONED_MANIFEST}" "${PLUGIN_MANIFEST_CONTENT}\n")
else()
    file(READ "${PLUGIN_VERSIONED_MANIFEST}" PLUGIN_PREVIOUS_MANIFEST)
    if(NOT PLUGIN_PREVIOUS_MANIFEST STREQUAL "${PLUGIN_MANIFEST_CONTENT}\n")
        file(WRITE "${PLUGIN_VERSIONED_MANIFEST}" "${PLUGIN_MANIFEST_CONTENT}\n")
    endif()
endif()

file(GLOB_RECURSE PLUGIN_ASSETS CONFIGURE_DEPENDS
    "${PLUGIN_SOURCE_DIR}/${PLUGIN_DIRECTORY}/imgs/*.svg"
    "${PLUGIN_SOURCE_DIR}/${PLUGIN_DIRECTORY}/ui/*"
)
set(PLUGIN_INPUTS
    "${PLUGIN_SOURCE_DIR}/build.mjs"
    "${PLUGIN_SOURCE_DIR}/package-lock.json"
    "${PLUGIN_SOURCE_DIR}/package.json"
    "${PLUGIN_SOURCE_DIR}/scripts/generate-plugin-icons.mjs"
    "${PLUGIN_SOURCE_DIR}/src/plugin.ts"
    "${PLUGIN_SOURCE_DIR}/tsconfig.json"
    "${PLUGIN_SOURCE_MANIFEST}"
    ${PLUGIN_ASSETS}
)

add_custom_command(
    OUTPUT "${PLUGIN_INSTALLER}"
    COMMAND "${NPM_EXECUTABLE}" ci
    COMMAND "${NPM_EXECUTABLE}" run build
    COMMAND "${CMAKE_COMMAND}" -E rm -rf "${PLUGIN_STAGE_DIR}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${PLUGIN_STAGE_DIR}"
    COMMAND "${CMAKE_COMMAND}" -E copy_directory
        "${PLUGIN_SOURCE_DIR}/${PLUGIN_DIRECTORY}"
        "${PLUGIN_STAGE_DIR}/${PLUGIN_DIRECTORY}"
    COMMAND "${CMAKE_COMMAND}" -E copy
        "${PLUGIN_VERSIONED_MANIFEST}"
        "${PLUGIN_STAGE_DIR}/${PLUGIN_DIRECTORY}/manifest.json"
    COMMAND "${NPM_EXECUTABLE}" exec -- streamdeck validate --no-update-check
        "${PLUGIN_STAGE_DIR}/${PLUGIN_DIRECTORY}"
    COMMAND "${NPM_EXECUTABLE}" exec -- streamdeck pack --force --no-update-check
        --version "${PROJECT_VERSION}.${PLUGIN_BUILD_VERSION}"
        --output "${PLUGIN_BUILD_DIR}"
        "${PLUGIN_STAGE_DIR}/${PLUGIN_DIRECTORY}"
    DEPENDS
        ${PLUGIN_INPUTS}
        "${PLUGIN_VERSIONED_MANIFEST}"
        "${CMAKE_CURRENT_SOURCE_DIR}/CMakeLists.txt"
    WORKING_DIRECTORY "${PLUGIN_SOURCE_DIR}"
    COMMENT "Building and packaging the Stream Deck plugin installer"
    VERBATIM
)
add_custom_target(streamdeck-plugin ALL DEPENDS "${PLUGIN_INSTALLER}")

install(FILES "${PLUGIN_INSTALLER}" DESTINATION .)
