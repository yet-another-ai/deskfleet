import groovy.json.JsonSlurper

plugins {
    alias(libs.plugins.android.application)
}

val packageJson = JsonSlurper().parse(file("../../package.json")) as Map<*, *>
val packageVersion = packageJson["version"] as String
val resolvedVersionName = System.getenv("ANDROID_VERSION_NAME")?.takeIf { it.isNotEmpty() } ?: packageVersion
val defaultVersionCode = run {
    val parts = resolvedVersionName.split("-", limit = 2)
    val numbers = parts[0].split(".").map { it.toIntOrNull() ?: 0 }
    val major = numbers.getOrElse(0) { 0 }
    val minor = numbers.getOrElse(1) { 0 }
    val patch = numbers.getOrElse(2) { 0 }
    val pre = if (parts.size == 1) {
        999
    } else {
        Regex("""(\d+)$""").find(parts[1])?.groupValues?.get(1)?.toIntOrNull()?.coerceIn(1, 998) ?: 1
    }
    major * 10_000_000 + minor * 100_000 + patch * 1_000 + pre
}

android {
    namespace = "io.github.yet_another_ai.deskfleet.mobile"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "io.github.yet_another_ai.deskfleet.mobile"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = System.getenv("ANDROID_VERSION_CODE")?.toIntOrNull() ?: defaultVersionCode
        versionName = resolvedVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        androidResources {
            ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation(project(":capacitor-android"))
    implementation(project(":capacitor-cordova-android-plugins"))
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.coordinatorlayout)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.fragment.ktx)
    implementation(libs.androidx.webkit)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}

apply(from = "capacitor.build.gradle")
