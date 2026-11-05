package app.reelhouse.android.ui.item

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.model.ItemDetails
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A film with an SD and an HD copy: what its page shows (GET /api/items/:id with versions, from server/versions.js). */
class VersionsTest {
    private val film = """
        {"item": {"id": 17, "type": "movie", "title": "Green Street Hooligans", "videoResolution": "720p",
          "versions": [
            {"id": 17, "label": "720p", "width": 1280, "height": 544, "videoCodec": "h264", "audioCodec": "aac", "container": "mp4",
             "bitrate": 879000, "fileSize": 682700000, "media": {"container": "mp4", "video": {"codec": "h264", "width": 1280, "height": 544}}},
            {"id": 46, "label": "SD", "width": 640, "height": 272, "videoCodec": "h264", "container": "mp4", "fileSize": 3100000}
          ]}}
    """.trimIndent()

    @Test
    fun `a film's copies decode best first, with their own files`() {
        val d = AppJson.decodeFromString(ItemDetails.serializer(), film)
        assertEquals(listOf(17L, 46L), d.item.versions.map { it.id })
        assertEquals(1280, d.item.versions[0].media?.video?.width)
        assertNull(d.item.versionOf)
    }

    @Test
    fun `one badge per copy's quality, and the film's own when it has one copy`() {
        val d = AppJson.decodeFromString(ItemDetails.serializer(), film)
        assertEquals(listOf("720p", "SD"), qualityLabels(d.item))
        assertEquals(listOf("720p"), qualityLabels(d.item.copy(versions = emptyList())))
        // Two copies of the same quality (the same file in two folders): one badge.
        assertEquals(listOf("720p"), qualityLabels(d.item.copy(versions = d.item.versions.map { it.copy(label = "720p") })))
    }

    @Test
    fun `a copy's details on one line`() {
        val d = AppJson.decodeFromString(ItemDetails.serializer(), film)
        assertEquals("1280×544 · H264 · AAC · MP4 · 683 MB · 0.9 Mbps", versionDetails(d.item.versions[0]))
        assertEquals("640×272 · H264 · MP4 · 3 MB", versionDetails(d.item.versions[1]))
    }
}
