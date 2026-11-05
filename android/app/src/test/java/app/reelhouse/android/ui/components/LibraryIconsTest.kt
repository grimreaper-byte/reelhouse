package app.reelhouse.android.ui.components

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.model.Library
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/** Which icon a library shows in the sidebar: the one picked on the web, or its type's. */
class LibraryIconsTest {
    @Test
    fun `a library without its own shows its type's`() {
        assertEquals("film", LibraryIcons.nameFor("movie", null))
        assertEquals("tv", LibraryIcons.nameFor("show", null))
    }

    @Test
    fun `a picked icon is shown, whatever the type`() {
        assertEquals("tvRecord", LibraryIcons.nameFor("show", "tvRecord"))
        assertEquals("film", LibraryIcons.nameFor("show", "film"))
        assertEquals("trophy", LibraryIcons.nameFor("movie", "trophy"))
    }

    @Test
    fun `one this app doesn't know, from a newer server, shows the type's`() {
        assertEquals("tv", LibraryIcons.nameFor("show", "rocket"))
        assertEquals("film", LibraryIcons.nameFor("movie", ""))
    }

    @Test
    fun `the library list is read with or without icons`() {
        val withIcon = AppJson.decodeFromString(Library.serializer(), """{"id":2,"name":"Recorded TV","type":"show","icon":"tvRecord","count":3}""")
        assertEquals("tvRecord", withIcon.icon)
        val older = AppJson.decodeFromString(Library.serializer(), """{"id":1,"name":"Movies","type":"movie","count":10}""")
        assertNull(older.icon)
    }

    @Test
    fun `the app knows every icon the server offers, in the same order`() {
        val server = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, "server/libraries.js") }
            .firstOrNull { it.isFile }
        assertNotNull("server/libraries.js not found above the test's folder", server)
        val list = Regex("""LIBRARY_ICONS = \[([^\]]*)]""").find(server!!.readText())!!.groupValues[1]
        assertEquals(Regex("""'(\w+)'""").findAll(list).map { it.groupValues[1] }.toList(), LibraryIcons.NAMES)
    }
}
