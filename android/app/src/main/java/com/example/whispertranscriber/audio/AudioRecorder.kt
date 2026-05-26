package com.example.whispertranscriber.audio

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.concurrent.atomic.AtomicBoolean

/**
 * AudioRecord + VadDetector 統合録音クラス - 修正版
 *
 * 修正点:
 * - stop() で AudioRecord の状態を確認してから stop()/release() を呼ぶ
 *   （IllegalStateException 防止）
 * - ByteArrayOutputStream の代わりに ArrayList<ByteArray> を使用
 *   （大量の中間コピー GC 圧迫を解消）
 * - isRunning を AtomicBoolean で管理（スレッドセーフ）
 * - preRollBuffer を固定サイズ配列で管理（リーク防止）
 * - audioRecord への複数スレッドアクセスを synchronized で保護
 */
class AudioRecorder(
    private val sampleRate: Int = 16000,
    private val vadSensitivity: VadDetector.Sensitivity = VadDetector.Sensitivity.AGGRESSIVE,
) {
    companion object {
        private const val TAG = "AudioRecorder"
        private const val MIN_RECORDING_SEC = 1.0f
        private const val MAX_RECORDING_SEC = 60.0f
    }

    // 録音状態
    sealed class RecordingState {
        object Idle      : RecordingState()
        object Listening : RecordingState()
        object Recording : RecordingState()
        data class Error(val message: String) : RecordingState()
    }

    data class RecordingSession(
        val pcmData:         ByteArray,
        val durationSeconds: Float,
        val timestamp:       Long = System.currentTimeMillis(),
    )

    // コールバック（メインスレッドから呼ばれることを想定していない — Service 内部で使用）
    var onVoiceStart:   (() -> Unit)?                     = null
    var onVoiceEnd:     ((session: RecordingSession) -> Unit)? = null
    var onTooShort:     ((durationSeconds: Float) -> Unit)? = null
    var onLevelUpdate:  ((db: Float) -> Unit)?            = null
    var onError:        ((message: String) -> Unit)?      = null

    private val _state = MutableStateFlow<RecordingState>(RecordingState.Idle)
    val state: StateFlow<RecordingState> = _state

    private var audioRecord:     AudioRecord? = null
    private var captureThread:   Thread?      = null
    private val isRunning        = AtomicBoolean(false)
    private val audioRecordLock  = Object()
    private val vad              = VadDetector(sampleRate, vadSensitivity)

    // セッションバッファ（ByteArrayOutputStream → ArrayList に変更）
    private var sessionChunks:    ArrayList<ByteArray>? = null
    private var sessionStartTime: Long = 0L

    // プリロール（固定サイズキュー）
    private val preRollMaxFrames = 15
    private val preRollQueue     = ArrayDeque<ByteArray>(preRollMaxFrames + 1)

    @Throws(SecurityException::class)
    fun start() {
        if (!isRunning.compareAndSet(false, true)) return

        val minBufSize = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBufSize == AudioRecord.ERROR || minBufSize == AudioRecord.ERROR_BAD_VALUE) {
            val msg = "AudioRecord: getMinBufferSize 失敗 ($minBufSize)"
            Log.e(TAG, msg)
            _state.value = RecordingState.Error(msg)
            onError?.invoke(msg)
            isRunning.set(false)
            return
        }

        val bufferSize = maxOf(minBufSize * 4, vad.frameBytes * 8)

        synchronized(audioRecordLock) {
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize,
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                val msg = "AudioRecord 初期化失敗"
                Log.e(TAG, msg)
                audioRecord?.release()
                audioRecord = null
                _state.value = RecordingState.Error(msg)
                onError?.invoke(msg)
                isRunning.set(false)
                return
            }

            // 修正: startRecording() 前に状態確認
            try {
                audioRecord?.startRecording()
            } catch (e: IllegalStateException) {
                val msg = "AudioRecord.startRecording() 失敗: ${e.message}"
                Log.e(TAG, msg)
                audioRecord?.release()
                audioRecord = null
                _state.value = RecordingState.Error(msg)
                onError?.invoke(msg)
                isRunning.set(false)
                return
            }
        }

        _state.value = RecordingState.Listening
        vad.reset()

        captureThread = Thread(::captureLoop, "AudioCapture").apply {
            priority  = Thread.MAX_PRIORITY
            isDaemon  = true
            start()
        }

        Log.i(TAG, "録音監視開始")
    }

    fun stop() {
        if (!isRunning.compareAndSet(true, false)) return

        // 録音中セッションを強制終了
        finalizeSessionIfActive()

        captureThread?.join(2000)
        captureThread = null

        synchronized(audioRecordLock) {
            val ar = audioRecord
            audioRecord = null
            if (ar != null) {
                // 修正: 状態を確認してから stop() → release()
                try {
                    if (ar.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                        ar.stop()
                    }
                } catch (e: IllegalStateException) {
                    Log.w(TAG, "AudioRecord.stop() 失敗: ${e.message}")
                } finally {
                    try {
                        ar.release()
                    } catch (e: Exception) {
                        Log.w(TAG, "AudioRecord.release() 失敗: ${e.message}")
                    }
                }
            }
        }

        vad.reset()
        preRollQueue.clear()
        _state.value = RecordingState.Idle
        Log.i(TAG, "録音監視停止")
    }

    // ===== 録音ループ =====

    private fun captureLoop() {
        val readBuf = ByteArray(vad.frameBytes)

        while (isRunning.get()) {
            val read = synchronized(audioRecordLock) {
                audioRecord?.read(readBuf, 0, vad.frameBytes) ?: -1
            }
            when {
                read <= 0  -> continue
                read < vad.frameBytes -> {
                    // 半端なデータは VAD に渡さず捨てる
                    continue
                }
            }

            try {
                processFrame(readBuf.copyOf(read))
            } catch (e: Exception) {
                Log.e(TAG, "フレーム処理エラー: ${e.message}")
            }
        }
    }

    private fun processFrame(frame: ByteArray) {
        val result = vad.processFrame(frame)
        onLevelUpdate?.invoke(result.energyDb)

        // プリロール更新
        if (!result.isSpeech) {
            preRollQueue.addLast(frame.clone())
            while (preRollQueue.size > preRollMaxFrames) preRollQueue.removeFirst()
        }

        when {
            result.started -> {
                // 修正: ArrayList で chunk を管理（中間コピーなし）
                sessionChunks = ArrayList<ByteArray>().also { list ->
                    preRollQueue.forEach { list.add(it) }
                    list.add(frame.clone())
                }
                preRollQueue.clear()
                sessionStartTime = System.currentTimeMillis()
                _state.value = RecordingState.Recording
                onVoiceStart?.invoke()
            }

            result.stopped -> {
                sessionChunks?.add(frame.clone())
                finalizeSessionIfActive()
                _state.value = RecordingState.Listening
            }

            result.isSpeech -> {
                sessionChunks?.add(frame.clone())

                // 最大録音時間チェック
                val elapsed = (System.currentTimeMillis() - sessionStartTime) / 1000f
                if (elapsed >= MAX_RECORDING_SEC) {
                    Log.w(TAG, "最大録音時間超過 (${elapsed}s) → 強制終了")
                    finalizeSessionIfActive()
                    _state.value = RecordingState.Listening
                    vad.reset()
                }
            }
        }
    }

    private fun finalizeSessionIfActive() {
        val chunks = sessionChunks ?: return
        sessionChunks = null

        if (chunks.isEmpty()) return

        // 修正: チャンクを一度だけ結合（中間コピー削減）
        val totalBytes = chunks.sumOf { it.size }
        val pcm = ByteArray(totalBytes)
        var offset = 0
        for (chunk in chunks) {
            chunk.copyInto(pcm, offset)
            offset += chunk.size
        }
        // chunks の参照を切る（GC 対象化）
        chunks.clear()

        val durationSec = pcm.size.toFloat() / (sampleRate * 2)

        if (durationSec < MIN_RECORDING_SEC) {
            Log.d(TAG, "短すぎてスキップ: ${durationSec}s")
            onTooShort?.invoke(durationSec)
            return
        }

        Log.i(TAG, "セッション完了: ${durationSec}s, ${pcm.size} bytes")
        onVoiceEnd?.invoke(RecordingSession(pcm, durationSec))
    }
}
