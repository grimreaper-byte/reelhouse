package app.reelhouse.android.data.downloads

import app.reelhouse.android.data.model.Item
import app.reelhouse.android.data.model.User
import app.reelhouse.android.data.store.ServerProfile
import org.junit.Assert.assertEquals
import org.junit.Test

class DownloadRulesTest {
    private fun profile(serverId: String?) =
        ServerProfile(serverId = serverId, serverName = "Home", urls = emptyList(), token = "t", user = User(id = 1, username = "dave"), deviceName = "Phone")

    private fun download(id: Long, serverId: String?) = Download(itemId = id, serverId = serverId, item = Item(id = id, type = "movie", title = "M$id"), file = "x")

    private val downloads = listOf(download(1, "home"), download(2, "home"), download(3, null))

    @Test
    fun `signing out removes every download`() {
        assertEquals(downloads, downloadsToRemove(profile("home"), null, downloads))
    }

    @Test
    fun `a sign-in that couldn't be read at start isn't a sign-out`() {
        // The stored sign-in was unreadable (e.g. after a Keystore problem): the app starts unpaired.
        assertEquals(emptyList<Download>(), downloadsToRemove(null, null, downloads))
        // Paired again with the same Reelhouse: the downloads are still good.
        assertEquals(emptyList<Download>(), downloadsToRemove(null, profile("home"), downloads))
    }

    @Test
    fun `pairing with another Reelhouse removes the first one's downloads`() {
        assertEquals(listOf(1L, 2L), downloadsToRemove(null, profile("elsewhere"), downloads).map { it.itemId })
        // Without ids there's no telling, so nothing goes.
        assertEquals(emptyList<Download>(), downloadsToRemove(null, profile(null), downloads))
    }

    @Test
    fun `other changes to the sign-in keep the downloads`() {
        assertEquals(emptyList<Download>(), downloadsToRemove(profile("home"), profile("home").copy(serverName = "Renamed"), downloads))
    }
}
