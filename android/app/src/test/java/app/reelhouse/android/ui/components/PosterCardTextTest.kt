package app.reelhouse.android.ui.components

import app.reelhouse.android.data.model.Item
import app.reelhouse.android.data.model.ShowRef
import org.junit.Assert.assertEquals
import org.junit.Test

/** The lines under a poster, now Continue Watching shows episodes as posters (their season's or show's). */
class PosterCardTextTest {
    private val bluey = ShowRef(id = 10, title = "Bluey")
    private fun episode(show: ShowRef?) =
        Item(id = 12, type = "episode", title = "Magic Xylophone", seasonNumber = 1, episodeNumber = 3, show = show)

    @Test
    fun `an episode under its show's name, then which episode it is`() {
        assertEquals("Bluey", posterTitle(episode(bluey)))
        assertEquals("S1 · E3 · Magic Xylophone", defaultSubtitle(episode(bluey)))
    }

    @Test
    fun `an episode without its show keeps its own title`() {
        assertEquals("Magic Xylophone", posterTitle(episode(null)))
        assertEquals("S1 · E3", defaultSubtitle(episode(null)))
    }

    @Test
    fun `seasons and films as before`() {
        val season = Item(id = 11, type = "season", title = "Season 1", show = bluey)
        assertEquals("Bluey", posterTitle(season))
        assertEquals("Season 1", defaultSubtitle(season))
        val film = Item(id = 1, type = "movie", title = "Heat", year = 1995)
        assertEquals("Heat", posterTitle(film))
        assertEquals("1995", defaultSubtitle(film))
    }
}
