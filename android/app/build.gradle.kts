import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing: a keystore kept outside the repo, described by ~/.reelhouse/android-signing.properties
// (storeFile, storePassword, keyAlias, keyPassword). Without that file the release APK comes out unsigned.
val signingFile = File(System.getProperty("user.home"), ".reelhouse/android-signing.properties")
val signing = signingFile.takeIf { it.isFile }?.let { f -> Properties().apply { f.inputStream().use { load(it) } } }

android {
    namespace = "app.reelhouse.android"
    compileSdk = 37 // current AndroidX and OkHttp need it; the app still targets 36
    ndkVersion = "30.0.16248370" // gomobile builds the tunnel library with it

    defaultConfig {
        applicationId = "app.reelhouse.android"
        minSdk = 25 // Android 7.1: Fire OS 6, as on the Fire TV Stick 4K (1st gen)
        targetSdk = 36
        versionCode = 31
        versionName = "0.13.0"
        // The CPU types the Go tunnel library is built for (buildTunnelAar); a phone of another kind can't install
        // the app rather than failing when the tunnel starts.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }

    signingConfigs {
        if (signing != null) {
            create("release") {
                storeFile = file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }
    compileOptions {
        isCoreLibraryDesugaringEnabled = true // java.time and java.util.Base64 on Android 7.1
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
        aidl = false
        shaders = false
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

// ---------- the Go tunnel library (tunnel/mobile), built with gomobile into libs/rhtunnel.aar ----------

val buildTunnelAar = tasks.register<Exec>("buildTunnelAar") {
    description = "Builds the Go tunnel library (tunnel/mobile) into libs/rhtunnel.aar with gomobile."
    // Everything the task uses is captured here as locals (the configuration cache can't store script objects).
    val goModule = rootProject.layout.projectDirectory.dir("../tunnel")
    val tunnelAar = layout.projectDirectory.file("libs/rhtunnel.aar")
    val sdkDir = androidComponents.sdkComponents.sdkDirectory
    val ndkDir = androidComponents.sdkComponents.ndkDirectory
    val home = System.getProperty("user.home")
    val exe = if (System.getProperty("os.name").startsWith("Windows")) ".exe" else ""
    val goPath = listOfNotNull(
        System.getenv("GOROOT")?.let { "$it/bin" },
        "C:/Program Files/Go/bin", "/usr/local/go/bin", "/usr/lib/go/bin",
        System.getenv("GOPATH")?.let { "$it/bin" }, "$home/go/bin",
    ).filter { File(it).isDirectory }
    val gomobile = goPath.map { File(it, "gomobile$exe") }.firstOrNull { it.isFile }?.path ?: "gomobile"
    // Go keeps the path of a module it's told to use from a folder, whatever -trimpath says, and gomobile names this one by
    // its full path: an app built here would carry this computer's folders. So it's built from a copy whose path says nothing.
    val module = goModule.asFile
    val copy = File(if (exe.isEmpty()) "/tmp" else module.toPath().root.toString(), "reelhouse-tunnel-build")

    inputs.files(fileTree(goModule) {
        include("**/*.go", "**/go.mod", "**/go.sum")
        exclude("bin/**")
    })
    outputs.file(tunnelAar)
    workingDir(File(copy, "mobile"))
    commandLine(
        gomobile, "bind",
        "-target=android/arm64,android/arm,android/amd64",
        "-androidapi", "25",
        "-javapkg", "app.reelhouse",
        "-trimpath", "-ldflags=-s -w",
        "-o", tunnelAar.asFile.absolutePath,
        ".",
    )
    environment("PATH", (goPath + System.getenv("PATH")).joinToString(File.pathSeparator))
    environment("JAVA_HOME", System.getProperty("java.home"))
    doFirst {
        environment("ANDROID_HOME", sdkDir.get().asFile.absolutePath)
        environment("ANDROID_NDK_HOME", ndkDir.get().asFile.absolutePath)
        copy.deleteRecursively()
        module.copyRecursively(copy)
        File(copy, "bin").deleteRecursively()
    }
    doLast { copy.deleteRecursively() }
}
tasks.named("preBuild") { dependsOn(buildTunnelAar) }

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)
    implementation(files("libs/rhtunnel.aar"))

    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.lifecycle.viewmodel.navigation3)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.androidx.navigation3.runtime)
    implementation(libs.androidx.navigation3.ui)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.datasource.okhttp)
    implementation(libs.media3.ui)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.zxing.core)
    implementation(libs.androidx.work.runtime)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
