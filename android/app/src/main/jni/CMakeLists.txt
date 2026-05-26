cmake_minimum_required(VERSION 3.22.1)
project(whispertranscriber CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ===================================================================
# whisper.cpp ソースの場所
# app/src/main/jni/whisper.cpp/ にクローンしてください:
#   cd app/src/main/jni
#   git clone https://github.com/ggerganov/whisper.cpp.git
# ===================================================================
set(WHISPER_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/whisper.cpp")

if(NOT EXISTS "${WHISPER_CPP_DIR}/include/whisper.h")
    # 旧パス (src/whisper.h) も確認
    if(EXISTS "${WHISPER_CPP_DIR}/whisper.h")
        set(WHISPER_HEADER_DIR "${WHISPER_CPP_DIR}")
    else()
        message(FATAL_ERROR
            "whisper.cpp が見つかりません。\n"
            "次を実行してください:\n"
            "  cd app/src/main/jni\n"
            "  git clone https://github.com/ggerganov/whisper.cpp.git\n"
        )
    endif()
else()
    set(WHISPER_HEADER_DIR "${WHISPER_CPP_DIR}/include")
endif()

# ggml ソースファイル（バージョン差異を吸収）
set(GGML_SRC_DIR "${WHISPER_CPP_DIR}/ggml/src")
set(GGML_INC_DIR "${WHISPER_CPP_DIR}/ggml/include")

if(NOT EXISTS "${GGML_SRC_DIR}")
    # 旧ディレクトリ構造への対応
    set(GGML_SRC_DIR "${WHISPER_CPP_DIR}/src")
    set(GGML_INC_DIR "${WHISPER_CPP_DIR}")
endif()

# ggml コアファイルを収集
file(GLOB GGML_SOURCES
    "${GGML_SRC_DIR}/ggml.c"
    "${GGML_SRC_DIR}/ggml-alloc.c"
    "${GGML_SRC_DIR}/ggml-backend.cpp"
    "${GGML_SRC_DIR}/ggml-quants.c"
    "${GGML_SRC_DIR}/ggml-threading.cpp"
    "${GGML_SRC_DIR}/ggml-cpu/*.c"
    "${GGML_SRC_DIR}/ggml-cpu/*.cpp"
)

# fallback: 旧構造
if(NOT GGML_SOURCES)
    file(GLOB GGML_SOURCES
        "${GGML_SRC_DIR}/ggml*.c"
        "${GGML_SRC_DIR}/ggml*.cpp"
    )
endif()

add_library(ggml STATIC ${GGML_SOURCES})
target_include_directories(ggml PUBLIC ${GGML_INC_DIR} ${GGML_SRC_DIR})
target_compile_options(ggml PRIVATE -O2 -ffast-math)

# whisper ライブラリ
set(WHISPER_SRC "${WHISPER_CPP_DIR}/src/whisper.cpp")
if(NOT EXISTS "${WHISPER_SRC}")
    set(WHISPER_SRC "${WHISPER_CPP_DIR}/whisper.cpp")
endif()

add_library(whisper STATIC "${WHISPER_SRC}")
target_include_directories(whisper PUBLIC
    ${WHISPER_HEADER_DIR}
    ${GGML_INC_DIR}
)
target_link_libraries(whisper PUBLIC ggml)
target_compile_options(whisper PRIVATE -O2)

# JNI ブリッジ
add_library(whisper-jni SHARED whisper_jni.cpp)
target_include_directories(whisper-jni PRIVATE
    ${WHISPER_HEADER_DIR}
    ${GGML_INC_DIR}
)
target_link_libraries(whisper-jni
    PRIVATE
    whisper
    ggml
    android
    log
)
target_compile_options(whisper-jni PRIVATE -O2 -fstack-protector-strong)
