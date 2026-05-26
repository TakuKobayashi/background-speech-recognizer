#include <jni.h>
#include <string>
#include <vector>
#include <mutex>
#include <cstring>
#include <android/log.h>

// whisper.h のパスをビルド時に解決
#if __has_include("whisper.cpp/include/whisper.h")
  #include "whisper.cpp/include/whisper.h"
#elif __has_include("whisper.cpp/whisper.h")
  #include "whisper.cpp/whisper.h"
#else
  #error "whisper.h が見つかりません。CMakeLists.txt のパスを確認してください。"
#endif

#define TAG "WhisperJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

// ===================================================================
// コンテキストへのアクセスをシリアライズするミューテックス
// 複数スレッドから同時呼び出しを防ぐ
// ===================================================================
static std::mutex g_inference_mutex;

// 最小サンプル数（0.5 秒 @ 16kHz）
static constexpr int MIN_SAMPLES = 8000;
// 最大サンプル数（60 秒 @ 16kHz、これ以上は segfault リスク）
static constexpr int MAX_SAMPLES = 16000 * 60;

// ===================================================================
// ヘルパー
// ===================================================================
static std::string jstring_to_str(JNIEnv* env, jstring jstr) {
    if (!jstr) return "";
    const char* chars = env->GetStringUTFChars(jstr, nullptr);
    if (!chars) return "";
    std::string result(chars);
    env->ReleaseStringUTFChars(jstr, chars);
    return result;
}

// ===================================================================
// JNI エクスポート
// ===================================================================
extern "C" {

/**
 * モデルを読み込みコンテキストポインタを返す
 * 失敗時は 0 を返す（例外は投げない）
 */
JNIEXPORT jlong JNICALL
Java_com_example_whispertranscriber_whisper_WhisperEngine_nativeInitContext(
        JNIEnv* env, jobject /* this */, jstring modelPath) {

    if (!modelPath) {
        LOGE("modelPath が null");
        return 0L;
    }

    const std::string path = jstring_to_str(env, modelPath);
    if (path.empty()) {
        LOGE("modelPath が空文字列");
        return 0L;
    }

    LOGI("モデル読み込み開始: %s", path.c_str());

    whisper_context_params params = whisper_context_default_params();
    params.use_gpu = false;  // Android GPU 推論は不安定なため CPU のみ

    whisper_context* ctx = nullptr;
    try {
        ctx = whisper_init_from_file_with_params(path.c_str(), params);
    } catch (const std::exception& e) {
        LOGE("whisper_init 例外: %s", e.what());
        return 0L;
    } catch (...) {
        LOGE("whisper_init 未知の例外");
        return 0L;
    }

    if (!ctx) {
        LOGE("モデル読み込み失敗: %s", path.c_str());
        return 0L;
    }

    LOGI("モデル読み込み完了 ctx=%p", static_cast<void*>(ctx));
    return reinterpret_cast<jlong>(ctx);
}

/**
 * コンテキストを解放する
 */
JNIEXPORT void JNICALL
Java_com_example_whispertranscriber_whisper_WhisperEngine_nativeFreeContext(
        JNIEnv* /* env */, jobject /* this */, jlong contextPtr) {

    if (contextPtr == 0L) return;

    // 推論中でないことを確認してから解放
    std::lock_guard<std::mutex> lock(g_inference_mutex);

    auto* ctx = reinterpret_cast<whisper_context*>(contextPtr);
    LOGI("コンテキスト解放: %p", static_cast<void*>(ctx));

    try {
        whisper_free(ctx);
    } catch (...) {
        LOGE("whisper_free で例外が発生しました");
    }
}

/**
 * 音声データを文字起こしする
 *
 * @param contextPtr  初期化済みコンテキストポインタ
 * @param audioData   16kHz・モノラル・float32 PCM（-1.0〜1.0）
 * @param language    言語コード（"ja", "en", "auto"）
 * @param nThreads    推論スレッド数
 * @return            文字起こし結果テキスト（失敗時は空文字列、例外は投げない）
 */
JNIEXPORT jstring JNICALL
Java_com_example_whispertranscriber_whisper_WhisperEngine_nativeTranscribe(
        JNIEnv* env, jobject /* this */,
        jlong   contextPtr,
        jfloatArray audioData,
        jstring language,
        jint    nThreads) {

    // ===== 入力検証 =====
    if (contextPtr == 0L) {
        LOGE("コンテキスト未初期化");
        return env->NewStringUTF("");
    }
    if (!audioData) {
        LOGE("audioData が null");
        return env->NewStringUTF("");
    }

    const jsize numSamples = env->GetArrayLength(audioData);
    if (numSamples < MIN_SAMPLES) {
        LOGW("サンプル数不足: %d (最小 %d)", numSamples, MIN_SAMPLES);
        return env->NewStringUTF("");
    }
    if (numSamples > MAX_SAMPLES) {
        LOGW("サンプル数超過: %d → %d にクリップ", numSamples, MAX_SAMPLES);
    }

    const int actualSamples = (numSamples > MAX_SAMPLES) ? MAX_SAMPLES : static_cast<int>(numSamples);

    // ===== float[] を取得 =====
    jfloat* samples = env->GetFloatArrayElements(audioData, nullptr);
    if (!samples) {
        LOGE("GetFloatArrayElements 失敗");
        return env->NewStringUTF("");
    }

    std::string result_text;

    {
        // ===== 推論をシリアライズ =====
        std::lock_guard<std::mutex> lock(g_inference_mutex);

        auto* ctx = reinterpret_cast<whisper_context*>(contextPtr);

        whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

        const std::string lang = jstring_to_str(env, language);
        params.language          = lang.empty() ? "ja" : lang.c_str();
        params.translate         = false;
        params.n_threads         = static_cast<int>(nThreads);
        params.print_special     = false;
        params.print_progress    = false;
        params.print_realtime    = false;
        params.print_timestamps  = false;
        params.single_segment    = false;
        params.no_context        = true;
        // タイムスタンプトークンの出力を抑制してテキスト品質を上げる
        params.token_timestamps  = false;

        int ret = -1;
        try {
            ret = whisper_full(ctx, params, samples, actualSamples);
        } catch (const std::exception& e) {
            LOGE("whisper_full 例外: %s", e.what());
        } catch (...) {
            LOGE("whisper_full 未知の例外");
        }

        // float[] を早めに解放（推論後は不要）
        env->ReleaseFloatArrayElements(audioData, samples, JNI_ABORT);
        samples = nullptr;

        if (ret != 0) {
            LOGE("whisper_full 失敗: ret=%d", ret);
            return env->NewStringUTF("");
        }

        // ===== セグメント結合 =====
        const int nSegments = whisper_full_n_segments(ctx);
        result_text.reserve(nSegments * 64);

        for (int i = 0; i < nSegments; ++i) {
            const char* seg = whisper_full_get_segment_text(ctx, i);
            if (seg && std::strlen(seg) > 0) {
                result_text += seg;
            }
        }
    }

    LOGI("文字起こし完了: %zu 文字", result_text.size());
    return env->NewStringUTF(result_text.c_str());
}

/**
 * システム情報（デバッグ用）
 */
JNIEXPORT jstring JNICALL
Java_com_example_whispertranscriber_whisper_WhisperEngine_nativeSystemInfo(
        JNIEnv* env, jobject /* this */) {
    const char* info = whisper_print_system_info();
    return env->NewStringUTF(info ? info : "unknown");
}

} // extern "C"
