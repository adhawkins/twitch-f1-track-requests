find_program(NPM_EXECUTABLE npm REQUIRED)

set(SERVER_BUILD_DIR "${CMAKE_CURRENT_BINARY_DIR}")
set(SERVER_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/app.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/config.json-example"
    "${CMAKE_CURRENT_SOURCE_DIR}/dock.css"
    "${CMAKE_CURRENT_SOURCE_DIR}/dock.html"
    "${CMAKE_CURRENT_SOURCE_DIR}/dock.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/f1-track-requests.env-example"
    "${CMAKE_CURRENT_SOURCE_DIR}/f1-track-requests.service"
    "${CMAKE_CURRENT_SOURCE_DIR}/index.html"
    "${CMAKE_CURRENT_SOURCE_DIR}/package-lock.json"
    "${CMAKE_CURRENT_SOURCE_DIR}/package.json"
    "${CMAKE_CURRENT_SOURCE_DIR}/server.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/styles.css"
    "${PROJECT_SOURCE_DIR}/README.md"
)

set(SERVER_STAMP "${SERVER_BUILD_DIR}/.built")
add_custom_command(
    OUTPUT "${SERVER_STAMP}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${SERVER_BUILD_DIR}"
    COMMAND "${CMAKE_COMMAND}" -E copy ${SERVER_FILES} "${SERVER_BUILD_DIR}"
    COMMAND "${NPM_EXECUTABLE}" ci --omit=dev --prefix "${SERVER_BUILD_DIR}"
    COMMAND "${CMAKE_COMMAND}" -E touch "${SERVER_STAMP}"
    DEPENDS ${SERVER_FILES}
    COMMENT "Staging the server and installing production dependencies"
    VERBATIM
)
add_custom_target(server ALL DEPENDS "${SERVER_STAMP}")

install(FILES ${SERVER_FILES} DESTINATION server)
install(DIRECTORY "${SERVER_BUILD_DIR}/node_modules" DESTINATION server)
