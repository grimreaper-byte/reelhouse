package app.reelhouse.android.data.downloads

import app.reelhouse.android.data.api.Http
import kotlinx.coroutines.test.runTest
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import kotlin.random.Random

class FileDownloaderTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer()
    private var content = Random(7).nextBytes(300_000)
    private var etag = "W/\"v1\""
    private var honourRanges = true
    private var status = 200
    private val ranges = mutableListOf<String?>()

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                ranges += request.headers["Range"]
                if (status != 200) return MockResponse.Builder().code(status).body("""{"error":"Downloads are turned off"}""").build()
                val range = request.headers["Range"]?.removePrefix("bytes=")?.removeSuffix("-")?.toIntOrNull()
                // Like Express: a range is only served if the file is still the one If-Range names.
                val sameFile = request.headers["If-Range"]?.let { it == etag } ?: true
                return if (range != null && honourRanges && sameFile) {
                    if (range >= content.size) MockResponse.Builder().code(416).build()
                    else MockResponse.Builder().code(206).addHeader("ETag", etag).body(Buffer().write(content, range, content.size - range)).build()
                } else {
                    MockResponse.Builder().code(200).addHeader("ETag", etag).body(Buffer().write(content)).build()
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.close()

    private val downloader = FileDownloader(Http.client { null })
    private fun url() = server.url("/api/stream/4?download=1").toString()

    @Test
    fun `a whole file arrives intact`() = runTest {
        val f = tmp.newFile()
        f.delete()
        val r = downloader.download(url(), f)
        assertEquals(FileDownloader.Outcome.Done(content.size.toLong()), r)
        assertArrayEquals(content, f.readBytes())
    }

    @Test
    fun `a download carries on where it stopped`() = runTest {
        val f = tmp.newFile()
        f.writeBytes(content.copyOfRange(0, 120_000))
        var lastTotal = 0L
        val r = downloader.download(url(), f, onProgress = { _, total -> lastTotal = total })
        assertTrue(r is FileDownloader.Outcome.Done)
        assertEquals("bytes=120000-", ranges.single())
        assertEquals(content.size.toLong(), lastTotal)
        assertArrayEquals(content, f.readBytes())
    }

    @Test
    fun `a file replaced on the server meanwhile is fetched again, not joined to the old one`() = runTest {
        val f = tmp.newFile()
        f.delete()
        assertEquals(FileDownloader.Outcome.Stopped, downloader.download(url(), f, shouldStop = { f.length() >= 100_000 }))
        // A better copy replaces the library file before the download carries on.
        content = Random(8).nextBytes(250_000)
        etag = "W/\"v2\""
        assertEquals(FileDownloader.Outcome.Done(250_000), downloader.download(url(), f))
        assertArrayEquals(content, f.readBytes())
    }

    @Test
    fun `a server that sends everything again is fine`() = runTest {
        honourRanges = false
        val f = tmp.newFile()
        f.writeBytes(content.copyOfRange(0, 50_000))
        assertTrue(downloader.download(url(), f) is FileDownloader.Outcome.Done)
        assertArrayEquals(content, f.readBytes())
    }

    @Test
    fun `an already complete file needs nothing more`() = runTest {
        val f = tmp.newFile()
        f.writeBytes(content)
        assertEquals(FileDownloader.Outcome.Done(content.size.toLong()), downloader.download(url(), f))
        assertArrayEquals(content, f.readBytes())
    }

    @Test
    fun `stopping keeps what's been fetched`() = runTest {
        val f = tmp.newFile()
        f.delete()
        var calls = 0
        val r = downloader.download(url(), f, shouldStop = { ++calls > 2 })
        assertEquals(FileDownloader.Outcome.Stopped, r)
        assertTrue(f.length() in 1 until content.size)
    }

    @Test
    fun `a refusal says why`() = runTest {
        status = 403
        val f = tmp.newFile()
        f.delete()
        assertEquals(FileDownloader.Outcome.Refused(403, "Downloads are turned off"), downloader.download(url(), f))
    }
}
