import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.kotlinAndroid)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
}

val rustBridgeDir = rootProject.file("rust-bridge")
val sdkRoot = System.getenv("ANDROID_SDK_ROOT")
    ?: System.getenv("ANDROID_HOME")
    ?: "${System.getenv("HOME")}/Library/Android/sdk"
val androidNdkDir = file("$sdkRoot/ndk").listFiles()
    ?.filter { it.isDirectory }
    ?.maxByOrNull { it.name }

val buildRustAndroidArm64 by tasks.registering(Exec::class) {
    onlyIf { androidNdkDir != null }
    workingDir = rustBridgeDir
    doFirst {
        val prebuiltHost = androidNdkDir!!.resolve("toolchains/llvm/prebuilt")
            .listFiles()?.firstOrNull { it.isDirectory }
            ?: error("Android NDK LLVM prebuilt toolchain not found")
        val toolchainBin = prebuiltHost.resolve("bin")
        val isWin = System.getProperty("os.name").lowercase().contains("win")
        val cmdSuffix = if (isWin) ".cmd" else ""
        val exeSuffix = if (isWin) ".exe" else ""
        val clang = toolchainBin.resolve("aarch64-linux-android34-clang$cmdSuffix").absolutePath
        val clangxx = toolchainBin.resolve("aarch64-linux-android34-clang++$cmdSuffix").absolutePath
        val ar = toolchainBin.resolve("llvm-ar$exeSuffix").absolutePath
        environment("CC_aarch64_linux_android", clang)
        environment("CXX_aarch64_linux_android", clangxx)
        environment("AR_aarch64_linux_android", ar)
        environment("CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER", clang)
    }
    commandLine("cargo", "build", "--release", "--target", "aarch64-linux-android")
    outputs.file(rustBridgeDir.resolve("target/aarch64-linux-android/release/libdeskfleet_kmp_bridge.so"))
}

val syncAndroidJniLibs by tasks.registering(Copy::class) {
    dependsOn(buildRustAndroidArm64)
    from(rustBridgeDir.resolve("target/aarch64-linux-android/release/libdeskfleet_kmp_bridge.so"))
    into(layout.buildDirectory.dir("generated/jniLibs/arm64-v8a"))
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
    }
}

android {
    namespace = "ai.yetanother.deskfleet.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "ai.yetanother.deskfleet.kmp"
        minSdk = 34
        targetSdk = 36
        versionCode = 1500
        versionName = "0.15.0"
    }

    sourceSets["main"].jniLibs.srcDir(layout.buildDirectory.dir("generated/jniLibs"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("JniLibFolders") }.configureEach {
    dependsOn(syncAndroidJniLibs)
}

dependencies {
    implementation(projects.composeApp)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(compose.ui)
    implementation(compose.foundation)
    implementation(compose.runtime)
}
