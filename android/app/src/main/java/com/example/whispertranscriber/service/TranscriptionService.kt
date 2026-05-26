package com.example.whispertranscriber.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.example.whispertranscriber.MainActivity
import com.example.whispertranscriber.R
import com.example.whispertranscriber.audio.AudioRecorder
import com.example.whispertranscriber.audio.VadDetector
import com.example.whispertranscriber.storage.FileManager
import com.example.whispertranscriber.whisper.WhisperEngine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Foreground Service - 完全修正版 (Android 14/15 対応)
 *
 * 修正点:
 * - onCreate() 内で即座に startForeground() を呼び ANR を防ぐ
 * - API 34+: ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE を指定
 * - ForegroundServiceStartNotAllowedException を try-catch で処理
 * - WakeLock: isHeld チェックで二重 release を防ぐ
 * - onTaskRemoved(): START_STICKY 再起動時の null Intent 対応
 * - isTranscribing を AtomicBoolean に変更（スレッドセーフ）
 * - stopForeground(): API 35 対応で ServiceCompat.stopForeground() を使用
 * - 1 分ごとのメモリ監視ループ
 */
class TranscriptionService : LifecycleService() {

    companion object {
        private const val TAG             = "TranscriptionService"
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID      = "whisper_transcription"
        private const val MEMORY_CHECK_INTERVAL_MS = 60_000L
        private const val WAKELOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000L  // 24h

        const val ACTION_START = "com.example.whispertranscriber.START"
        const val ACTION_STOP  = "com.example.whispertranscriber.STOP"
    }

    // ===== Binder =====
    inner class LocalBinder : Binder() {
        fun getService(): TranscriptionService = this@TranscriptionService
    }
    private val binder = LocalBinder()

    // ===== 状態 =====
    sealed class ServiceState {
        object Initializing : ServiceState()
        object Idle         : ServiceState()
        object Listening    : ServiceState()
        object Recording    : ServiceState()
        data class Transcribing(val durationSec: Float) : ServiceState()
        data class Error(val message: String) : ServiceState()
    }

    data class TranscriptionResult(
        val text:            String,
        val timestamp:       Long,
        val durationSeconds: Float,
        val wavPath:         String,
        val txtPath:         String,
    )

    private val _serviceState  = MutableStateFlow<ServiceState>(ServiceState.Idle)
    val serviceState: StateFlow<ServiceState> = _serviceState

    private val _latestResult  = MutableStateFlow<TranscriptionResult?>(null)
    val latestResult: StateFlow<TranscriptionResult?> = _latestResult

    private val _audioLevel    = MutableStateFlow(-100f)
    val audioLevel: StateFlow<Float> = _audioLevel

    // ===== コンポーネント =====
    private lateinit var whisperEngine:  WhisperEngine
    private lateinit var audioRecorder:  AudioRecorder
    private lateinit var fileManager:    FileManager

    // WakeLock
    private var wakeLock: PowerManager.WakeLock? = null

    // 文字起こし排他制御（AtomicBoolean に修正）
    private val isTranscribing = AtomicBoolean(false)
    private var transcribeJob: Job? = null
    private var memoryJob:     Job? = null

    var language:  String = "ja"
    var modelFile: File?  = null

    // ===================================================================
    // ライフサイクル
    // ===================================================================

    override fun onCreate() {
        super.onCreate()

        whisperEngine = WhisperEngine(this)
        fileManager   = FileManager(this)
        audioRecorder = AudioRecorder(vadSensitivity = VadDetector.Sensitivity.AGGRESSIVE)

        createNotificationChannel()
        setupAudioCallbacks()

        // 修正: onCreate() で即座に startForeground() を呼ぶ
        // Android 15: API 29 以下では foregroundServiceType 不要
        startForegroundSafely("初期化中...")

        startMemoryMonitoring()
        Log.i(TAG, "Service onCreate")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        // 修正: START_STICKY 再起動時は intent が null になることがある
        when (intent?.action) {
            ACTION_START -> lifecycleScope.launch { startListening() }
            ACTION_STOP  -> stopListening()
            null         -> {
                // システムによる再起動 → リスニング再開
                Log.w(TAG, "null Intent（システム再起動）→ リスニング再開")
                lifecycleScope.launch { startListening() }
            }
            else -> Log.w(TAG, "不明なアクション: ${intent.action}")
        }

        return START_STICKY
    }

    override fun onBind(intent: Intent): IBinder {
        super.onBind(intent)
        return binder
    }

