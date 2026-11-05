package app.reelhouse.android.ui.livetv

import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.data.playback.Quality
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The live player's rules, as the web app's (web/js/views/live-player.js). */
class LiveLogicTest {
    private val channels = listOf(
        Channel("tv1", "One"), Channel("r1", "Radio A", radio = true), Channel("tv2", "Two"), Channel("tv3", "Three"), Channel("r2", "Radio B", radio = true),
    )

    @Test
    fun `channel up and down stay with TV or radio, round the end`() {
        assertEquals("tv2", zapTarget(channels, "tv1", radio = false, step = 1)?.uuid)
        assertEquals("tv3", zapTarget(channels, "tv1", radio = false, step = -1)?.uuid)
        assertEquals("tv1", zapTarget(channels, "tv3", radio = false, step = 1)?.uuid)
        assertEquals("r2", zapTarget(channels, "r1", radio = true, step = 1)?.uuid)
        assertEquals("r1", zapTarget(channels, "r2", radio = true, step = 1)?.uuid)
        // The only one of its kind, or gone from the list: nowhere to go.
        assertNull(zapTarget(channels.take(2), "tv1", radio = false, step = 1))
        assertNull(zapTarget(channels, "gone", radio = false, step = 1))
    }

    @Test
    fun `a channel offers the qualities the server says are worth it`() {
        val all = listOf(Quality("original", "Original"), Quality("8m-1080", "1080p"), Quality("4m-720", "720p"))
        assertEquals(listOf("original", "4m-720"), offeredQualities(all, listOf("original", "4m-720")).map { it.id })
        assertEquals(all, offeredQualities(all, emptyList()))
    }

    @Test
    fun `behind live says by how much, from ten seconds on`() {
        assertEquals(0L, behindLiveMs(20_000, 25_000))
        assertEquals(185_000L, behindLiveMs(200_000, 15_000))
        assertNull(behindText(8_000))
        assertEquals("<1 min behind", behindText(25_000))
        assertEquals("3 min behind", behindText(185_000))
    }

    @Test
    fun `what's on is asked again just after the programme ends`() {
        val nowMs = 1_000_000_000L
        assertEquals(62_000L, nowRefreshDelayMs(nowMs / 1000 + 60, nowMs))
        assertEquals(5_000L, nowRefreshDelayMs(nowMs / 1000 - 600, nowMs)) // already over: soon
        assertEquals(5 * 60_000L, nowRefreshDelayMs(null, nowMs))
        assertEquals(30 * 60_000L, nowRefreshDelayMs(nowMs / 1000 + 4 * 3600, nowMs))
    }

    @Test
    fun `a channel change cut short keeps the stream to stop for the next start`() {
        val toStop = StreamToStop()
        assertEquals("a", toStop.starting("a")) // watching a, changing channel: a goes
        // That start was cut short (another quick change) before the server heard of it: the next still stops a.
        assertEquals("a", toStop.starting(null))
        toStop.started()
        assertNull(toStop.starting(null)) // the server took it: nothing left to stop
        assertEquals("b", toStop.starting("b"))
    }

    @Test
    fun `leaving while a start is on its way says the old stream stopped too`() {
        val toStop = StreamToStop()
        toStop.starting("a")
        assertEquals("a", toStop.take())
        assertNull(toStop.take())
    }
}
