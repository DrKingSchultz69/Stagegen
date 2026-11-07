cmake_minimum_required(VERSION 3.24)
project(stagegen_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
set(FETCHCONTENT_QUIET OFF)

# Header-only dependencies. SOURCE_SUBDIR points at a folder without a
# CMakeLists.txt so MakeAvailable only downloads them (no add_subdirectory).
FetchContent_Declare(asio
  GIT_REPOSITORY https://github.com/chriskohlhoff/asio.git
  GIT_TAG asio-1-30-2
  GIT_SHALLOW TRUE
  SOURCE_SUBDIR _headers_only)
FetchContent_Declare(crow
  GIT_REPOSITORY https://github.com/CrowCpp/Crow.git
  GIT_TAG v1.2.0
  GIT_SHALLOW TRUE
  SOURCE_SUBDIR _headers_only)
FetchContent_Declare(httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG v0.18.3
  GIT_SHALLOW TRUE
  SOURCE_SUBDIR _headers_only)
FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  SOURCE_SUBDIR _headers_only)
FetchContent_MakeAvailable(asio crow httplib nlohmann_json)

add_executable(stagegen
  src/main.cpp
  src/analysis.cpp
  src/platform.cpp
  src/gateway_client.cpp
  src/store.cpp)

target_include_directories(stagegen PRIVATE
  ${asio_SOURCE_DIR}/asio/include
  ${crow_SOURCE_DIR}/include
  ${httplib_SOURCE_DIR}
  ${nlohmann_json_SOURCE_DIR}/include)

target_compile_definitions(stagegen PRIVATE
  ASIO_STANDALONE
  CROW_DISABLE_STATIC_DIR
  _WIN32_WINNT=0x0A00
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _CRT_SECURE_NO_WARNINGS)

if(MSVC)
  target_compile_options(stagegen PRIVATE /utf-8 /W3 /bigobj /EHsc /permissive-)
endif()

if(WIN32)
  target_link_libraries(stagegen PRIVATE ws2_32 mswsock crypt32 iphlpapi)
endif()