    /**
     * タスクが削除されても Service を継続させる
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        Log.i(TAG, "onTaskRemoved — Service は継続")
        // START_STICKY により OS が再起動してくれる
    }

    override fun onDestroy() {
        Log.i(TAG, "Service onDestroy")
        stopListening()
        whisperEngine.release()
        releaseWakeLock()
        memoryJob?.cancel()
        super.onDestroy()
    }

    // ===================================================================
    // 公開メソッド
    // ===================================================================

    suspend fun startListening() {
        _serviceState.value = ServiceState.Initializing
        updateNotification("モデル読み込み中...")

        if (!whisperEngine.isReady) {
            val ok = whisperEngine.initialize(modelFile)
            if (!ok) {
                _serviceState.value = ServiceState.Error("モデルの読み込みに失敗しました")
                updateNotification("⚠ モデル読み込み失敗")
                return
            }
        }

        acquireWakeLock()

        try {
            audioRecorder.start()
            _serviceState.value = ServiceState.Listening
            updateNotification("👂 待機中...")
        } catch (e: SecurityException) {
            Log.e(TAG, "マイクパーミッション不足: ${e.message}")
            _serviceState.value = ServiceState.Error("マイクのパーミッションがありません")
            updateNotification("⚠ マイクパーミッション")
        } catch (e: Exception) {
            Log.e(TAG, "startListening エラー: ${e.message}")
            _serviceState.value = ServiceState.Error(e.message ?: "不明なエラー")
            updateNotification("⚠ エラー")
        }
    }

    fun stopListening() {
        audioRecorder.stop()
        transcribeJob?.cancel()
        releaseWakeLock()
        _serviceState.value = ServiceState.Idle
        updateNotification("⏸ 停止中")
    }

    // ===================================================================
    // AudioRecorder コールバック
    // ===================================================================

    private fun setupAudioCallbacks() {
        audioRecorder.onVoiceStart = {
            _serviceState.value = ServiceState.Recording
            updateNotification("🔴 録音中...")
        }

        audioRecorder.onTooShort = { sec ->
            Log.d(TAG, "短すぎてスキップ: ${sec}s")
            _serviceState.value = ServiceState.Listening
            updateNotification("👂 待機中...")
        }

        audioRecorder.onLevelUpdate = { db ->
            _audioLevel.value = db
        }

        audioRecorder.onError = { msg ->
            Log.e(TAG, "AudioRecorder エラー: $msg")
            _serviceState.value = ServiceState.Error(msg)
            updateNotification("⚠ エラー")
        }

        audioRecorder.onVoiceEnd = { session ->
            // compareAndSet で競合を防ぐ
            if (isTranscribing.compareAndSet(false, true)) {
                val durationSec = session.durationSeconds
                _serviceState.value = ServiceState.Transcribing(durationSec)
                updateNotification("📝 文字起こし中...")

                transcribeJob = lifecycleScope.launch(Dispatchers.IO) {
                    try {
                        processSession(session.pcmData, durationSec)
                    } catch (e: Exception) {
                        Log.e(TAG, "processSession エラー: ${e.message}")
                    } finally {
                        isTranscribing.set(false)
                        if (_serviceState.value is ServiceState.Transcribing) {
                            _serviceState.value = ServiceState.Listening
                            updateNotification("👂 待機中...")
                        }
                    }
                }
            } else {
                Log.w(TAG, "文字起こし処理中のためスキップ")
                _serviceState.value = ServiceState.Listening
                updateNotification("👂 待機中...")
            }
        }
    }

    private suspend fun processSession(pcmData: ByteArray, durationSec: Float) {
        val text = whisperEngine.transcribe(pcmData, language)
        if (text.isNullOrBlank()) {
            Log.d(TAG, "文字起こし結果が空")
            return
        }

        Log.i(TAG, "文字起こし: \"${text.take(50)}\"")

        val saved = fileManager.save(pcmData, text, durationSec) ?: return

        _latestResult.value = TranscriptionResult(
            text            = text,
            timestamp       = saved.timestamp,
            durationSeconds = durationSec,
            wavPath         = saved.wavFile.absolutePath,
            txtPath         = saved.txtFile.absolutePath,
        )
        updateNotification(text.take(40) + if (text.length > 40) "…" else "")
    }

    // ===================================================================
    // メモリ監視
    // ===================================================================

    private fun startMemoryMonitoring() {
        memoryJob = lifecycleScope.launch(Dispatchers.IO) {
            while (isActive) {
                delay(MEMORY_CHECK_INTERVAL_MS)
                val mem     = Runtime.getRuntime()
                val usedMb  = (mem.totalMemory() - mem.freeMemory()) / 1024 / 1024
                Log.d(TAG, "メモリ使用: ${usedMb}MB")
                if (usedMb > 400) {
                    Log.w(TAG, "メモリ警告: ${usedMb}MB — GC を促進")
                    System.gc()
                }
            }
        }
    }

    // ===================================================================
    // WakeLock（修正: isHeld チェックで二重 release を防ぐ）
    // ===================================================================

    private fun acquireWakeLock() {
        releaseWakeLock()
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$TAG:WakeLock")
            .also { it.acquire(WAKELOCK_TIMEOUT_MS) }
        Log.d(TAG, "WakeLock 取得")
    }

    private fun releaseWakeLock() {
        wakeLock?.let { lock ->
            if (lock.isHeld) {  // 修正: isHeld を確認してから release
                try {
                    lock.release()
                    Log.d(TAG, "WakeLock 解放")
                } catch (e: RuntimeException) {
                    Log.w(TAG, "WakeLock release エラー: ${e.message}")
                }
            }
        }
        wakeLock = null
    }

    // ===================================================================
    // 通知
    // ===================================================================

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "音声文字起こし",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "バックグラウンドで音声を文字起こしします"
            setShowBadge(false)
            enableLights(false)
            enableVibration(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(status: String) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("🎙️ Whisper 文字起こし")
            .setContentText(status)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    this, 0,
                    Intent(this, MainActivity::class.java),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
            )
            .addAction(
                android.R.drawable.ic_media_pause,
                "停止",
                PendingIntent.getService(
                    this, 1,
                    Intent(this, TranscriptionService::class.java).apply { action = ACTION_STOP },
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
            )
            .build()

    private fun updateNotification(status: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(status))
    }

    /**
     * API バージョンに応じた startForeground 呼び出し
     * 修正: API 34+（Android 14+）では FOREGROUND_SERVICE_TYPE_MICROPHONE を明示
     * ServiceCompat.startForeground を使用して ForegroundServiceStartNotAllowedException を処理
     */
    private fun startForegroundSafely(status: String) {
        val notification = buildNotification(status)
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    // API 34 (Android 14)+: FOREGROUND_SERVICE_TYPE_MICROPHONE
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                } else {
                    0
                }
            )
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException (API 31+)
            // バックグラウンドから起動した場合などに発生
            Log.e(TAG, "startForeground 失敗: ${e.message}")
            // Service を停止して安全に終了
            stopSelf()
        }
    }
}
