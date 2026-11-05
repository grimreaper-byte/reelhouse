package app.reelhouse.android.ui.livetv

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.data.model.Dvr
import app.reelhouse.android.data.model.GuideResponse
import app.reelhouse.android.data.model.MeResponse
import app.reelhouse.android.data.model.Programme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale

/** The guide as the web app has it (web/js/views/livetv.js), from GET /api/livetv/guide. */
class GuideLogicTest {
    private val zone = ZoneId.of("Europe/London")
    private fun at(h: Int, m: Int, day: Int = 29) = ZonedDateTime.of(2026, 10, day, h, m, 0, 0, zone).toEpochSecond()
    private val now = at(20, 10)

    private fun p(id: Long, channel: String, start: Long, stop: Long, title: String = "P$id", genre: List<Int> = emptyList(), dvr: Dvr? = null) =
        Programme(id, channel, start, stop, title, genre = genre, dvr = dvr)

    @Test
    fun `the guide and the account's Live TV decode as the server sends them`() {
        val g = AppJson.decodeFromString(
            GuideResponse.serializer(),
            """{"from":1793304000,"to":1793325600,"now":1793304600,"canRecord":true,
               "channels":[{"uuid":"a","name":"One","number":1,"radio":false,"icon":"/api/livetv/channels/a/icon?v=3"},
                           {"uuid":"b","name":"Two HD","number":102.5,"radio":false,"icon":null}],
               "events":[{"id":7,"channel":"a","start":1793304000,"stop":1793307600,"title":"News","subtitle":null,"summary":"Today",
                          "description":null,"season":null,"episode":null,"episodeLabel":null,"genre":[32],"genreName":"News / Current affairs",
                          "dvr":{"uuid":"0123456789abcdef0123456789abcdef","state":"scheduled"}}]}""",
        )
        assertEquals("1", g.channels[0].numberLabel)
        assertEquals("102.5", g.channels[1].numberLabel)
        assertEquals("scheduled", g.events[0].dvr?.state)
        assertEquals(2, g.events[0].genreGroup())

        val me = AppJson.decodeFromString(MeResponse.serializer(), """{"user":{"id":1,"username":"a"},"liveTv":{"available":true,"canRecord":false,"radio":true}}""")
        assertTrue(me.liveTv.available && me.liveTv.radio && !me.liveTv.canRecord)
        // From a server before Live TV: nothing offered.
        assertFalse(AppJson.decodeFromString(MeResponse.serializer(), """{"user":{"id":1,"username":"a"}}""").liveTv.available)
    }

    @Test
    fun `today starts the half hour before now's, other days at midnight, and a day runs to an hour past the next midnight`() {
        assertEquals(at(19, 30), todayStart(now))
        assertEquals(at(19, 30), todayStart(at(20, 0)))
        assertEquals(at(0, 0, day = 30), startOfDay(1, now, zone))
        assertEquals(at(0, 0, day = 29), startOfDay(0, now, zone))
        val midnight = startOfDay(1, now, zone)
        assertTrue(canLoadMore(midnight + 18 * 3600, midnight))
        assertFalse(canLoadMore(midnight + 25 * 3600, midnight))
    }

    @Test
    fun `days are named as the web app names them`() {
        assertEquals("Today", dayLabel(now, now, zone, Locale.UK))
        assertEquals("Tomorrow", dayLabel(at(1, 0, day = 30), now, zone, Locale.UK))
        assertEquals("Yesterday", dayLabel(at(23, 0, day = 28), now, zone, Locale.UK))
        assertEquals("Saturday 31 Oct", dayLabel(at(9, 0, day = 31), now, zone, Locale.UK))
        assertEquals(listOf("Today", "Tomorrow", "Saturday"), (0..2).map { dayChip(it, now, zone, Locale.UK) })
    }

