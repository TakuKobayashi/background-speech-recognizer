package com.example.whispertranscriber.audio

import android.util.Log
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * VAD（Voice Activity Detector）- 修正版
 *
 * 修正点:
 * - processFrame() の require() を削除（RuntimeException 抑止）
 *   → フレームサイズ不正は警告ログ + SILENCE 返却で安全に処理
 * - ゼロ交差率計算のゼロ除算を修正
 * - noiseFloor を最低値でクリップ（-100dB 以下にならないよう）
 * - VAD 状態リセット時に連続フレームカウンタも初期化
 */
class VadDetector(
    private val sampleRate: Int = 16000,
    val sensitivity: Sensitivity = Sensitivity.AGGRESSIVE,
) {
    enum class Sensitivity {
        NORMAL,
        AGGRESSIVE,
        VERY_AGGRESSIVE,
    }

    companion object {
        private const val TAG = "VadDetector"
        private const val FRAME_MS = 10
        private const val NOISE_FLOOR_ALPHA_DECAY  = 0.005f
        private const val NOISE_FLOOR_ALPHA_ATTACK = 0.05f
        private const val NOISE_FLOOR_MIN = -80f
        private const val NOISE_FLOOR_MAX = -20f
    }

    val frameSamples: Int = sampleRate * FRAME_MS / 1000      // 160
    val frameBytes:   Int = frameSamples * 2                   // 320

    private var noiseFloorDb = -55.0f

    private var consecutiveVoiceFrames   = 0
    private var consecutiveSilenceFrames = 0
    private var _isSpeechActive          = false

    private val voiceStartFrames: Int
    private val silenceEndFrames:  Int
    private val energyThresholdDb: Float

    init {
        when (sensitivity) {
            Sensitivity.NORMAL -> {
                voiceStartFrames  = 5
                silenceEndFrames  = 25
                energyThresholdDb = -40.0f
            }
            Sensitivity.AGGRESSIVE -> {
                voiceStartFrames  = 3
                silenceEndFrames  = 30
                energyThresholdDb = -45.0f
            }
            Sensitivity.VERY_AGGRESSIVE -> {
                voiceStartFrames  = 2
                silenceEndFrames  = 40
                energyThresholdDb = -50.0f
            }
        }
    }

    data class VadResult(
        val isSpeech:  Boolean,
        val energyDb:  Float,
        val started:   Boolean,
        val stopped:   Boolean,
    )

    /**
     * 1 フレーム（frameBytes バイト）の PCM を処理する
     * フレームサイズが異なる場合は警告して SILENCE を返す（クラッシュしない）
     */
    fun processFrame(frame: ByteArray): VadResult {
        // 修正: require() を削除してソフトエラーにする
        if (frame.size != frameBytes) {
            Log.w(TAG, "フレームサイズ不正: ${frame.size} bytes (期待: $frameBytes bytes) → SILENCE 扱い")
            return VadResult(isSpeech = _isSpeechActive, energyDb = -100f, started = false, stopped = false)
        }

        val energyDb = calculateRmsDb(frame)
        val zcr      = calculateZeroCrossingRate(frame)

        // ノイズフロア適応更新
        if (!_isSpeechActive) {
            val alpha = if (energyDb < noiseFloorDb) NOISE_FLOOR_ALPHA_DECAY else NOISE_FLOOR_ALPHA_ATTACK * 0.1f
            noiseFloorDb = (noiseFloorDb + alpha * (energyDb - noiseFloorDb))
                .coerceIn(NOISE_FLOOR_MIN, NOISE_FLOOR_MAX)
        }

        val dynamicThreshold = maxOf(noiseFloorDb + 12f, energyThresholdDb)
        val energyVoice = energyDb > dynamicThreshold
        val zcrVoice    = zcr in 0.04f..0.40f   // 人声の ZCR 帯域（調整済み）
        val isVoiceFrame = energyVoice && zcrVoice

        return updateState(isVoiceFrame, energyDb)
    }

    private fun updateState(isVoiceFrame: Boolean, energyDb: Float): VadResult {
        var started = false
        var stopped = false

        if (isVoiceFrame) {
            consecutiveVoiceFrames++
            consecutiveSilenceFrames = 0

            if (!_isSpeechActive && consecutiveVoiceFrames >= voiceStartFrames) {
                _isSpeechActive = true
                started = true
                Log.d(TAG, "音声開始 (${energyDb.toInt()}dB, floor=${noiseFloorDb.toInt()}dB)")
            }
        } else {
            consecutiveSilenceFrames++
            consecutiveVoiceFrames = 0

            if (_isSpeechActive && consecutiveSilenceFrames >= silenceEndFrames) {
                _isSpeechActive = false
                stopped = true
                Log.d(TAG, "音声終了 (無音 ${consecutiveSilenceFrames} フレーム)")
            }
        }

        return VadResult(
            isSpeech = _isSpeechActive,
            energyDb = energyDb,
            started  = started,
            stopped  = stopped,
        )
    }

    val isSpeechActive: Boolean get() = _isSpeechActive

    fun reset() {
        consecutiveVoiceFrames   = 0
        consecutiveSilenceFrames = 0
        _isSpeechActive          = false
        noiseFloorDb             = -55.0f
    }

    // ===== 信号処理 =====

    private fun calculateRmsDb(frame: ByteArray): Float {
        var sumSquares = 0.0
        val numSamples = frame.size / 2
        if (numSamples == 0) return -100f
        for (i in 0 until numSamples) {
            val lo     = frame[i * 2].toInt() and 0xFF
            val hi     = frame[i * 2 + 1].toInt()
            val sample = ((hi shl 8) or lo).toShort().toFloat() / 32768.0f
            sumSquares += sample * sample
        }
        val rms = sqrt(sumSquares / numSamples).toFloat()
        return if (rms > 1e-10f) 20f * log10(rms) else -100f
    }

    /** ゼロ交差率（修正: numSamples が 0 のときゼロ除算を防ぐ） */
    private fun calculateZeroCrossingRate(frame: ByteArray): Float {
        val numSamples = frame.size / 2
        if (numSamples < 2) return 0f

        var crossings = 0
        var prevSign  = 0

        for (i in 0 until numSamples) {
            val lo     = frame[i * 2].toInt() and 0xFF
            val hi     = frame[i * 2 + 1].toInt()
            val sample = ((hi shl 8) or lo).toShort()
            val sign   = when {
                sample > 0  ->  1
                sample < 0  -> -1
                else        ->  0
            }
            if (prevSign != 0 && sign != 0 && sign != prevSign) crossings++
            if (sign != 0) prevSign = sign
        }
        return crossings.toFloat() / numSamples
    }
}
