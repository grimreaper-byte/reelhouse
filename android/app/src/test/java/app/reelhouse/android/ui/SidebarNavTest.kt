package app.reelhouse.android.ui

import androidx.navigation3.runtime.NavKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/** Where the sidebar takes you, and which of its places is lit for the screen on top. */
class SidebarNavTest {
    private val movies = LibraryKey(1, "Movies")
    private val tv = LibraryKey(2, "TV Shows")

    @Test
    fun `a sidebar place sits on Home, and Home is alone`() {
        assertEquals(listOf(HomeKey, movies), stackFor(movies))
        assertEquals(listOf(HomeKey), stackFor(HomeKey))
    }

    @Test
    fun `going somewhere replaces what was on top of Home`() {
        val stack = mutableListOf<NavKey>(HomeKey, movies, ItemKey(7), PersonKey("Al Pacino"))
        goTo(stack, stackFor(tv))
        assertEquals(listOf(HomeKey, tv), stack)
        goTo(stack, stackFor(HomeKey))
        assertEquals(listOf<NavKey>(HomeKey), stack)
    }

    @Test
    fun `the page you're already under is kept, not rebuilt`() {
        val library = LibraryKey(1, "Movies")
        val stack = mutableListOf<NavKey>(HomeKey, library, ItemKey(7))
        goTo(stack, stackFor(movies))
        assertEquals(listOf(HomeKey, movies), stack)
        assertSame(library, stack[1]) // the same entry, so its scroll position and the rest stay
    }

    @Test
    fun `the lit place is the one the screen on top was opened from`() {
        assertEquals(HomeKey, selectedIn(listOf(HomeKey)))
        assertEquals(HomeKey, selectedIn(listOf(HomeKey, ItemKey(7)))) // a film opened from Home
        assertEquals(movies, selectedIn(listOf(HomeKey, movies, ItemKey(7), PersonKey("Al Pacino"))))
        assertEquals(SettingsKey, selectedIn(listOf(HomeKey, SettingsKey)))
        assertEquals(RecordingsKey, selectedIn(listOf(HomeKey, RecordingsKey)))
        assertEquals(RecordingsKey, selectedIn(listOf(HomeKey, RecordingsKey, RecordingShowKey("news", "News"))))
        assertEquals(RecordingsKey, selectedIn(listOf(HomeKey, RecordingsKey, RecordingShowKey("news", "News"), RecordingSeriesKey("news", "News", 1))))
        // Search is opened from Home's top bar (it isn't in the sidebar): Home stays lit.
        assertEquals(HomeKey, selectedIn(listOf(HomeKey, SearchKey("heat"), ItemKey(3))))
    }
}
