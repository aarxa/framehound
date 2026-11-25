# framehound's native side: the Vulkan layer that breaks draw calls, and a small scene to test it on.
#
#   cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
#   FRAMEHOUND_OUT=data/native-scene VK_ADD_LAYER_PATH=native/build VK_INSTANCE_LAYERS=VK_LAYER_FRAMEHOUND_glitch \
#     native/build/fh_scene --frames 300
cmake_minimum_required(VERSION 3.20)
project(framehound_native CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Vulkan REQUIRED)
find_package(ZLIB REQUIRED)
find_program(GLSLANG glslangValidator REQUIRED)
find_package(Python3 REQUIRED COMPONENTS Interpreter)

# the layer's command wrappers come from the Vulkan registry that matches the installed headers
find_file(VK_XML vk.xml PATHS ${Vulkan_INCLUDE_DIRS}/../share/vulkan/registry /opt/homebrew/share/vulkan/registry REQUIRED NO_DEFAULT_PATH)
add_custom_command(
  OUTPUT ${CMAKE_CURRENT_SOURCE_DIR}/layer/commands.inc
  COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/layer/gen_commands.py ${VK_XML} ${CMAKE_CURRENT_SOURCE_DIR}/layer/commands.inc
  DEPENDS layer/gen_commands.py ${VK_XML})
add_library(VkLayer_framehound MODULE layer/layer.cpp layer/commands.inc)
set_target_properties(VkLayer_framehound PROPERTIES CXX_VISIBILITY_PRESET hidden)
if(NOT WIN32)
  set_target_properties(VkLayer_framehound PROPERTIES PREFIX "lib")
endif()
target_include_directories(VkLayer_framehound PRIVATE ${Vulkan_INCLUDE_DIRS})
target_link_libraries(VkLayer_framehound PRIVATE ZLIB::ZLIB)
if(UNIX AND NOT APPLE)
  # bind the layer's own references to its own functions, not to the loader's functions of the same names
  target_link_options(VkLayer_framehound PRIVATE -Wl,-Bsymbolic)
endif()
# the manifest the loader reads, naming the library as this platform builds it (.dylib, .so or .dll), next to it
file(READ layer/VkLayer_framehound.json.in MANIFEST)
string(REPLACE "LIBRARY" "./$<TARGET_FILE_NAME:VkLayer_framehound>" MANIFEST "${MANIFEST}")
file(GENERATE OUTPUT $<TARGET_FILE_DIR:VkLayer_framehound>/VkLayer_framehound.json CONTENT "${MANIFEST}")

# the test scene
foreach(stage vert frag)
  add_custom_command(
    OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/scene.${stage}.spv
    COMMAND ${GLSLANG} -V ${CMAKE_CURRENT_SOURCE_DIR}/testapp/scene.${stage} -o ${CMAKE_CURRENT_BINARY_DIR}/scene.${stage}.spv
    DEPENDS testapp/scene.${stage})
  list(APPEND SPIRV ${CMAKE_CURRENT_BINARY_DIR}/scene.${stage}.spv)
endforeach()
add_executable(fh_scene testapp/scene.cpp ${SPIRV})
target_compile_definitions(fh_scene PRIVATE SHADER_DIR="${CMAKE_CURRENT_BINARY_DIR}" _USE_MATH_DEFINES)
target_link_libraries(fh_scene PRIVATE Vulkan::Vulkan)
