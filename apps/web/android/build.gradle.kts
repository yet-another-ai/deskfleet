plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
}

extra["minSdkVersion"] = libs.versions.minSdk.get().toInt()
extra["compileSdkVersion"] = libs.versions.compileSdk.get().toInt()
extra["targetSdkVersion"] = libs.versions.targetSdk.get().toInt()


