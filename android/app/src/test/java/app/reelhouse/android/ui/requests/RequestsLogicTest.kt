package app.reelhouse.android.ui.requests

import app.reelhouse.android.data.model.FilmRequest
import app.reelhouse.android.data.model.FilmResult
import app.reelhouse.android.data.model.RequestedBy
import app.reelhouse.android.data.model.User
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

class RequestsLogicTest {
    private val film = FilmResult(tmdbId = 949, title = "Heat", year = 1995)
    private val request = FilmRequest(id = 4, tmdbId = 949, title = "Heat", requestedAt = 1_793_145_600_000, user = User(2, "sam"), canRemove = true)

    @Test
    fun `a film on the server opens, one asked for says who, any other can be asked for`() {
        assertEquals(FilmAction.Open(7), filmAction(film.copy(onServer = 7, request = RequestedBy(5, "kid"))))
        assertEquals(FilmAction.AskedFor("Asked for by kid"), filmAction(film.copy(request = RequestedBy(5, "kid"))))
        assertEquals(FilmAction.AskedFor("You asked for it"), filmAction(film.copy(request = RequestedBy(5, "me", mine = true))))
        assertEquals(FilmAction.Ask, filmAction(film))
    }

    @Test
    fun `a request says on what day it was made, as the phone writes dates`() {
        assertEquals("28 Oct 2026", requestedDay(request, Locale.UK, ZoneId.of("UTC")))
        assertEquals("Oct 28, 2026", requestedDay(request, Locale.US, ZoneId.of("UTC")))
    }

    @Test
    fun `removing your own goes at once, someone else's (an admin) asks first`() {
        assertFalse(removalNeedsConfirming(request, myId = 2))
        assertTrue(removalNeedsConfirming(request, myId = 1))
    }
}
