package app.reelhouse.android.data.downloads

import app.reelhouse.android.data.model.Item
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class DownloadStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun download(store: DownloadStore, id: Long, addedAt: Long = id, state: DownloadState = DownloadState.Queued) =
        Download(
            itemId = id,
            item = Item(id = id, type = "movie", title = "Movie $id"),
            file = File(store.folderFor(id), "video.mp4").path,
            state = state,
            addedAt = addedAt,
        )

    @Test
    fun `downloads are kept across restarts, and one cut off is queued again`() {
        val dir = tmp.newFolder("downloads")
        val store = DownloadStore(dir)
        store.add(download(store, 1))
        store.add(download(store, 2))
        store.update(1) { it.copy(state = DownloadState.Downloading, downloadedBytes = 500) }
        store.update(2) { it.copy(state = DownloadState.Paused) }

        val again = DownloadStore(dir)
        assertEquals(listOf(1L, 2L), again.downloads.value.map { it.itemId })
        assertEquals(DownloadState.Queued, again.get(1)!!.state)
        assertEquals(500L, again.get(1)!!.downloadedBytes)
        assertEquals(DownloadState.Paused, again.get(2)!!.state)
    }

    @Test
    fun `the oldest queued download goes first, and an item is only added once`() {
        val store = DownloadStore(tmp.newFolder("downloads"))
        store.add(download(store, 1, addedAt = 30))
        store.add(download(store, 2, addedAt = 10, state = DownloadState.Paused))
        store.add(download(store, 3, addedAt = 20))
        store.add(download(store, 3, addedAt = 5))
        assertEquals(3, store.downloads.value.size)
        assertEquals(3L, store.nextQueued()!!.itemId)
        store.update(3) { it.copy(state = DownloadState.Done) }
        assertEquals(1L, store.nextQueued()!!.itemId)
    }

    @Test
    fun `a finished download only counts while its file is there`() {
        val store = DownloadStore(tmp.newFolder("downloads"))
        val d = download(store, 1, state = DownloadState.Done)
        store.add(d)
        assertNull(store.completed(1))
        File(d.file).writeBytes(ByteArray(10))
        assertEquals(1L, store.completed(1)!!.itemId)
        assertTrue(store.bytesUsed() >= 10)
    }

    @Test
    fun `removing a download deletes its files`() {
        val store = DownloadStore(tmp.newFolder("downloads"))
        val d = download(store, 1, state = DownloadState.Done)
        store.add(d)
        store.add(download(store, 2))
        File(d.file).writeBytes(ByteArray(10))
        store.remove(1)
        assertFalse(File(d.file).exists())
        assertEquals(listOf(2L), store.downloads.value.map { it.itemId })
        store.addReport(PendingReport(2, 60.0, 600.0, "paused", 1))
        store.removeAll()
        assertTrue(store.downloads.value.isEmpty())
        assertTrue(store.pendingReports().isEmpty())
        assertFalse(store.folderFor(2).listFiles()!!.isNotEmpty())
    }

    @Test
    fun `only the latest offline report per item is kept until it's sent`() {
        val dir = tmp.newFolder("downloads")
        val store = DownloadStore(dir)
        store.addReport(PendingReport(1, 60.0, 600.0, "paused", 1))
        store.addReport(PendingReport(2, 30.0, 600.0, "paused", 2))
        store.addReport(PendingReport(1, 120.0, 600.0, "stopped", 3))
        val again = DownloadStore(dir)
        assertEquals(listOf(2L to 30.0, 1L to 120.0), again.pendingReports().map { it.itemId to it.position })
        again.reportSent(again.pendingReports().first())
        assertEquals(listOf(1L), DownloadStore(dir).pendingReports().map { it.itemId })
    }
}
