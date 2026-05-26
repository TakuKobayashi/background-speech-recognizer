package com.example.whispertranscriber

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.IBinder
import android.util.Log
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.example.whispertranscriber.service.TranscriptionService
import com.example.whispertranscriber.ui.HistoryAdapter
import com.example.whispertranscriber.util.PermissionHelper
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.progressindicator.LinearProgressIndicator
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainActivity"
    }

    // ===== Views =====
    private lateinit var statusCard:              MaterialCardView
    private lateinit var statusText:              TextView
    private lateinit var stateIcon:               TextView
    private lateinit var latestTranscriptionText: TextView
    private lateinit var levelIndicator:          LinearProgressIndicator
    private lateinit var startStopButton:         MaterialButton
    private lateinit var historyRecycler:         RecyclerView
    private lateinit var emptyHistoryText:        TextView

    private val historyAdapter = HistoryAdapter { result -> showDeleteDialog(result) }

    // ===== Service =====
    private var service: TranscriptionService? = null
    private var isBound = false

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            service = (binder as TranscriptionService.LocalBinder).getService()
            isBound = true
            Log.d(TAG, "Service 接続")
            observeService()
        }
        override fun onServiceDisconnected(name: ComponentName) {
            service = null
            isBound = false
            Log.d(TAG, "Service 切断")
        }
    }

    // ===== Permission =====
    private lateinit var permissionHelper: PermissionHelper

    private val history = mutableListOf<TranscriptionService.TranscriptionResult>()

    // ===================================================================
    // ライフサイクル
    // ===================================================================

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        permissionHelper = PermissionHelper(this)

        bindViews()
        setupRecyclerView()
        setupButton()
        updateUi(TranscriptionService.ServiceState.Idle)
    }

    override fun onStart() {
        super.onStart()
        // 既に Service が起動中であればバインド
        val intent = Intent(this, TranscriptionService::class.java)
        bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
    }

    override fun onStop() {
        if (isBound) {
            unbindService(serviceConnection)
            isBound = false
        }
        super.onStop()
    }

    // ===================================================================
    // 初期化
    // ===================================================================

    private fun bindViews() {
        statusCard              = findViewById(R.id.card_status)
        statusText              = findViewById(R.id.text_status)
        stateIcon               = findViewById(R.id.text_state_icon)
        latestTranscriptionText = findViewById(R.id.text_latest_transcription)
        levelIndicator          = findViewById(R.id.level_indicator)
        startStopButton         = findViewById(R.id.button_start_stop)
        historyRecycler         = findViewById(R.id.recycler_history)
        emptyHistoryText        = findViewById(R.id.text_empty_history)
    }

    private fun setupRecyclerView() {
        historyRecycler.adapter = historyAdapter
        historyRecycler.layoutManager = LinearLayoutManager(this)
    }

    private fun setupButton() {
        startStopButton.setOnClickListener {
            val svc = service
            val isIdle = svc == null ||
                svc.serviceState.value is TranscriptionService.ServiceState.Idle ||
                svc.serviceState.value is TranscriptionService.ServiceState.Error

            if (isIdle) {
                startWithPermissionCheck()
            } else {
                service?.stopListening()
            }
        }
    }

    // ===================================================================
    // Service 観察
    // ===================================================================

    private fun observeService() {
        val svc = service ?: return

        lifecycleScope.launch {
            svc.serviceState.collect { state -> updateUi(state) }
        }

        lifecycleScope.launch {
            svc.latestResult.collect { result ->
                result ?: return@collect
                history.add(0, result)
                historyAdapter.submitList(history.toList())
                updateHistoryVisibility()
                latestTranscriptionText.text = result.text
            }
        }

        lifecycleScope.launch {
            svc.audioLevel.collect { db ->
                val progress = ((db + 60f) / 60f * 100f).coerceIn(0f, 100f).toInt()
                levelIndicator.setProgressCompat(progress, true)
            }
        }
    }

    // ===================================================================
    // UI 更新
    // ===================================================================

    private fun updateUi(state: TranscriptionService.ServiceState) {
        when (state) {
            is TranscriptionService.ServiceState.Initializing -> {
                stateIcon.text       = "⏳"
                statusText.text      = "モデル読み込み中..."
                startStopButton.text = "停止"
                startStopButton.isEnabled = true
                levelIndicator.visibility = View.GONE
            }
            is TranscriptionService.ServiceState.Idle -> {
                stateIcon.text       = "⏸️"
                statusText.text      = "停止中"
                startStopButton.text = "開始"
                startStopButton.isEnabled = true
                levelIndicator.visibility = View.GONE
            }
            is TranscriptionService.ServiceState.Listening -> {
                stateIcon.text       = "👂"
                statusText.text      = "待機中"
                startStopButton.text = "停止"
                startStopButton.isEnabled = true
                levelIndicator.visibility = View.VISIBLE
            }
            is TranscriptionService.ServiceState.Recording -> {
                stateIcon.text       = "🔴"
                statusText.text      = "録音中"
                startStopButton.text = "停止"
                startStopButton.isEnabled = true
                levelIndicator.visibility = View.VISIBLE
            }
            is TranscriptionService.ServiceState.Transcribing -> {
                stateIcon.text       = "📝"
                statusText.text      = "文字起こし中 (%.1fs)".format(state.durationSec)
                startStopButton.text = "停止"
                startStopButton.isEnabled = true
                levelIndicator.visibility = View.GONE
            }
            is TranscriptionService.ServiceState.Error -> {
                stateIcon.text       = "⚠️"
                statusText.text      = "エラー: ${state.message}"
                startStopButton.text = "開始"
                startStopButton.isEnabled = true
                levelIndicator.visibility = View.GONE
            }
        }
    }

    private fun updateHistoryVisibility() {
        emptyHistoryText.visibility = if (history.isEmpty()) View.VISIBLE else View.GONE
        historyRecycler.visibility  = if (history.isEmpty()) View.GONE  else View.VISIBLE
    }

    // ===================================================================
    // Service 起動
    // ===================================================================

    private fun startWithPermissionCheck() {
        permissionHelper.requestPermissions(
            onGranted = {
                startTranscriptionService()
                // バッテリー最適化除外を提案（初回のみ推奨）
                if (PermissionHelper.needsBatteryOptimizationExemption(this)) {
                    permissionHelper.requestBatteryOptimizationExemption()
                }
            },
            onDenied = {
                Toast.makeText(this, "マイクのアクセス許可が必要です", Toast.LENGTH_SHORT).show()
            }
        )
    }

    private fun startTranscriptionService() {
        val intent = Intent(this, TranscriptionService::class.java).apply {
            action = TranscriptionService.ACTION_START
        }
        ContextCompat.startForegroundService(this, intent)

        if (!isBound) {
            bindService(
                Intent(this, TranscriptionService::class.java),
                serviceConnection,
                Context.BIND_AUTO_CREATE,
            )
        }
    }

    // ===================================================================
    // 履歴操作
    // ===================================================================

    private fun showDeleteDialog(result: TranscriptionService.TranscriptionResult) {
        AlertDialog.Builder(this)
            .setTitle("削除")
            .setMessage("この文字起こし結果を削除しますか？\n\n${result.text.take(80)}")
            .setPositiveButton("削除") { _, _ ->
                history.removeAll { it.timestamp == result.timestamp }
                historyAdapter.submitList(history.toList())
                updateHistoryVisibility()
                Toast.makeText(this, "削除しました", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("キャンセル", null)
            .show()
    }
}
