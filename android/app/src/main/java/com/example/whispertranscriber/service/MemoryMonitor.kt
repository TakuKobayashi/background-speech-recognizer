package com.example.whispertranscriber.service

import android.app.ActivityManager
import android.content.Context
import android.util.Log

/**
 * メモリ使用量を監視し、必要に応じて GC や警告を発する
 * Foreground Service の長時間常駐によるメモリリーク対策
 */
class MemoryMonitor(private val context: Context) {

    companion object {
        private const val TAG = "MemoryMonitor"
        private const val WARNING_THRESHOLD_MB = 200   // 警告しきい値 (MB)
        private const val CRITICAL_THRESHOLD_MB = 350  // 緊急しきい値 (MB)
    }

    data class MemoryStatus(
        val usedMb: Float,
        val availableMb: Float,
        val isWarning: Boolean,
        val isCritical: Boolean,
    )

    fun check(): MemoryStatus {
        val runtime = Runtime.getRuntime()
        val usedBytes = runtime.totalMemory() - runtime.freeMemory()
        val usedMb = usedBytes / 1024f / 1024f

        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(memInfo)
        val availMb = memInfo.availMem / 1024f / 1024f

        val isWarning  = usedMb > WARNING_THRESHOLD_MB
        val isCritical = usedMb > CRITICAL_THRESHOLD_MB

        if (isCritical) {
            Log.w(TAG, "メモリ使用量が緊急しきい値超過: ${usedMb.toInt()}MB → GC 実行")
            System.gc()
        } else if (isWarning) {
            Log.w(TAG, "メモリ使用量警告: ${usedMb.toInt()}MB")
        }

        return MemoryStatus(usedMb, availMb, isWarning, isCritical)
    }

    fun logStatus() {
        val status = check()
        Log.d(TAG, "メモリ: 使用=${status.usedMb.toInt()}MB, 空き=${status.availableMb.toInt()}MB")
    }
}
