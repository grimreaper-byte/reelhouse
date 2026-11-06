package app.reelhouse.android.data

import app.reelhouse.android.data.model.HomeResponse
import app.reelhouse.android.data.model.ItemDetails
import app.reelhouse.android.data.model.LibraryItemsResponse
import app.reelhouse.android.data.model.MeResponse
import app.reelhouse.android.data.model.Related
import app.reelhouse.android.data.model.SearchResults
import app.reelhouse.android.data.model.ServerInfo
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The models read what a real Reelhouse sends (fixtures captured from the development server). */
class ModelsTest {
    private fun fixture(name: String) = javaClass.getResource("/fixtures/$name")!!.readText()

    @Test
    fun `server info carries the id apps recognise it by`() {
        val info = AppJson.decodeFromString(ServerInfo.serializer(), fixture("server.json"))
        assertTrue(info.version.isNotEmpty())
        assertEquals(20, info.id?.length)
    }

    @Test
    fun `home hubs decode with items, images and watch state`() {
        val home = AppJson.decodeFromString(HomeResponse.serializer(), fixture("home.json"))
        assertTrue(home.hubs.isNotEmpty())
        assertTrue(home.libraries.isNotEmpty())
        val items = home.hubs.flatMap { it.items }
        assertTrue(items.all { it.images.poster?.startsWith("/api/images/") == true })
        val episode = items.first { it.type == "episode" }
        assertNotNull(episode.episodeLabel)
        val cw = home.hubs.first { it.id == "continue" }
        assertEquals("poster", cw.style)
        assertTrue(cw.items.any { it.progress > 0f && it.progress < 1f })
    }

    @Test
    fun `a channel in Continue Watching decodes beside the titles`() {
        val home = AppJson.decodeFromString(
            HomeResponse.serializer(),
            """{"hubs":[{"id":"continue","title":"Continue Watching","style":"poster","items":[
                {"type":"channel","title":"Test One","lastWatchedAt":5,
                 "channel":{"uuid":"aa","name":"Test One","number":1,"radio":false,"icon":"/api/livetv/channels/aa/icon?v=2"}},
                {"id":7,"type":"movie","title":"A Film","lastWatchedAt":4}
            ]}],"libraries":[]}""",
        )
        val (channel, film) = home.hubs.single().items
        assertEquals("aa", channel.channel?.uuid)
        assertEquals("/api/livetv/channels/aa/icon?v=2", channel.channel?.icon)
        assertEquals(7L, film.id)
        assertEquals(null, film.channel)
    }

    @Test
    fun `detail pages decode, including fields only they have`() {
        val show = AppJson.parseToJsonElement(fixture("item-show.json")).jsonObject
        val item = AppJson.decodeFromJsonElement(app.reelhouse.android.data.model.Item.serializer(), show["item"] as JsonObject)
        assertEquals("show", item.type)
        val movie = AppJson.parseToJsonElement(fixture("item-movie.json")).jsonObject
        assertEquals("movie", AppJson.decodeFromJsonElement(app.reelhouse.android.data.model.Item.serializer(), movie["item"] as JsonObject).type)
    }

    @Test
    fun `item pages decode with what surrounds each kind of item`() {
        val show = AppJson.decodeFromString(ItemDetails.serializer(), fixture("item-show.json"))
        assertTrue(show.children.all { it.type == "season" } && show.children.isNotEmpty())

        val season = AppJson.decodeFromString(ItemDetails.serializer(), fixture("item-season.json"))
        assertEquals("season", season.item.type)
        assertTrue(season.children.all { it.type == "episode" } && season.children.isNotEmpty())
        assertTrue(season.seasons.size >= 2)
        assertEquals("show", season.show?.type)

        val episode = AppJson.decodeFromString(ItemDetails.serializer(), fixture("item-episode.json"))
        assertNotNull(episode.prev ?: episode.next)
        assertNotNull(episode.item.media?.video?.codec)
        assertEquals("season", episode.season?.type)

        val movie = AppJson.decodeFromString(ItemDetails.serializer(), fixture("item-movie.json"))
        assertTrue(movie.item.media!!.audio.isNotEmpty())
    }

    @Test
    fun `library listings, search and related rows decode`() {
        val lib = AppJson.decodeFromString(LibraryItemsResponse.serializer(), fixture("library-items.json"))
        assertTrue(lib.items.isNotEmpty())
        assertEquals(lib.library.count, lib.items.size)
        val search = AppJson.decodeFromString(SearchResults.serializer(), fixture("search.json"))
        assertTrue(!search.isEmpty)
        val related = AppJson.decodeFromString(Related.serializer(), fixture("related.json"))
        assertTrue(related.similar.isEmpty() && related.byCast.isEmpty()) // no TMDB key on the development server
    }

    @Test
    fun `me has the defaults the player uses`() {
        val me = AppJson.decodeFromString(MeResponse.serializer(), fixture("me.json"))
        assertTrue(me.defaults.remoteQuality.isNotEmpty())
    }

    @Test
    fun `fields a newer server adds are ignored, missing ones get defaults`() {
        val info = AppJson.decodeFromString(ServerInfo.serializer(), """{"version":"9.9","somethingNew":{"x":1}}""")
        assertEquals("Reelhouse", info.name)
        assertEquals(null, info.id)
    }
}
