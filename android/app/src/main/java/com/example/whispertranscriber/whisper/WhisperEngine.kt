package com.example.whispertranscriber.whisper

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max

/**
 * whisper.cpp JNI ラッパー
 *
 * 修正点:
 * - contextPtr を AtomicLong で管理（スレッドセーフ）
 * - isInitialized を AtomicBoolean で管理
 * - transcribe() は Mutex でシリアライズ（JNI 側の g_inference_mutex と二重防止）
 * - release() を synchronized で保護（二重 free 防止）
 * - MIN_SAMPLES を Kotlin 側でも検証（JNI クラッシュ前に防ぐ）
 * - assets コピー時に 1MB バッファで高速化・進捗ログ追加
 */
class WhisperEngine(private val context: Context) {

    companion object {
        private const val TAG = "WhisperEngine"
        private const val MODEL_FILENAME = "ggml-base.bin"
        const val SAMPLE_RATE     = 16000
        private const val MIN_SAMPLES     = 8000    // 0.5 秒
        private const val MAX_SAMPLES     = 16000 * 60  // 60 秒
        private val COPY_BUFFER_SIZE = 1024 * 1024  // 1MB

        init {
            try {
                System.loadLibrary("whisper-jni")
                Log.i("WhisperEngine", "whisper-jni ロード成功")
            } catch (e: UnsatisfiedLinkError) {
                Log.e("WhisperEngine", "whisper-jni ロード失敗: ${e.message}")
            }
        }
    }

    private val contextPtr   = AtomicLong(0L)
    private val initialized  = AtomicBoolean(false)
    private val inferenceMutex = Mutex()
    private val releaseLock  = Object()

    // ===== JNI 宣言 =====
    private external fun nativeInitContext(modelPath: String): Long
    private external fun nativeFreeContext(contextPtr: Long)
    private external fun nativeTranscribe(
        contextPtr: Long,
        audioData:  FloatArray,
        language:   String,
        nThreads:   Int,
    ): String
    private external fun nativeSystemInfo(): String

    // ===================================================================
    // 公開 API
    // ===================================================================

    val isReady: Boolean
        get() = initialized.get() && contextPtr.get() != 0L

    /**
     * モデルを初期化する（IO スレッドで実行）
     */
    suspend fun initialize(modelFile: File? = null): Boolean = withContext(Dispatchers.IO) {
        if (initialized.get()) return@withContext true

        val file = modelFile ?: getOrCopyModelFile()
        if (file == null || !file.exists()) {
            Log.e(TAG, "モデルファイルが見つかりません")
            return@withContext false
        }
        if (file.length() < 1_000_000L) {
            Log.e(TAG, "モデルファイルが小さすぎます (${file.length()} bytes)。破損している可能性があります")
            return@withContext false
        }

        Log.i(TAG, "モデル初期化: ${file.absolutePath} (${file.length() / 1024 / 1024} MB)")

        val ptr = try {
            nativeInitContext(file.absolutePath)
        } catch (e: Exception) {
            Log.e(TAG, "nativeInitContext 例外: ${e.message}")
            return@withContext false
        }

        if (ptr == 0L) {
            Log.e(TAG, "nativeInitContext が 0 を返しました")
            return@withContext false
        }

        contextPtr.set(ptr)
        initialized.set(true)

        try {
            Log.i(TAG, "システム情報: ${nativeSystemInfo()}")
        } catch (e: Exception) {
            Log.w(TAG, "nativeSystemInfo 取得失敗: ${e.message}")
        }

        true
    }

    /**
     * Int16LE PCM を文字起こしする（Default スレッドで推論）
     * @return 文字起こし結果（空/失敗時は null）
     */
    suspend fun transcribe(pcmBytes: ByteArray, language: String = "ja"): String? {
        if (!isReady) {
            Log.e(TAG, "未初期化 — transcribe() 呼び出し不可")
            return null
        }

        // ===== Kotlin 側でも最小サンプル検証 =====
        val numSamples = pcmBytes.size / 2
        if (numSamples < MIN_SAMPLES) {
            Log.w(TAG, "サンプル数不足: $numSamples (最小 $MIN_SAMPLES)")
            return null
        }

        val floatSamples = pcmToFloat(pcmBytes, minOf(numSamples, MAX_SAMPLES))

        val nThreads = max(1, Runtime.getRuntime().availableProcessors() / 2)

        // ===== 推論をシリアライズ（Kotlin Mutex） =====
        return inferenceMutex.withLock {
            val ptr = contextPtr.get()
            if (ptr == 0L) return@withLock null

            withContext(Dispatchers.Default) {
                val start = System.currentTimeMillis()
                val result = try {
                    nativeTranscribe(ptr, floatSamples, language, nThreads)
                } catch (e: Exception) {
                    Log.e(TAG, "nativeTranscribe 例外: ${e.message}")
                    ""
                }
                val elapsed = System.currentTimeMillis() - start
                Log.d(TAG, "推論: ${elapsed}ms, samples=${floatSamples.size}, len=${result.length}")
                result.trim().takeIf { it.isNotEmpty() }
            }
        }
    }

    /**
     * リソースを解放する（synchronized で二重 free を防止）
     */
    fun release() {
        synchronized(releaseLock) {
            val ptr = contextPtr.getAndSet(0L)
            initialized.set(false)
            if (ptr != 0L) {
                try {
                    nativeFreeContext(ptr)
                    Log.i(TAG, "WhisperEngine 解放完了")
                } catch (e: Exception) {
                    Log.e(TAG, "nativeFreeContext 例外: ${e.message}")
                }
            }
        }
    }

    // ===================================================================
    // プライベート
    // ===================================================================

    /**
     * assets からモデルを filesDir にコピーして返す。
     * filesDir のキャッシュが存在する場合はそれを返す。
     */
    private fun getOrCopyModelFile(): File? {
        val destFile = File(context.filesDir, MODEL_FILENAME)

        // キャッシュが存在して 1MB 以上なら使用
        if (destFile.exists() && destFile.length() > 1_000_000L) {
            Log.d(TAG, "キャッシュモデルを使用: ${destFile.absolutePath}")
            return destFile
        }

        // assets からコピー
        return try {
            context.assets.open(MODEL_FILENAME).use { input ->
                FileOutputStream(destFile).use { output ->
                    val buf = ByteArray(COPY_BUFFER_SIZE)
                    var totalBytes = 0L
                    var read: Int
                    while (input.read(buf).also { read = it } != -1) {
                        output.write(buf, 0, read)
                        totalBytes += read
                    }
                    output.flush()
                    Log.i(TAG, "assets → filesDir コピー完了: ${totalBytes / 1024 / 1024} MB")
                }
            }
            destFile
        } catch (e: Exception) {
            Log.e(TAG, "assets からのコピー失敗: ${e.message}")
            destFile.takeIf { it.exists() }
        }
    }

    /**
     * Int16LE PCM → Float32 に変換（-1.0f〜1.0f に正規化）
     * maxSamples でクリップして過大配列の生成を防ぐ
     */
    private fun pcmToFloat(pcmBytes: ByteArray, maxSamples: Int): FloatArray {
        val numSamples = minOf(pcmBytes.size / 2, maxSamples)
        val out = FloatArray(numSamples)
        for (i in 0 until numSamples) {
            val lo = pcmBytes[i * 2].toInt() and 0xFF
            val hi = pcmBytes[i * 2 + 1].toInt()
            val sample = ((hi shl 8) or lo).toShort()
            out[i] = sample.toFloat() / 32768.0f
        }
        return out
    }
}
