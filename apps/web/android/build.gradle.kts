// AGP 9's built-in Kotlin stays on 2.2.x. Force KGP resolution so Firebase
// Analytics 24's Kotlin 2.4 metadata can compile. Keep this classpath version
// identical to `kotlin` in gradle/libs.versions.toml (catalogs are not visible
// inside buildscript).
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.google.services) apply false
}

extra["minSdkVersion"] = libs.versions.minSdk.get().toInt()
extra["compileSdkVersion"] = libs.versions.compileSdk.get().toInt()
extra["targetSdkVersion"] = libs.versions.targetSdk.get().toInt()


