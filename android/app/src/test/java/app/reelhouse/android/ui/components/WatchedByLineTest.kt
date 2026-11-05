package app.reelhouse.android.ui.components

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.model.HomeResponse
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.ui.common.timeAgo
import org.junit.Assert.assertEquals
import org.junit.Test

class WatchedByLineTest {
    private val now = 1_800_000_000_000L
    private val hour = 3_600_000L

    private fun card(vararg people: String, ago: Long) =
        Item(id = 1, type = "movie", title = "Heat", watchedBy = people.toList(), watchedAt = now - ago)

    @Test
    fun `who watched it and when`() {
        assertEquals("sam · 3 hr ago", watchedByLine(card("sam", ago = 3 * hour), now))
        assertEquals("sam and jo · yesterday", watchedByLine(card("sam", "jo", ago = 30 * hour), now))
        assertEquals("sam and 2 others · 5 days ago", watchedByLine(card("sam", "jo", "alex", ago = 5 * 24 * hour), now))
    }

    @Test
    fun `times as the web app says them`() {
        assertEquals("just now", timeAgo(now - 20_000, now))
        assertEquals("12 min ago", timeAgo(now - 12 * 60_000, now))
        assertEquals("23 hr ago", timeAgo(now - 23 * hour, now))
        assertEquals("yesterday", timeAgo(now - 47 * hour, now))
        assertEquals("2 days ago", timeAgo(now - 48 * hour, now))
    }

    @Test
    fun `the row's cards read from Home, and other rows' cards don't get the line`() {
        val home = AppJson.decodeFromString(
            HomeResponse.serializer(),
            """{"hubs":[{"id":"others","title":"Watched by Others","style":"poster","items":[
                {"id":7,"type":"show","title":"Bluey","watchedBy":["alex"],"watchedAt":1799999000000}]},
              {"id":"recent-1","title":"Recently Added in Movies","items":[{"id":8,"type":"movie","title":"Up","year":2009}]}]}""",
        )
        assertEquals(listOf("alex"), home.hubs[0].items[0].watchedBy)
        assertEquals("alex · 16 min ago", watchedByLine(home.hubs[0].items[0], now))
        assertEquals(emptyList<String>(), home.hubs[1].items[0].watchedBy)
    }
}
