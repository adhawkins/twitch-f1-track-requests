find_program(NPM_EXECUTABLE npm REQUIRED)

set(PLUGIN_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
set(PLUGIN_BUILD_DIR "${CMAKE_CURRENT_BINARY_DIR}")
set(PLUGIN_STAGE_DIR "${PLUGIN_BUILD_DIR}/package")
set(PLUGIN_DIRECTORY "com.gently.f1-track-requests.sdPlugin")
set(PLUGIN_INSTALLER "${PLUGIN_BUILD_DIR}/com.gently.f1-track-requests.streamDeckPlugin")

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
    "${PLUGIN_SOURCE_DIR}/${PLUGIN_DIRECTORY}/manifest.json"
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
    COMMAND "${NPM_EXECUTABLE}" exec -- streamdeck validate --no-update-check
        "${PLUGIN_STAGE_DIR}/${PLUGIN_DIRECTORY}"
    COMMAND "${NPM_EXECUTABLE}" exec -- streamdeck pack --force --no-update-check
        --output "${PLUGIN_BUILD_DIR}"
        "${PLUGIN_STAGE_DIR}/${PLUGIN_DIRECTORY}"
    DEPENDS ${PLUGIN_INPUTS}
    WORKING_DIRECTORY "${PLUGIN_SOURCE_DIR}"
    COMMENT "Building and packaging the Stream Deck plugin installer"
    VERBATIM
)
add_custom_target(streamdeck-plugin ALL DEPENDS "${PLUGIN_INSTALLER}")

install(FILES "${PLUGIN_INSTALLER}" DESTINATION .)
