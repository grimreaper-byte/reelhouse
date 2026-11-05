package app.reelhouse.android.data.events

import app.reelhouse.android.data.model.Defaults
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The events server/events.js sends, as the app reads them. */
class ServerEventTest {
    @Test
    fun `a library change names its library`() {
        assertEquals(ServerEvent.LibraryChanged(2), parseServerEvent("library", """{"libraryId":2,"version":17,"added":3}"""))
        assertEquals(ServerEvent.LibraryChanged(2), parseServerEvent("library", """{"libraryId":2,"version":18,"metadata":true}"""))
    }

    @Test
    fun `a deleted library concerns every screen`() {
        assertEquals(ServerEvent.LibraryChanged(null), parseServerEvent("library", """{"libraryId":2,"version":19,"deleted":true}"""))
    }

    @Test
    fun `watch state changes list the items`() {
        assertEquals(ServerEvent.StateChanged(setOf(11L, 12L)), parseServerEvent("state", """{"itemIds":[11,12]}"""))
    }

    @Test
    fun `changed defaults carry the new values`() {
        assertEquals(
            ServerEvent.DefaultsChanged(Defaults(remoteQuality = "2m-720", allowDownloads = false)),
            parseServerEvent("defaults", """{"remoteQuality":"2m-720","allowDownloads":false}"""),
        )
    }

    @Test
    fun `Live TV turned on or off asks for the account's access again`() {
        assertEquals(ServerEvent.LiveTvChanged, parseServerEvent("livetv", "{}"))
    }

    @Test
    fun `a change to the requests carries how many there are`() {
        assertEquals(ServerEvent.RequestsChanged(3), parseServerEvent("requests", """{"count":3}"""))
        assertEquals(ServerEvent.RequestsChanged(0), parseServerEvent("requests", "{}"))
    }

    @Test
    fun `other events and broken data are ignored`() {
        assertNull(parseServerEvent("hello", """{"version":1}"""))
        assertNull(parseServerEvent("something-new", """{}"""))
        assertNull(parseServerEvent("library", "not json"))
    }
}
