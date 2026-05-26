package com.example.whispertranscriber.util

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * Runtime Permission の管理クラス - 新規
 *
 * 対応パーミッション:
 * - RECORD_AUDIO (全バージョン必須)
 * - POST_NOTIFICATIONS (Android 13+ = API 33+)
 * - バッテリー最適化除外 (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
 *
 * 修正点:
 * - POST_NOTIFICATIONS は API 33+ のみ要求
 * - READ_MEDIA_AUDIO は API 33+ のみ要求
 * - READ_EXTERNAL_STORAGE は API 32 以下のみ要求
 * - バッテリー最適化除外フローを実装
 */
class PermissionHelper(private val activity: AppCompatActivity) {

    companion object {
        private const val TAG = "PermissionHelper"

        fun requiredPermissions(): Array<String> = buildList {
            // マイク（全バージョン必須）
            add(Manifest.permission.RECORD_AUDIO)

            // 通知（Android 13+）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }.toTypedArray()

        fun hasRequiredPermissions(context: Context): Boolean {
            return requiredPermissions().all { perm ->
                ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
            }
        }

        fun hasMicPermission(context: Context): Boolean =
            ContextCompat.checkSelfPermission(
                context, Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED

        /**
         * バッテリー最適化の除外が必要かどうか
         */
        fun needsBatteryOptimizationExemption(context: Context): Boolean {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            return !pm.isIgnoringBatteryOptimizations(context.packageName)
        }
    }

    private var onGranted: (() -> Unit)? = null
    private var onDenied:  (() -> Unit)? = null

    private val permissionLauncher: ActivityResultLauncher<Array<String>> =
        activity.registerForActivityResult(
            ActivityResultContracts.RequestMultiplePermissions()
        ) { grants ->
            val micGranted = grants[Manifest.permission.RECORD_AUDIO] == true
            val notifGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                grants[Manifest.permission.POST_NOTIFICATIONS] == true
            } else {
                true  // Android 12 以下は不要
            }

            Log.i(TAG, "パーミッション結果: mic=$micGranted notif=$notifGranted")

            if (micGranted) {
                onGranted?.invoke()
            } else {
                showPermissionDeniedDialog()
                onDenied?.invoke()
            }
        }

    /**
     * 必要なパーミッションを要求する
     */
    fun requestPermissions(onGranted: () -> Unit, onDenied: () -> Unit = {}) {
        this.onGranted = onGranted
        this.onDenied  = onDenied

        if (hasRequiredPermissions(activity)) {
            onGranted()
            return
        }

        val toRequest = requiredPermissions().filter { perm ->
            ContextCompat.checkSelfPermission(activity, perm) != PackageManager.PERMISSION_GRANTED
        }

        if (toRequest.isEmpty()) {
            onGranted()
            return
        }

        Log.i(TAG, "パーミッション要求: $toRequest")
        permissionLauncher.launch(toRequest.toTypedArray())
    }

    /**
     * バッテリー最適化除外ダイアログ（長時間常駐に必要）
     */
    fun requestBatteryOptimizationExemption() {
        if (!needsBatteryOptimizationExemption(activity)) return

        AlertDialog.Builder(activity)
            .setTitle("バッテリー最適化の設定")
            .setMessage(
                "長時間の音声文字起こしのため、このアプリのバッテリー最適化を\n" +
                "「制限なし」に設定することをおすすめします。\n\n" +
                "設定 → アプリ → ${activity.getString(com.example.whispertranscriber.R.string.app_name)} → バッテリー → 制限なし"
            )
            .setPositiveButton("設定を開く") { _, _ ->
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:${activity.packageName}")
                    }
                    activity.startActivity(intent)
                } catch (e: Exception) {
                    Log.e(TAG, "バッテリー設定画面を開けませんでした: ${e.message}")
                    // フォールバック: アプリの詳細設定を開く
                    openAppSettings()
                }
            }
            .setNegativeButton("後で", null)
            .show()
    }

    private fun showPermissionDeniedDialog() {
        val shouldShow = activity.shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)

        AlertDialog.Builder(activity)
            .setTitle("マイクのアクセス許可が必要です")
            .setMessage(
                if (shouldShow) {
                    "音声の文字起こしにはマイクへのアクセスが必要です。"
                } else {
                    "マイクのアクセスが拒否されました。\n設定から手動で許可してください。"
                }
            )
            .setPositiveButton("設定を開く") { _, _ -> openAppSettings() }
            .setNegativeButton("キャンセル", null)
            .show()
    }

    private fun openAppSettings() {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", activity.packageName, null)
        }
        activity.startActivity(intent)
    }
}