    @Test
    fun `what's on now and next on each channel, and what's highlighted first`() {
        val channels = listOf(Channel("a", "One"), Channel("b", "Two"), Channel("c", "Three"))
        val events = listOf(
            p(3, "b", at(20, 30), at(21, 0)),
            p(1, "b", at(19, 0), at(20, 0)),
            p(2, "b", at(20, 0), at(20, 30)),
            p(4, "c", at(21, 0), at(22, 0)),
        )
        val rows = guideRows(channels, events)
        assertEquals(listOf(1L, 2L, 3L), rows[1].programmes.map { it.id })
        assertEquals(2L to 3L, rows[1].nowAndNext(now).let { (a, b) -> a?.id to b?.id })
        assertEquals(null to 4L, rows[2].nowAndNext(now).let { (a, b) -> a?.id to b?.id })
        assertTrue(rows[0].programmes.isEmpty())
        // One has nothing: Two's programme on now.
        assertEquals(2L, firstHighlight(rows, now, at(19, 30))?.id)
        // Nothing on now anywhere: the next one.
        assertEquals(4L, firstHighlight(guideRows(channels.drop(2), events), now, at(19, 30))?.id)
    }

    @Test
    fun `programmes are placed by the minute and clipped to the hours loaded`() {
        val from = at(19, 30)
        val to = at(21, 30)
        assertEquals(Span(0f, 30f), p(1, "a", at(19, 0), at(20, 0)).span(from, to))
        assertEquals(Span(60f, 120f), p(2, "a", at(20, 30), at(22, 0)).span(from, to))
        assertEquals(listOf(at(19, 30), at(20, 0), at(20, 30), at(21, 0)), halfHours(from, to))
        assertEquals(listOf(1L, 2L, 3L), mergeEvents(listOf(p(1, "a", 0, 1), p(2, "a", 1, 2)), listOf(p(2, "a", 1, 2), p(3, "a", 2, 3))).map { it.id })
    }

    @Test
    fun `how long, how far through, and the words for it`() {
        val news = p(1, "a", at(20, 0), at(21, 0))
        assertTrue(news.airing(now))
        assertEquals(50, news.minutesLeft(now))
        assertEquals("50 min left", news.lengthText(now))
        assertEquals("60 min", news.lengthText(at(19, 0)))
        assertEquals(10f / 60f, news.progress(now), 0.001f)
        assertEquals("S2 · E5", Programme(1, "a", 0, 1, season = 2, episode = 5).episodeText())
        assertEquals("Series 3, Ep 2", Programme(1, "a", 0, 1, episodeLabel = "Series 3, Ep 2").episodeText())
        assertEquals("Episode 4", Programme(1, "a", 0, 1, episode = 4).episodeText())
        assertNull(Programme(1, "a", 0, 1).episodeText())
        // Film / drama (0x10–0x1f) is group 1; an unknown code has none.
        assertEquals(1, p(1, "a", 0, 1, genre = listOf(0x14)).genreGroup())
        assertNull(p(1, "a", 0, 1, genre = listOf(0xf0)).genreGroup())
    }

    @Test
    fun `Record, Cancel or Stop recording as the programme stands, only for accounts allowed to`() {
        val later = p(1, "a", at(21, 0), at(22, 0))
        val onNow = p(2, "a", at(20, 0), at(21, 0), dvr = Dvr("u", "recording"))
        val over = p(3, "a", at(19, 0), at(20, 0))
        assertEquals(RecordAction.Record, recordAction(later, now, canRecord = true))
        assertEquals(RecordAction.Cancel, recordAction(later.copy(dvr = Dvr("u", "scheduled")), now, canRecord = true))
        assertEquals(RecordAction.Stop, recordAction(onNow, now, canRecord = true))
        assertNull(recordAction(later, now, canRecord = false))
        assertNull(recordAction(over, now, canRecord = true))
        // Someone else's recording: only they or an admin can cancel or stop it.
        assertNull(recordAction(later.copy(dvr = Dvr("u", "scheduled", canChange = false)), now, canRecord = true))
        assertNull(recordAction(onNow.copy(dvr = Dvr("u", "recording", canChange = false)), now, canRecord = true))
        assertEquals("Recording now", recordingLabel(Dvr("u", "recording")))
        assertEquals("Will be recorded", recordingLabel(Dvr("u", "scheduled")))
        assertEquals("Recorded", recordingLabel(Dvr("u", "completed")))
    }

