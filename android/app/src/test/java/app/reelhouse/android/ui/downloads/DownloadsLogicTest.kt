package app.reelhouse.android.ui.downloads

import app.reelhouse.android.data.downloads.Download
import app.reelhouse.android.data.downloads.DownloadState
import app.reelhouse.android.data.model.Item
import org.junit.Assert.assertEquals
import org.junit.Test

class DownloadsLogicTest {
    private fun movie(id: Long, title: String) = Download(itemId = id, item = Item(id = id, type = "movie", title = title), file = "x")

    private fun episode(id: Long, show: String, season: Int, number: Int) = Download(
        itemId = id,
        item = Item(id = id, type = "episode", title = "Episode $number", seasonNumber = season, episodeNumber = number),
        showTitle = show,
        file = "x",
    )

    @Test
    fun `movies come first, then each show in order`() {
        val groups = groupDownloads(
            listOf(
                episode(1, "The Wire", 2, 1),
                movie(2, "heat"),
                episode(3, "Andor", 1, 3),
                episode(4, "The Wire", 1, 5),
                movie(5, "Alien"),
                episode(6, "Andor", 1, 1),
            ),
        )
        assertEquals(listOf("Movies", "Andor", "The Wire"), groups.map { it.title })
        assertEquals(listOf(5L, 2L), groups[0].downloads.map { it.itemId })
        assertEquals(listOf(6L, 3L), groups[1].downloads.map { it.itemId })
        assertEquals(listOf(4L, 1L), groups[2].downloads.map { it.itemId })
        assertEquals(listOf("Andor"), groupDownloads(listOf(episode(6, "Andor", 1, 1))).map { it.title })
    }

    @Test
    fun `status lines`() {
        val d = movie(1, "Alien").copy(totalBytes = 2_000_000_000, downloadedBytes = 500_000_000)
        assertEquals("Downloading 25% · 500 MB of 2.0 GB", downloadStatus(d.copy(state = DownloadState.Downloading)))
        assertEquals("Paused · 25%", downloadStatus(d.copy(state = DownloadState.Paused)))
        assertEquals("Waiting to download", downloadStatus(movie(1, "Alien")))
        assertEquals("Waiting · 25% · Waiting to continue (timeout)", downloadStatus(d.copy(error = "Waiting to continue (timeout)")))
        assertEquals("Downloads are turned off in Reelhouse.", downloadStatus(d.copy(state = DownloadState.Failed, error = "Downloads are turned off in Reelhouse.")))
        assertEquals("Downloaded · 2.0 GB · watched to 12:00", downloadStatus(d.copy(state = DownloadState.Done, downloadedBytes = d.totalBytes, position = 720.0)))
        assertEquals("Downloaded", downloadLabel(d.copy(state = DownloadState.Done)))
    }
}
