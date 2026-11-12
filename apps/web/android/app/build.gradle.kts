import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

val fallbackNdkVersion = libs.versions.ndk.get()
val minNdkMajor = fallbackNdkVersion.substringBefore(".").toInt()
val resolvedNdkVersion = run {
    val localProperties = Properties().apply {
        val file = rootProject.file("local.properties")
        if (file.isFile) file.inputStream().use(::load)
    }
    val home = System.getProperty("user.home")
    val sdkCandidates = listOfNotNull(
        localProperties.getProperty("sdk.dir"),
        System.getenv("ANDROID_HOME"),
        System.getenv("ANDROID_SDK_ROOT"),
        "$home/Library/Android/sdk",
        "$home/Android/Sdk",
        "/usr/local/lib/android/sdk",
    )
    data class InstalledNdk(val revision: String, val prerelease: Boolean, val numbers: List<Int>)
    val installed = sdkCandidates
        .asSequence()
        .map { file("$it/ndk") }
        .filter { it.isDirectory }
        .flatMap { ndkDir -> (ndkDir.listFiles() ?: emptyArray()).asSequence() }
        .mapNotNull { candidate ->
            val sourceProps = File(candidate, "source.properties")
            if (!sourceProps.isFile) return@mapNotNull null
            val props = Properties().apply { sourceProps.inputStream().use(::load) }
            val revision = props.getProperty("Pkg.Revision")?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val numbers = revision.substringBefore("-").split(".").map { it.toIntOrNull() ?: return@mapNotNull null }
            if (numbers.firstOrNull()?.let { it >= minNdkMajor } != true) return@mapNotNull null
            InstalledNdk(revision, revision.contains("-"), numbers)
        }
        .toList()
    installed.firstOrNull { it.revision == fallbackNdkVersion }?.revision
        ?: installed.sortedWith(
            compareBy<InstalledNdk> { it.prerelease }
                .thenByDescending { it.numbers.getOrElse(0) { 0 } }
                .thenByDescending { it.numbers.getOrElse(1) { 0 } }
                .thenByDescending { it.numbers.getOrElse(2) { 0 } },
        ).firstOrNull()?.revision
        ?: fallbackNdkVersion
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
    namespace = "ai.yetanother.deskfleet"
    compileSdk = libs.versions.compileSdk.get().toInt()
    ndkVersion = resolvedNdkVersion

    defaultConfig {
        applicationId = "ai.yetanother.deskfleet"
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
            isMinifyEnabled = true
            isShrinkResources = true
            ndk {
                debugSymbolLevel = "FULL"
            }
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
