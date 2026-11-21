plugins {
    id("com.android.library")
}

android {
    namespace = "io.github.yet_another_ai.deskfleet.nativedesktop"
    compileSdk = 37

    defaultConfig {
        minSdk = 34
        consumerProguardFiles("consumer-rules.pro")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    sourceSets.getByName("main").java.srcDir(layout.buildDirectory.dir("generated/nsh/java").get().asFile)
}

// The published Cargo crate contains the Java runtime matching its JNI ABI.
// Generate it from Cargo.lock rather than vendoring or editing upstream sources.
val prepareNshSources by tasks.registering(Exec::class) {
    val repository = projectDir.resolve("../../..")
    workingDir(repository)
    commandLine("node", repository.resolve("scripts/prepare-android-nsh.ts").absolutePath)
    inputs.files(repository.resolve("Cargo.lock"), repository.resolve("scripts/prepare-android-nsh.ts"))
    outputs.dir(layout.buildDirectory.dir("generated/nsh/java"))
}

tasks.named("preBuild") { dependsOn(prepareNshSources) }

dependencies {
    implementation(project(":capacitor-android"))
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("com.google.firebase:firebase-analytics:24.0.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")
}
