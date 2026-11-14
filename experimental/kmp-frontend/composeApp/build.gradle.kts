import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import org.jetbrains.kotlin.gradle.ExperimentalWasmDsl
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidLibrary)
    alias(libs.plugins.kotlinSerialization)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
}

val rustBridgeDir = rootProject.file("rust-bridge")

val buildRustDesktop by tasks.registering(Exec::class) {
    workingDir = rustBridgeDir
    commandLine("cargo", "build", "--release")
    outputs.dir(rustBridgeDir.resolve("target/release"))
}

val syncDesktopNativeLib by tasks.registering(Copy::class) {
    dependsOn(buildRustDesktop)
    from(rustBridgeDir.resolve("target/release")) {
        include("libdeskfleet_kmp_bridge.dylib", "libdeskfleet_kmp_bridge.so", "deskfleet_kmp_bridge.dll")
    }
    into(layout.buildDirectory.dir("generated/desktopNativeResources/native"))
}

val buildRustIosSimArm64 by tasks.registering(Exec::class) {
    workingDir = rustBridgeDir
    environment("IPHONEOS_DEPLOYMENT_TARGET", "16.0")
    commandLine("cargo", "build", "--release", "--target", "aarch64-apple-ios-sim")
    outputs.file(rustBridgeDir.resolve("target/aarch64-apple-ios-sim/release/libdeskfleet_kmp_bridge.a"))
}

val buildRustIosArm64 by tasks.registering(Exec::class) {
    workingDir = rustBridgeDir
    environment("IPHONEOS_DEPLOYMENT_TARGET", "16.0")
    commandLine("cargo", "build", "--release", "--target", "aarch64-apple-ios")
    outputs.file(rustBridgeDir.resolve("target/aarch64-apple-ios/release/libdeskfleet_kmp_bridge.a"))
}

kotlin {
    applyDefaultHierarchyTemplate()
    compilerOptions {
        freeCompilerArgs.add("-Xexpect-actual-classes")
    }

    jvm("desktop") {
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_21)
        }
    }

    androidTarget {
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_21)
        }
    }

    @OptIn(ExperimentalWasmDsl::class)
    wasmJs {
        outputModuleName.set("composeApp")
        browser {
            commonWebpackConfig {
                outputFileName = "composeApp.js"
            }
        }
        binaries.executable()
    }

    val iosTargets = listOf(
        iosArm64() to ("aarch64-apple-ios" to buildRustIosArm64),
        iosSimulatorArm64() to ("aarch64-apple-ios-sim" to buildRustIosSimArm64),
    )

    iosTargets.forEach { (target: KotlinNativeTarget, rustInfo) ->
        val (rustTriple, rustTask) = rustInfo
        target.compilations.getByName("main") {
            cinterops {
                val deskfleet_kmp_bridge by creating {
                    defFile(project.file("src/nativeInterop/cinterop/deskfleet_kmp_bridge.def"))
                    includeDirs(rustBridgeDir.resolve("include"))
                    extraOpts("-libraryPath", rustBridgeDir.resolve("target/$rustTriple/release").absolutePath)
                }
            }
        }
        target.binaries.framework {
            baseName = "ComposeApp"
            isStatic = true
        }
        tasks.matching { it.name.contains("cinteropDeskfleet_kmp_bridge") && it.name.contains(target.name, ignoreCase = true) }
            .configureEach { dependsOn(rustTask) }
    }

    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation(compose.runtime)
                implementation(compose.foundation)
                implementation(compose.material3)
                implementation(compose.ui)
                implementation(compose.components.resources)
                implementation(libs.kotlinx.coroutines.core)
                implementation(libs.kotlinx.serialization.json)
                implementation(libs.kotlinx.datetime)
                implementation(libs.ktor.client.core)
                implementation(libs.ktor.client.websockets)
                implementation(libs.ktor.client.content.negotiation)
                implementation(libs.ktor.serialization.kotlinx.json)
            }
        }

        val commonTest by getting {
            dependencies {
                implementation(libs.kotlin.test)
                implementation(libs.kotlinx.coroutines.test)
            }
        }

        val jvmSharedMain by creating {
            dependsOn(commonMain)
            dependencies {
                implementation(libs.ktor.client.okhttp)
            }
        }

        val desktopMain by getting {
            dependsOn(jvmSharedMain)
            resources.srcDir(syncDesktopNativeLib.map { layout.buildDirectory.dir("generated/desktopNativeResources").get() })
            dependencies {
                implementation(compose.desktop.currentOs)
                implementation(libs.kotlinx.coroutines.swing)
            }
        }

        val desktopTest by getting {
            dependencies {
                implementation(libs.kotlin.test)
                implementation(libs.kotlinx.coroutines.test)
            }
        }

        val androidMain by getting {
            dependsOn(jvmSharedMain)
            dependencies {
                implementation(libs.kotlinx.coroutines.android)
                implementation(libs.androidx.core.ktx)
                implementation(libs.androidx.activity.compose)
            }
        }

        val iosMain by getting {
            dependencies {
                implementation(libs.ktor.client.darwin)
            }
        }

        val wasmJsMain by getting {
            dependencies {
                implementation(libs.ktor.client.js)
            }
        }
    }
}

tasks.named("desktopProcessResources") {
    dependsOn(syncDesktopNativeLib)
}

android {
    namespace = "ai.yetanother.deskfleet.compose"
    compileSdk = 36
    defaultConfig {
        minSdk = 34
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

compose.desktop {
    application {
        mainClass = "ai.yetanother.deskfleet.MainKt"
        nativeDistributions {
            targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
            packageName = "DeskFleet"
            packageVersion = "1.0.15"
            description = "DeskFleet Multiplatform Client"
            vendor = "Yet Another AI"
            macOS {
                bundleID = "ai.yetanother.deskfleet.kmp"
            }
            windows {
                menuGroup = "DeskFleet"
                upgradeUuid = "8f45d4a0-91b7-4e92-a79c-2189b5d12891"
            }
            linux {
                packageName = "deskfleet-kmp"
            }
        }
    }
}
