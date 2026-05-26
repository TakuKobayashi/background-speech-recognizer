package com.example.whispertranscriber

import android.app.Application
import android.util.Log

/**
 * Application クラス - 新規
 *
 * - グローバル未処理例外ハンドラ（JNI クラッシュの詳細ログ）
 * - onTrimMemory でメモリ不足時の GC 要求
 */
class WhisperApplication : Application() {

    companion object {
        private const val TAG = "WhisperApp"
    }

    override fun onCreate() {
        super.onCreate()

        // グローバル未処理例外ハンドラ（JNI クラッシュの詳細をキャプチャ）
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            Log.e(TAG, "未処理例外 thread=${thread.name}: ${throwable.message}", throwable)
            // Caused by が UnsatisfiedLinkError → JNI ロード失敗
            // Caused by が SIGSEGV → JNI 内部 crash（ggml segfault など）
            defaultHandler?.uncaughtException(thread, throwable)
        }

        Log.i(TAG, "WhisperApplication 起動")
    }

    /**
     * システムのメモリ不足時に呼ばれる
     * onTrimMemory で不要なキャッシュを解放する
     */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        when (level) {
            TRIM_MEMORY_RUNNING_CRITICAL,
            TRIM_MEMORY_COMPLETE -> {
                Log.w(TAG, "onTrimMemory CRITICAL (level=$level) — GC 要求")
                System.gc()
            }
            TRIM_MEMORY_RUNNING_LOW -> {
                Log.w(TAG, "onTrimMemory LOW (level=$level)")
            }
        }
    }
}
