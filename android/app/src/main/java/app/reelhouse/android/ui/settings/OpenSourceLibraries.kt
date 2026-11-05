package app.reelhouse.android.ui.settings

/** A licence's name, and its text in assets/licences. */
data class Licence(val name: String, val file: String)

/**
 * One project built into the app, for Settings → Open-source licences.
 * [covers] says which of the APK's libraries it stands for: Maven groups ("androidx" takes in "androidx.core" too),
 * "group:name" prefixes, or Go module paths (prefixes too). OpenSourceLibrariesTest checks every library the app
 * declares, and every Go module of the tunnel, is covered.
 */
data class OpenSourceLibrary(
    val name: String,
    val copyright: String,
    val licence: Licence,
    val url: String? = null,
    val covers: List<String> = emptyList(),
    val note: String? = null,
)

private val Apache = Licence("Apache License 2.0", "apache-2.0.txt")
private val Mit = Licence("MIT License", "mit.txt")

/** Reelhouse's own licence (the repository's LICENSE). */
val ReelhouseLicence = OpenSourceLibrary(
    name = "Reelhouse",
    copyright = "Copyright (c) 2026 grimreaper-byte",
    licence = Licence("MIT License", "reelhouse.txt"),
)

/**
 * The release APK's libraries, direct and indirect, grouped by project. To see them all after changing a dependency:
 * `./gradlew :app:dependencies --configuration releaseRuntimeClasspath` (and `go list -deps` in tunnel/mobile).
 */
