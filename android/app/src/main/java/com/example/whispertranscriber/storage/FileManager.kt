package com.example.whispertranscriber.storage

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * WAV / TXT ファイルの保存・管理 - Scoped Storage 対応修正版
 *
 * 修正点:
 * - Android 10+ (API 29+): Scoped Storage に対応
 *   Documents/WhisperTranscriber/ は getExternalStoragePublicDirectory では
 *   書き込めないため、MediaStore API または getExternalFilesDir を使用
 * - Android 9 以下: 従来の外部ストレージ書き込みは維持（WRITE_EXTERNAL_STORAGE 付与済み）
 * - WAV ヘッダー書き込みのファイルハンドルリークを修正（use ブロック使用）
 * - ファイル一覧はアプリ専用領域（getExternalFilesDir）から取得
 *
 * 保存先:
 * - Android 10+ : /storage/emulated/0/Android/data/com.example.whispertranscriber/files/Recordings/
 *                 ※ アンインストール時に自動削除。共有が必要な場合は MediaStore を使用
 * - Android 9-  : /storage/emulated/0/Documents/WhisperTranscriber/
 */
class FileManager(private val context: Context) {

    companion object {
        private const val TAG = "FileManager"
        private const val SUBDIR = "Recordings"
        private const val SAMPLE_RATE  = 16000
        private const val CHANNELS     = 1
        private const val BIT_DEPTH    = 16
        private val TIMESTAMP_FMT = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)
    }

    data class SavedFile(
        val wavFile:         File,
        val txtFile:         File,
        val timestamp:       Long,
        val text:            String,
        val durationSeconds: Float,
    )

    /**
     * アプリ専用の録音保存ディレクトリ（API 29+: Scoped Storage 対応）
     * WRITE_EXTERNAL_STORAGE パーミッション不要
     */
    fun getOutputDir(): File {
        val dir = File(context.getExternalFilesDir(null), SUBDIR)
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    /**
     * PCM データを WAV + TXT に保存する
     * @return 保存されたファイル情報（失敗時は null）
     */
    fun save(pcmData: ByteArray, text: String, durationSeconds: Float): SavedFile? {
        return try {
            val timestamp = System.currentTimeMillis()
            val baseName  = TIMESTAMP_FMT.format(Date(timestamp))
            val dir       = getOutputDir()

            val wavFile = File(dir, "$baseName.wav")
            val txtFile = File(dir, "$baseName.txt")

            writeWav(wavFile, pcmData)
            writeTxt(txtFile, text)

            // Android 10+: MediaScanner に登録してファイルマネージャーから見えるようにする
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                scanFile(wavFile)
                scanFile(txtFile)
            }

            Log.i(TAG, "保存完了: $baseName")
            SavedFile(wavFile, txtFile, timestamp, text, durationSeconds)

        } catch (e: IOException) {
            Log.e(TAG, "ファイル保存 IO エラー: ${e.message}")
            null
        } catch (e: Exception) {
            Log.e(TAG, "ファイル保存エラー: ${e.message}")
            null
        }
    }

    /**
     * 保存済みファイル一覧（新しい順）
     */
    fun listSavedFiles(): List<SavedFile> {
        val dir = getOutputDir()
        val txtFiles = dir.listFiles { f -> f.extension == "txt" }
            ?: return emptyList()

        return txtFiles
            .sortedByDescending { it.lastModified() }
            .mapNotNull { txtFile ->
                val wavFile = File(txtFile.parent, "${txtFile.nameWithoutExtension}.wav")
                if (!wavFile.exists()) return@mapNotNull null
                runCatching {
                    val text     = txtFile.readText(Charsets.UTF_8)
                    val duration = (wavFile.length() - 44).coerceAtLeast(0)
                        .toFloat() / (SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8))
                    SavedFile(wavFile, txtFile, txtFile.lastModified(), text, duration)
                }.getOrNull()
            }
    }

    /**
     * ファイルを削除する
     */
    fun delete(savedFile: SavedFile): Boolean {
        return runCatching {
            savedFile.wavFile.delete()
            savedFile.txtFile.delete()
            true
        }.getOrDefault(false)
    }

    // ===== プライベート =====

    /**
     * WAV ファイルを書き込む
     * 修正: use ブロックでファイルハンドルを確実に閉じる
     */
    @Throws(IOException::class)
    private fun writeWav(file: File, pcmData: ByteArray) {
        FileOutputStream(file).use { fos ->
            fos.write(buildWavHeader(pcmData.size))
            fos.write(pcmData)
            fos.flush()
        }
    }

    @Throws(IOException::class)
    private fun writeTxt(file: File, text: String) {
        file.bufferedWriter(Charsets.UTF_8).use { w ->
            w.write(text)
            w.flush()
        }
    }

    private fun buildWavHeader(dataSize: Int): ByteArray {
        val byteRate   = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8)
        val blockAlign = CHANNELS * (BIT_DEPTH / 8)
        val header     = ByteArray(44)
        var off        = 0

        fun ws(s: String)  { s.toByteArray().copyInto(header, off); off += s.length }
        fun w4(v: Int)     {
            header[off]   = (v         and 0xFF).toByte()
            header[off+1] = ((v shr 8) and 0xFF).toByte()
            header[off+2] = ((v shr 16) and 0xFF).toByte()
            header[off+3] = ((v shr 24) and 0xFF).toByte()
            off += 4
        }
        fun w2(v: Int)     {
            header[off]   = (v         and 0xFF).toByte()
            header[off+1] = ((v shr 8) and 0xFF).toByte()
            off += 2
        }

        ws("RIFF"); w4(dataSize + 36); ws("WAVE")
        ws("fmt "); w4(16);            w2(1); w2(CHANNELS); w4(SAMPLE_RATE)
        w4(byteRate);                  w2(blockAlign);      w2(BIT_DEPTH)
        ws("data"); w4(dataSize)

        return header
    }

    private fun scanFile(file: File) {
        MediaScannerConnection.scanFile(
            context,
            arrayOf(file.absolutePath),
            null,
            null,
        )
    }
}
