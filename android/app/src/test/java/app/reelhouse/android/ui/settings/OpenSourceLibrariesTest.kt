package app.reelhouse.android.ui.settings

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Settings → Open-source licences against what the app is really built from. */
class OpenSourceLibrariesTest {
    // Unit tests run in android/app; the repository is two folders up.
    private val app = generateSequence(File("").absoluteFile) { it.parentFile }.first { File(it, "src/main/assets").isDirectory }
    private val repo = app.parentFile.parentFile
    private val everything = listOf(ReelhouseLicence) + OpenSourceLibraries

    /** The modules of the libraries app/build.gradle.kts builds into the app (not the test or debug-only ones). */
    private fun declaredModules(): List<Pair<String, String>> {
        val catalog = mutableMapOf<String, Pair<String, String>>()
        var inLibraries = false
        for (line in File(app.parentFile, "gradle/libs.versions.toml").readLines()) {
            if (line.startsWith("[")) inLibraries = line.trim() == "[libraries]"
            val m = Regex("""^([\w-]+)\s*=\s*\{(.*)}""").find(line) ?: continue
            if (!inLibraries) continue
            val body = m.groupValues[2]
            val module = Regex("""module\s*=\s*"([^":]+):([^"]+)"""").find(body)?.groupValues
            val group = Regex("""group\s*=\s*"([^"]+)"""").find(body)?.groupValues?.get(1)
            val name = Regex("""name\s*=\s*"([^"]+)"""").find(body)?.groupValues?.get(1)
            catalog[m.groupValues[1].replace('-', '.')] = if (module != null) module[1] to module[2] else group!! to name!!
        }
        return File(app, "build.gradle.kts").readLines()
            .mapNotNull { Regex("""^\s*implementation\(libs\.([\w.]+)\)""").find(it)?.groupValues?.get(1) }
            .map { alias -> catalog[alias] ?: error("no $alias in libs.versions.toml") }
    }

    /** The Go modules tunnel/mobile (the app's tunnel library) requires, but Reelhouse's own. */
    private fun goModules(): List<String> = File(repo, "tunnel/mobile/go.mod").readLines()
        .map { it.substringBefore("//").trim().removePrefix("require").trim() }
        .filter { Regex("""^[\w.-]+(/[\w.-]+)+ v\S+$""").matches(it) }
        .map { it.substringBefore(' ') }
        .filterNot { it.startsWith("reelhouse/") }

    @Test
    fun `every library the app declares is on the screen`() {
        val modules = declaredModules()
        assertTrue("found the app's libraries", modules.size > 20)
        val missing = modules.filter { (group, name) -> OpenSourceLibraries.none { it.includes(group, name) } }
        assertEquals("libraries without an entry in OpenSourceLibraries.kt", emptyList<Pair<String, String>>(), missing)
    }

    @Test
    fun `every Go module of the tunnel is on the screen, but the Windows-only one`() {
        val modules = goModules()
        assertTrue("found the tunnel's modules", "golang.zx2c4.com/wireguard" in modules)
        val notInTheApp = setOf("golang.zx2c4.com/wintun") // Windows only, so not built into Android's library
        val missing = modules.filter { it !in notInTheApp && OpenSourceLibraries.none { lib -> lib.includes(it) } }
        assertEquals("Go modules without an entry in OpenSourceLibraries.kt", emptyList<String>(), missing)
    }

    @Test
    fun `indirect libraries of the release APK are covered too`() {
        // From ./gradlew :app:dependencies --configuration releaseRuntimeClasspath (Oct 2026).
        for ((group, name) in listOf(
            "androidx.room" to "room-runtime", "com.google.guava" to "guava", "com.squareup.okio" to "okio",
            "org.checkerframework" to "checker-qual", "org.jetbrains.compose.ui" to "ui", "org.jetbrains.kotlinx" to "atomicfu",
            "org.jetbrains" to "annotations", "jakarta.inject" to "jakarta.inject-api", "org.jspecify" to "jspecify",
        )) assertTrue("$group:$name", OpenSourceLibraries.any { it.includes(group, name) })
        assertTrue("an unknown org.jetbrains library isn't taken as covered", OpenSourceLibraries.none { it.includes("org.jetbrains", "something-else") })
    }

    @Test
    fun `every licence text is there, names are unique, and Reelhouse's matches the repository's LICENSE`() {
        for (lib in everything) {
            val f = File(app, "src/main/assets/licences/${lib.licence.file}")
            assertTrue("${lib.name}: ${f.name}", f.isFile && f.length() > 500)
        }
        assertEquals(everything.size, everything.map { it.name }.toSet().size)
        assertEquals(
            File(repo, "LICENSE").readText().replace("\r", ""),
            File(app, "src/main/assets/licences/${ReelhouseLicence.licence.file}").readText().replace("\r", ""),
        )
    }

    @Test
    fun `licence texts are reflowed for a phone's width`() {
        val text = """
                                 Apache License
                           Version 2.0, January 2004

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and


   * Redistributions in binary form must reproduce the above copyright
     notice, this list of conditions and the following disclaimer.

Copyright 2009 The Go Authors.
        """.trimIndent()
        assertEquals(
            "Apache License\nVersion 2.0, January 2004\n\n" +
                "(a) You must give any other recipients of the Work or Derivative Works a copy of this License; and\n\n" +
                "* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer.\n\n" +
                "Copyright 2009 The Go Authors.",
            reflowLicence(text),
        )
    }
}