val OpenSourceLibraries: List<OpenSourceLibrary> = listOf(
    OpenSourceLibrary(
        "Android Jetpack (AndroidX)", "Copyright The Android Open Source Project", Apache,
        "https://developer.android.com/jetpack/androidx", listOf("androidx"),
        note = "Activity, AppCompat, Compose, Core, Lifecycle, Navigation 3, Room, WorkManager and the other AndroidX libraries.",
    ),
    OpenSourceLibrary(
        "AndroidX Media3 (ExoPlayer)", "Copyright The Android Open Source Project", Apache,
        "https://github.com/androidx/media", listOf("androidx.media3"),
    ),
    OpenSourceLibrary(
        "CameraX", "Copyright The Android Open Source Project", Apache,
        "https://developer.android.com/media/camera/camerax", listOf("androidx.camera"),
        note = "Includes libyuv (below).",
    ),
    OpenSourceLibrary(
        "libyuv", "Copyright 2011 The LibYuv Project Authors. All rights reserved.", Licence("BSD 3-Clause License", "libyuv.txt"),
        "https://chromium.googlesource.com/libyuv/libyuv",
        note = "Part of CameraX.",
    ),
    OpenSourceLibrary(
        "Accompanist", "Copyright The Android Open Source Project", Apache,
        "https://github.com/google/accompanist", listOf("com.google.accompanist"),
    ),
    OpenSourceLibrary("Coil", "Copyright Coil Contributors", Apache, "https://github.com/coil-kt/coil", listOf("io.coil-kt")),
    OpenSourceLibrary(
        "Compose Multiplatform", "Copyright JetBrains s.r.o. and respective authors and developers", Apache,
        "https://github.com/JetBrains/compose-multiplatform", listOf("org.jetbrains.compose", "org.jetbrains.androidx"),
    ),
    OpenSourceLibrary(
        "Kotlin standard library", "Copyright JetBrains s.r.o. and Kotlin Programming Language contributors", Apache,
        "https://kotlinlang.org", listOf("org.jetbrains.kotlin"),
    ),
    OpenSourceLibrary(
        "kotlinx.coroutines", "Copyright 2016-2024 JetBrains s.r.o and contributors", Apache,
        "https://github.com/Kotlin/kotlinx.coroutines", listOf("org.jetbrains.kotlinx:kotlinx-coroutines"),
    ),
    OpenSourceLibrary(
        "kotlinx.serialization", "Copyright JetBrains s.r.o. and contributors", Apache,
        "https://github.com/Kotlin/kotlinx.serialization", listOf("org.jetbrains.kotlinx:kotlinx-serialization"),
    ),
    OpenSourceLibrary(
        "AtomicFU", "Copyright JetBrains s.r.o. and contributors", Apache,
        "https://github.com/Kotlin/kotlinx-atomicfu", listOf("org.jetbrains.kotlinx:atomicfu"),
    ),
    OpenSourceLibrary(
        "JetBrains Java Annotations", "Copyright JetBrains s.r.o.", Apache,
        "https://github.com/JetBrains/java-annotations", listOf("org.jetbrains:annotations"),
    ),
    OpenSourceLibrary("OkHttp", "Copyright Square, Inc.", Apache, "https://square.github.io/okhttp/", listOf("com.squareup.okhttp3")),
    OpenSourceLibrary("Okio", "Copyright Square, Inc.", Apache, "https://square.github.io/okio/", listOf("com.squareup.okio")),
    OpenSourceLibrary("ZXing", "Copyright ZXing authors", Apache, "https://github.com/zxing/zxing", listOf("com.google.zxing")),
    OpenSourceLibrary("Guava", "Copyright The Guava Authors", Apache, "https://github.com/google/guava", listOf("com.google.guava")),
    OpenSourceLibrary("Dagger", "Copyright The Dagger Authors", Apache, "https://dagger.dev", listOf("com.google.dagger")),
    OpenSourceLibrary("AutoValue", "Copyright Google LLC", Apache, "https://github.com/google/auto", listOf("com.google.auto.value")),
    OpenSourceLibrary(
        "Error Prone annotations", "Copyright The Error Prone Authors", Apache,
        "https://errorprone.info", listOf("com.google.errorprone"),
    ),
    OpenSourceLibrary("J2ObjC annotations", "Copyright Google Inc.", Apache, "https://github.com/google/j2objc", listOf("com.google.j2objc")),
    OpenSourceLibrary(
        "JSR 305 annotations", "Copyright The FindBugs project", Apache,
        "https://github.com/findbugsproject/findbugs", listOf("com.google.code.findbugs"),
    ),
    OpenSourceLibrary("JSpecify", "Copyright The JSpecify Authors", Apache, "https://jspecify.dev", listOf("org.jspecify")),
    OpenSourceLibrary(
        "javax.inject", "Copyright The JSR-330 Expert Group", Apache,
        "https://github.com/javax-inject/javax-inject", listOf("javax.inject"),
    ),
    OpenSourceLibrary(
        "Jakarta Dependency Injection", "Copyright The Jakarta Dependency Injection authors", Apache,
        "https://github.com/jakartaee/inject", listOf("jakarta.inject"),
        note = "Jakarta Dependency Injection is a trademark of the Eclipse Foundation.",
    ),
    OpenSourceLibrary(
        "Checker Framework qualifiers", "Copyright 2004-present by the Checker Framework developers",
        Licence("MIT License", "checker-qual.txt"), "https://checkerframework.org", listOf("org.checkerframework"),
    ),
    // The app tunnel (tunnel/mobile, Go, built in with gomobile).
    OpenSourceLibrary(
        "WireGuard (wireguard-go)", "Copyright (C) 2017-2025 WireGuard LLC. All Rights Reserved.", Mit,
        "https://git.zx2c4.com/wireguard-go", listOf("golang.zx2c4.com/wireguard"),
        note = "Used for the app tunnel. \"WireGuard\" is a registered trademark of Jason A. Donenfeld.",
    ),
    OpenSourceLibrary(
        "gVisor", "Copyright The gVisor Authors", Licence("Apache License 2.0 (some files MIT)", "gvisor.txt"),
        "https://gvisor.dev", listOf("gvisor.dev/gvisor"),
        note = "Its network stack, used by the app tunnel.",
    ),
    OpenSourceLibrary(
        "Go", "Copyright 2009 The Go Authors", Licence("BSD 3-Clause License", "go.txt"),
        "https://go.dev", listOf("golang.org/x"),
        note = "The Go runtime and standard library, and golang.org/x/crypto, mobile, net, sys and time.",
    ),
    OpenSourceLibrary("btree", "Copyright 2014 Google Inc.", Apache, "https://github.com/google/btree", listOf("github.com/google/btree")),
)

/** Whether this stands for the Maven module [group]:[name] (or, with no name, the Go module path [group]). */
fun OpenSourceLibrary.includes(group: String, name: String? = null): Boolean = covers.any { c ->
    when {
        ':' in c -> name != null && "$group:$name".startsWith(c)
        name == null -> group == c || group.startsWith("$c/")
        else -> group == c || group.startsWith("$c.")
    }
}

/**
 * A licence text for a phone's width: the lines of each paragraph joined (they were wrapped for 80 columns), short
 * lines such as headings kept on their own, and the indentation dropped.
 */
fun reflowLicence(text: String): String {
    val out = StringBuilder()
    for (line in text.replace("\r", "").lines().map { it.trim() }) {
        when {
            line.isEmpty() -> out.append(if (out.endsWith("\n\n") || out.isEmpty()) "" else if (out.endsWith("\n")) "\n" else "\n\n")
            out.isEmpty() || out.endsWith("\n") -> out.append(line)
            else -> out.append(' ').append(line)
        }
        if (line.isNotEmpty() && line.length < WRAPPED_LINE) out.append('\n')
    }
    return out.toString().trimEnd()
}

private const val WRAPPED_LINE = 45 // a line this long (without its indentation) was wrapped, so the next one carries on
