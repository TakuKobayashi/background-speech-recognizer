# ===== whisper.cpp JNI =====
-keep class com.example.whispertranscriber.whisper.WhisperEngine {
    native <methods>;
    public *;
}

# ===== Service / Activity =====
-keep class com.example.whispertranscriber.service.TranscriptionService { *; }
-keep class com.example.whispertranscriber.MainActivity { *; }
-keep class com.example.whispertranscriber.SplashActivity { *; }
-keep class com.example.whispertranscriber.WhisperApplication { *; }

# ===== Kotlin Coroutines =====
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
-keepclassmembernames class kotlinx.** { volatile <fields>; }
-dontwarn kotlinx.coroutines.**

# ===== ViewBinding =====
-keep class * implements androidx.viewbinding.ViewBinding {
    public static * inflate(android.view.LayoutInflater);
    public static * inflate(android.view.LayoutInflater, android.view.ViewGroup, boolean);
    public static * bind(android.view.View);
}

# ===== Material3 =====
-keep class com.google.android.material.** { *; }
-dontwarn com.google.android.material.**

# ===== AndroidX =====
-keep class androidx.lifecycle.** { *; }
-dontwarn androidx.lifecycle.**

# ===== Native ライブラリ =====
-keepclasseswithmembernames class * {
    native <methods>;
}