    @Test
    fun `an episode of a series recording is skipped rather than cancelled, and can be put back`() {
        val later = p(1, "a", at(21, 0), at(22, 0))
        val made = later.copy(dvr = Dvr("u", "scheduled", series = "rule"))
        assertEquals(RecordAction.Skip, recordAction(made, now, canRecord = true))
        assertEquals("Series recording", recordingLabel(made.dvr!!))
        assertTrue(made.markedRecording())
        val skipped = later.copy(dvr = Dvr("u", "skipped", series = "rule"))
        assertEquals(RecordAction.Restore, recordAction(skipped, now, canRecord = true))
        assertEquals("Skipped", recordingLabel(skipped.dvr!!))
        assertFalse(skipped.markedRecording())
        assertFalse(later.markedRecording())
        assertNull(recordAction(skipped.copy(dvr = skipped.dvr!!.copy(canChange = false)), now, canRecord = true))
    }

    @Test
    fun `a recording that failed isn't marked as recording, and says so`() {
        val later = p(1, "a", at(21, 0), at(22, 0), dvr = Dvr("u", "failed"))
        assertEquals("Recording failed", recordingLabel(later.dvr!!))
        assertFalse(later.markedRecording())
        assertNull(recordAction(later, now, canRecord = true))
    }

    @Test
    fun `Record series for accounts allowed to, Cancel for one a series recording made`() {
        val later = p(1, "a", at(21, 0), at(22, 0))
        val over = p(3, "a", at(19, 0), at(20, 0))
        assertEquals(SeriesAction.Record, seriesAction(later, now, canRecordSeries = true))
        assertNull(seriesAction(later, now, canRecordSeries = false))
        assertNull(seriesAction(over, now, canRecordSeries = true))
        // A single recording of theirs can still become a series recording; someone else's holds the programme.
        assertEquals(SeriesAction.Record, seriesAction(later.copy(dvr = Dvr("u", "scheduled")), now, canRecordSeries = true))
        assertNull(seriesAction(later.copy(dvr = Dvr("u", "scheduled", canChange = false)), now, canRecordSeries = true))
        // Theirs to cancel even if they may no longer set new ones.
        assertEquals(SeriesAction.Cancel, seriesAction(later.copy(dvr = Dvr("u", "scheduled", series = "rule")), now, canRecordSeries = false))
        assertEquals(SeriesAction.Cancel, seriesAction(later.copy(dvr = Dvr("u", "skipped", series = "rule")), now, canRecordSeries = true))
        assertNull(seriesAction(later.copy(dvr = Dvr("u", "scheduled", canChange = false, series = "rule")), now, canRecordSeries = true))
    }

    @Test
    fun `a show's own name, and what cancelling a series recording says`() {
        assertEquals("Mock The Week", showName("New: Mock The Week"))
        assertEquals("Mock The Week", showName("new:Mock The Week"))
        assertEquals("News", showName("News"))
        assertEquals("New Tricks", showName("New Tricks"))
        assertTrue(cancelSeriesText("News").endsWith("already recorded stays."))
        assertTrue(cancelSeriesText("News", true, "kid").endsWith("kid set it."))
        assertTrue(cancelSeriesText("News", true).endsWith("It wasn’t set through Reelhouse."))
    }

    @Test
    fun `left open, today's guide moves on with the time`() {
        // Opened at 16:02 (from 15:30), still open at 19:07: the start moves on to 18:30, six hours loaded from it.
        val opened = at(15, 30)
        assertEquals(at(18, 30) to at(18, 30) + CHUNK, followNow(opened, opened + CHUNK, at(19, 7)))
        // More already loaded stays loaded.
        assertEquals(at(16, 0) to at(23, 30), followNow(opened, at(23, 30), at(16, 35)))
        // Within the same half hour nothing moves.
        assertNull(followNow(opened, opened + CHUNK, at(16, 29)))
    }

    @Test
    fun `past midnight, the day picked keeps its date`() {
        assertEquals(1, dayNow(1, at(23, 50), at(23, 55), zone)) // the same day: no change
        assertEquals(0, dayNow(1, at(23, 50), at(0, 10, day = 30), zone)) // tomorrow is now today
        assertEquals(2, dayNow(3, at(23, 50), at(0, 10, day = 30), zone))
        assertEquals(0, dayNow(0, at(23, 50), at(0, 10, day = 30), zone)) // today stays today (it follows the time)
    }
}
