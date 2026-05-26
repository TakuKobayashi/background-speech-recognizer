package com.example.whispertranscriber.whisper

import android.content.Context
import android.os.Environment
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream

object ModelDownloader {
    private const val TAG = "ModelDownloader"
    const val MODEL_FILENAME = "ggml-base.bin"

    sealed class ModelResult {
        data class Found(val file: File) : ModelResult()
        data class Error(val message: String) : ModelResult()
    }

    suspend fun findOrCopyModel(context: Context): ModelResult = withContext(Dispatchers.IO) {
        val cached = File(context.filesDir, MODEL_FILENAME)
        if (cached.exists() && cached.length() > 1_000_000L) {
            return@withContext ModelResult.Found(cached)
        }
        val fromAssets = copyFromAssets(context, cached)
        if (fromAssets != null) return@withContext ModelResult.Found(fromAssets)

        ModelResult.Error(
            "モデルが見つかりません。\n" +
            "app/src/main/assets/$MODEL_FILENAME を配置してください。"
        )
    }

    fun formatModelSize(file: File): String = "%.1f MB".format(file.length() / 1024.0 / 1024.0)

    private fun copyFromAssets(context: Context, dest: File): File? {
        return try {
            context.assets.open(MODEL_FILENAME).use { input ->
                FileOutputStream(dest).use { output ->
                    val buf = ByteArray(1024 * 1024)
                    var read: Int
                    while (input.read(buf).also { read = it } != -1) output.write(buf, 0, read)
                    output.flush()
                }
            }
            Log.i(TAG, "assets からコピー完了: ${dest.absolutePath}")
            dest
        } catch (e: Exception) {
            Log.d(TAG, "assets にモデルなし: ${e.message}")
            if (dest.exists() && dest.length() == 0L) dest.delete()
            null
        }
    }
}
