package com.example.whispertranscriber

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.example.whispertranscriber.whisper.ModelDownloader
import kotlinx.coroutines.launch

class SplashActivity : AppCompatActivity() {
    private lateinit var statusText:  TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var errorText:   TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_splash)
        statusText  = findViewById(R.id.text_splash_status)
        progressBar = findViewById(R.id.progress_splash)
        errorText   = findViewById(R.id.text_splash_error)
        lifecycleScope.launch { checkModel() }
    }

    private suspend fun checkModel() {
        statusText.text = "モデルを確認中..."
        when (val result = ModelDownloader.findOrCopyModel(this@SplashActivity)) {
            is ModelDownloader.ModelResult.Found -> {
                statusText.text = "準備完了 (${ModelDownloader.formatModelSize(result.file)})"
                progressBar.visibility = View.GONE
                startActivity(Intent(this@SplashActivity, MainActivity::class.java))
                finish()
            }
            is ModelDownloader.ModelResult.Error -> {
                progressBar.visibility = View.GONE
                statusText.text = "モデルが見つかりません"
                errorText.visibility = View.VISIBLE
                errorText.text = result.message
            }
        }
    }
}
