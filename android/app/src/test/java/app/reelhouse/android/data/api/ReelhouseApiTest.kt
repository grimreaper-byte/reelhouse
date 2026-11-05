package app.reelhouse.android.data.api

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ReelhouseApiTest {
    private val server = MockWebServer()
    private lateinit var base: String
    private var unauthorized = 0

    @Before
    fun setUp() {
        server.start()
        base = server.url("/").toString().trimEnd('/')
    }

    @After
    fun tearDown() = server.close()

    /** The client signs requests to [base] only, like the app's (AppContainer.tokenFor). */
    private fun api() = ReelhouseApi(
        Http.client { url -> "tok".takeIf { url.toString().startsWith("$base/") } },
        base = { base },
        onUnauthorized = { unauthorized++ },
    )

    private fun json(code: Int, body: String) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    @Test
    fun `library queries are encoded, and requests carry the sign-in`() = runTest {
        server.enqueue(json(200, """{"library":{"id":3,"name":"Shows","type":"show"},"items":[]}"""))
        api().libraryItems(3, "added", descending = true, filter = "unwatched", genre = "Sci-Fi & Fantasy")
        val req = server.takeRequest()
        assertEquals("/api/libraries/3/items", req.url.encodedPath)
        assertEquals("Sci-Fi & Fantasy", req.url.queryParameter("genre"))
        assertEquals("desc", req.url.queryParameter("order"))
        assertEquals("unwatched", req.url.queryParameter("filter"))
        assertEquals("Bearer tok", req.headers["Authorization"])
        assertEquals("reelhouse", req.headers["X-Requested-With"])
    }

    @Test
    fun `a report sent late says how old it is, and live ones don't`() = runTest {
        server.enqueue(json(200, """{"watched":false,"position":1200}"""))
        server.enqueue(json(200, """{"watched":false,"position":600}"""))
        api().progress(7, 1200.0, 3000.0, "stopped", null, "download", "original", ageMs = 172_800_000)
        api().progress(7, 600.0, 3000.0, "paused", "p1", "direct", "original")
        assertTrue(server.takeRequest().body!!.utf8().contains(""""age":172800000"""))
        assertTrue(!server.takeRequest().body!!.utf8().contains("age"))
    }

    @Test
    fun `marking watched posts the flag`() = runTest {
        server.enqueue(json(200, """{"ok":true,"count":3}"""))
        api().setWatched(9, watched = false)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/items/9/watched", req.url.encodedPath)
        assertEquals("""{"watched":false}""", req.body?.utf8())
    }

    @Test
    fun `search text is passed as is`() = runTest {
        server.enqueue(json(200, """{"movies":[],"shows":[],"episodes":[],"people":[]}"""))
        api().search("Tom & Jerry 50%")
        assertEquals("Tom & Jerry 50%", server.takeRequest().url.queryParameter("q"))
    }

    @Test
    fun `server errors come back as messages, and a refused sign-in is reported`() = runTest {
        server.enqueue(json(404, """{"error":"Not found"}"""))
        val e = assertThrows(ApiException::class.java) { kotlinx.coroutines.runBlocking { api().item(1) } }
        assertEquals("Not found", e.message)
        assertEquals(0, unauthorized)

        server.enqueue(json(401, """{"error":"Sign in required"}"""))
        assertThrows(ApiException::class.java) { kotlinx.coroutines.runBlocking { api().home() } }
        assertEquals(1, unauthorized)
    }

    @Test
    fun `no route means no request`() = runTest {
        val offline = ReelhouseApi(Http.client { null }, base = { null })
        assertThrows(OfflineException::class.java) { kotlinx.coroutines.runBlocking { offline.home() } }
        assertTrue(server.requestCount == 0)
    }

    @Test
    fun `the token never goes to another address`() = runTest {
        server.enqueue(json(200, """{"id":"x","name":"Other","version":"1"}"""))
        // A probe of some other address (as when checking a home address): built from a different base.
        val other = ReelhouseApi(Http.client { url -> "tok".takeIf { url.toString().startsWith("http://192.0.2.1/") } }, base = { null })
        other.serverInfo(base)
        assertNull(server.takeRequest().headers["Authorization"])
    }

    @Test
    fun `changing channel names the stream it leaves, and a live stream is waited for until it has its first seconds`() = runTest {
        server.enqueue(json(200, """{"playId":"abc","url":"/api/live/abc/index.m3u8","radio":false,"quality":"original","qualities":["original","4m-720"]}"""))
        val info = api().playLive("ch1", "original", previousSession = "old")
        val body = server.takeRequest()
        assertEquals("/api/livetv/play/ch1", body.url.encodedPath)
        assertTrue(body.body!!.utf8().contains(""""previousSession":"old""""))
        assertEquals(listOf("original", "4m-720"), info.qualities)

        server.enqueue(MockResponse.Builder().code(404).body("Not ready").build())
        server.enqueue(MockResponse.Builder().code(200).body("#EXTM3U").build())
        server.enqueue(MockResponse.Builder().code(404).body("Session expired").build())
        assertEquals(false, api().livePlaylistReady(info.url))
        assertEquals(true, api().livePlaylistReady(info.url))
        val e = assertThrows(ApiException::class.java) { kotlinx.coroutines.runBlocking { api().livePlaylistReady(info.url) } }
        assertEquals("Session expired", e.message)
    }

    @Test
    fun `requests - the list, finding films, asking and removing`() = runTest {
        server.enqueue(json(200, """{"available":true,"requests":[{"id":4,"tmdbId":949,"title":"Heat","year":1995,"poster":"/api/tmdb-image/poster/heat.jpg",
            "overview":null,"requestedAt":1793145600000,"user":{"id":2,"username":"sam","avatar":null},"canRemove":true}]}"""))
        val list = api().requests()
        assertEquals("Heat", list.requests.single().title)
        assertEquals("sam", list.requests.single().user.username)

        server.enqueue(json(200, """{"results":[{"tmdbId":949,"title":"Heat","year":1995,"poster":null,"onServer":7,"request":null},
            {"tmdbId":9361,"title":"The Last of the Mohicans","year":1992,"onServer":null,"request":{"id":5,"username":"kid","mine":false}}]}"""))
        val films = api().searchFilms("heat & dust 1995")
        assertEquals(7L, films[0].onServer)
        assertEquals("kid", films[1].request?.username)
        server.takeRequest() // the list
        assertEquals("heat & dust 1995", server.takeRequest().url.queryParameter("q"))

        server.enqueue(json(201, """{"request":{"id":6,"tmdbId":9361,"title":"The Last of the Mohicans","requestedAt":1,"user":{"id":1,"username":"me"},"canRemove":true}}"""))
        assertEquals(6L, api().addRequest(9361).id)
        val asked = server.takeRequest()
        assertEquals("POST", asked.method)
        assertEquals("""{"tmdbId":9361}""", asked.body!!.utf8())

        server.enqueue(json(200, """{"ok":true}"""))
        api().removeRequest(6)
        assertEquals("DELETE /api/requests/6", server.takeRequest().let { "${it.method} ${it.url.encodedPath}" })
        server.enqueue(json(200, """{"removed":2}"""))
        assertEquals(2, api().removeAllRequests())

        server.enqueue(json(409, """{"error":"sam has already asked for it"}"""))
        val e = assertThrows(ApiException::class.java) { kotlinx.coroutines.runBlocking { api().addRequest(949) } }
        assertEquals("sam has already asked for it", e.message)
    }
}
