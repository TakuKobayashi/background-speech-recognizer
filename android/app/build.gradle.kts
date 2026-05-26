plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace   = "com.example.whispertranscriber"
    compileSdk  = 35   // Android 15

    defaultConfig {
        applicationId   = "com.example.whispertranscriber"
        minSdk          = 26   // Android 8.0（AudioRecord VOICE_RECOGNITION + FGS）
        targetSdk       = 35   // Android 15
        versionCode     = 2
        versionName     = "2.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        ndk {
            // 現行端末は arm64-v8a が主力。x86_64 はエミュレータ用
            abiFilters += listOf("arm64-v8a", "x86_64")
        }

        externalNativeBuild {
            cmake {
                cppFlags("-std=c++17", "-O2", "-DNDEBUG", "-fstack-protector-strong")
                arguments(
                    "-DANDROID_PLATFORM=android-26",
                    "-DANDROID_STL=c++_shared",
                    // ggml の SIMD 最適化を有効化
                    "-DGGML_USE_CPU_HBM=OFF",
                )
            }
        }
    }

    signingConfigs {
        create("release") {
            // CI 環境では環境変数から取得する実装に変更してください
            // storeFile   = file(System.getenv("KEYSTORE_PATH") ?: "debug.jks")
            // storePassword = System.getenv("KEYSTORE_PASSWORD") ?: ""
            // keyAlias    = System.getenv("KEY_ALIAS") ?: ""
            // keyPassword = System.getenv("KEY_PASSWORD") ?: ""
        }
    }

    buildTypes {
        release {
            isMinifyEnabled   = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isDebuggable = true
            applicationIdSuffix = ".debug"
        }
    }

    externalNativeBuild {
        cmake {
            path    = file("src/main/jni/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = "11"
        freeCompilerArgs += listOf(
            "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi",
        )
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    packaging {
        jniLibs {
            // c++_shared.so を APK に含める（NDK STL 共有ライブラリ）
            pickFirsts += listOf("lib/*/libc++_shared.so")
        }
    }

    lint {
        abortOnError = false
        warningsAsErrors = false
    }
}

dependencies {
    // Core
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.recyclerview)

    // Lifecycle（LifecycleService に必要）
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.service)

    // Coroutines
    implementation(libs.kotlinx.coroutines.android)

    // Activity Result API
    implementation("androidx.activity:activity-ktx:1.9.3")
}
