package app.reelhouse.android.ui.recordings

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.data.model.Recording
import app.reelhouse.android.data.model.RecordingCounts
import app.reelhouse.android.data.model.RecordingSeason
import app.reelhouse.android.data.model.RecordingShow
import app.reelhouse.android.data.model.RecordingsDrive
import app.reelhouse.android.data.model.SeriesRecording
import app.reelhouse.android.data.model.RecordingsResponse
import app.reelhouse.android.data.model.User
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class RecordingsLogicTest {
    private val now = Instant.parse("2026-11-01T12:00:00Z").epochSecond
    private val utc = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.of("UTC"))
    private val timeOf = { t: Long -> utc.format(Instant.ofEpochSecond(t)) }
    private val one = Channel("a".repeat(32), "Test One", number = 1.0)
    private val news = Recording(
        uuid = "u1", state = "scheduled", title = "News", channel = one,
        start = Instant.parse("2026-11-01T18:00:00Z").epochSecond, stop = Instant.parse("2026-11-01T18:30:00Z").epochSecond,
        owner = User(2, "kid"), mine = true, canChange = true,
    )

    @Test
    fun `the recordings drive reads as on the web, and warns under a tenth free`() {
        val gb = 1024L * 1024 * 1024
        val drive = RecordingsDrive(free = 400 * gb, total = 2048 * gb, recordings = 12 * gb)
        assertEquals("400.00 GB free of 2.00 TB", driveLine(drive))
        assertEquals("Recordings take up 12.00 GB", driveHint(drive))
        assertEquals(0.8f, driveUsed(drive), 0.01f)
        assertFalse(driveLow(drive))
        assertTrue(driveLow(drive.copy(free = 100 * gb)))
        assertEquals("No recordings yet", driveHint(drive.copy(recordings = 0)))
        assertNull(driveHint(drive.copy(recordings = null)))
        assertEquals("0 B free of 2.00 TB", driveLine(drive.copy(free = 0)))
        // An older Reelhouse doesn't send it.
        assertNull(AppJson.decodeFromString<RecordingsResponse>("{}").drive)
        assertEquals(drive.copy(recordings = null), AppJson.decodeFromString<RecordingsResponse>(
            """{"drive":{"free":${400 * gb},"total":${2048 * gb}}}""").drive)
    }

    @Test
    fun `a cover in a section says who set what's in it, each person once`() {
        val sam = User(3, "sam")
        val show = RecordingShow(
            key = "news", title = "News",
            seasons = listOf(
                RecordingSeason(season = 1, recordings = listOf(
                    news.copy(uuid = "a", state = "recorded"),
                    news.copy(uuid = "b", state = "failed", owner = sam),
                    news.copy(uuid = "c", state = "recorded"),
                )),
                RecordingSeason(season = 2, recordings = listOf(
                    news.copy(uuid = "d", state = "scheduled", owner = sam),
                    news.copy(uuid = "e", state = "scheduled", owner = null),
                    news.copy(uuid = "f", state = "recording", owner = null),
                )),
            ),
        )
        assertEquals(listOf("a", "b", "c"), sectionRecordings(ShowSection.Recorded, show).map { it.uuid })
        assertEquals(listOf("kid", "sam"), recordingOwners(sectionRecordings(ShowSection.Recorded, show)).map { it.username })
        assertEquals(listOf("sam"), recordingOwners(sectionRecordings(ShowSection.Scheduled, show)).map { it.username })
        assertEquals(emptyList<User>(), recordingOwners(sectionRecordings(ShowSection.Now, show)))
    }

    @Test
    fun `a recording under way with a problem says what's wrong, and one going to plan doesn't`() {
        val running = news.copy(state = "recording", status = "Running")
        assertNull(recordingTrouble(running))
        assertEquals("Waiting for stream", recordingTrouble(running.copy(status = "Waiting for stream", problem = true)))
    }

    @Test
    fun `a series recording's line says what's next`() {
        val s = SeriesRecording("r", "news", "News", channel = one)
        assertEquals("Nothing scheduled yet", seriesLine(s, now, timeOf))
        val next = s.copy(next = Instant.parse("2026-11-01T21:00:00Z").epochSecond)
        assertEquals("Next: Today, 21:00", seriesLine(next, now, timeOf))
        assertEquals("Today, 21:00", seriesLine(next, now, timeOf, word = ""))
        assertEquals("Recording now", seriesLine(s.copy(counts = RecordingCounts(recording = 1), next = now + 3600), now, timeOf))
    }

    @Test
    fun `each state offers its action, and someone else's none`() {
        assertEquals(RecordingAction.Cancel, recordingAction(news))
        assertEquals(RecordingAction.Stop, recordingAction(news.copy(state = "recording")))
        assertEquals(RecordingAction.Delete, recordingAction(news.copy(state = "recorded")))
        assertEquals(RecordingAction.Delete, recordingAction(news.copy(state = "failed")))
        assertNull(recordingAction(news.copy(canChange = false)))
        // One a series recording made is skipped rather than cancelled, by the same call.
        assertEquals(RecordingAction.Skip, recordingAction(news.copy(series = "rule")))
        assertEquals("cancel", RecordingAction.Skip.action)
        assertEquals(RecordingAction.Stop, recordingAction(news.copy(state = "recording", series = "rule")))
        assertEquals("delete", RecordingAction.Delete.action)
    }

    @Test
    fun `deleting always asks first, stopping or cancelling only someone else's`() {
        assertTrue(actionNeedsConfirming(news, RecordingAction.Delete))
        assertFalse(actionNeedsConfirming(news, RecordingAction.Cancel))
        assertTrue(actionNeedsConfirming(news.copy(mine = false), RecordingAction.Cancel))
        assertTrue(actionNeedsConfirming(news.copy(mine = false, owner = null), RecordingAction.Stop))
    }

    @Test
    fun `a show's lines, as the web app writes them`() {
        val show = RecordingShow(key = "news", title = "News", counts = RecordingCounts(recording = 1, scheduled = 2, recorded = 5))
        assertEquals("1 recording now · 2 scheduled · 5 recorded", countsLine(show.counts))
        assertEquals("", countsLine(RecordingCounts()))
        assertEquals("Recording now", showCardLine(show.copy(recordingNow = true)))
        assertEquals("2 scheduled · 5 recorded", showCardLine(show))
        assertEquals("Episode 4 · Part 5", episodeLine(news.copy(episode = 4, subtitle = "Part 5")))
        assertEquals("Part 5", episodeLine(news.copy(subtitle = "Part 5")))
        assertEquals("News", episodeLine(news))
        val one = RecordingSeason(1, recordings = listOf(news))
        val loose = RecordingSeason(null, recordings = listOf(news, news))
        assertEquals("Series 1", seriesName(one, show.copy(seasons = listOf(one, loose))))
        assertEquals("Other recordings", seriesName(loose, show.copy(seasons = listOf(one, loose))))
        assertEquals("Recordings", seriesName(loose, show.copy(seasons = listOf(loose))))
        assertEquals("series 1 of “News”", seriesWhat(one, show))
        assertEquals("the other recordings of “News”", seriesWhat(loose, show))
        assertEquals("Today, 18:00 · 30 min · 1.2 GB", episodeCardLine(news.copy(size = 1_200_000_000), now, timeOf))
    }

    @Test
    fun `the rows as on Home - recording now, recorded newest first, scheduled soonest first, empty ones left out`() {
        val t = news.start
        val a = RecordingShow(key = "a", title = "A", counts = RecordingCounts(recorded = 2), latest = t - 100)
        val b = RecordingShow(key = "b", title = "B", counts = RecordingCounts(recording = 1, scheduled = 3), recordingNow = true,
            latest = t, nextScheduled = t + 7200)
        val c = RecordingShow(key = "c", title = "C", counts = RecordingCounts(scheduled = 1, failed = 1), latest = t - 50, nextScheduled = t + 600)
        assertEquals(
            listOf(ShowSection.Now to listOf("b"), ShowSection.Recorded to listOf("c", "a"), ShowSection.Scheduled to listOf("c", "b")),
            showSections(listOf(a, b, c)).map { (section, shows) -> section to shows.map { it.key } },
        )
        assertEquals(listOf(ShowSection.Recorded), showSections(listOf(a)).map { it.first })
        assertEquals("Recording now", showSectionLine(ShowSection.Now, b, now, timeOf))
        assertEquals("2 recorded", showSectionLine(ShowSection.Recorded, a, now, timeOf))
        assertEquals("Today, 20:00", showSectionLine(ShowSection.Scheduled, b, now, timeOf))
        assertEquals("Today, 18:10", showSectionLine(ShowSection.Scheduled, c, now, timeOf))
    }

    @Test
    fun `deleting a series or a show takes its recorded episodes, says whose and that the rest keep recording`() {
        val recs = listOf(
            news.copy(uuid = "a", state = "recorded"), news.copy(uuid = "b", state = "failed", mine = false),
            news.copy(uuid = "c", state = "recorded", canChange = false), news.copy(uuid = "d"), news.copy(uuid = "e", state = "recording"),
        )
        assertEquals(listOf("a", "b"), deletable(recs).map { it.uuid })
        assertEquals(
            "All 2 of its recordings will be deleted from Tvheadend’s recordings drive. This can’t be undone. 1 of them was set by " +
                "someone else. The 2 still to come keep recording.",
            deleteManyText(recs),
        )
        assertEquals(
            "Its recording will be deleted from Tvheadend’s recordings drive. This can’t be undone.",
            deleteManyText(listOf(news.copy(state = "recorded"))),
        )
    }

    @Test
    fun `the line under the title has the channel, day and time, length, and size once there is one`() {
        assertEquals("1 · Test One · Today, 18:00–18:30 · 30 min", recordingMeta(news, now, timeOf))
        assertEquals("1 · Test One · Today, 18:00–18:30 · 30 min · 350 MB so far", recordingMeta(news.copy(state = "recording", size = 350_000_000), now, timeOf))
        assertEquals("Today, 18:00–18:30 · 30 min · 1.2 GB", recordingMeta(news.copy(state = "recorded", size = 1_200_000_000, channel = null), now, timeOf))
    }

    @Test
    fun `Tvheadend's word shows when a recording didn't go to plan`() {
        assertNull(recordingTrouble(news.copy(state = "recorded", status = "Completed OK")))
        assertEquals("File missing", recordingTrouble(news.copy(state = "recorded", status = "File missing")))
        assertEquals("Time missed", recordingTrouble(news.copy(state = "failed", status = "Time missed")))
        assertNull(recordingTrouble(news.copy(status = "Scheduled for recording")))
    }

    @Test
    fun `the server's answer decodes, the fields the screen doesn't use ignored`() {
        // As the dev server gave it from a real Tvheadend (shortened).
        val json = """{"recordings":[{"uuid":"98e3b6abb47b94e6d92d251cbfe2a009","state":"recording","title":"News","subtitle":"Part 5",
            "description":"News on Test One","channel":{"uuid":"929ca325297cbf5d6147ca8b21020f69","name":"Test One","number":1,"radio":false,
            "icon":"/api/livetv/channels/929ca325297cbf5d6147ca8b21020f69/icon?v=1"},"channelName":"Test One","start":1793493000,
            "stop":1793494800,"size":1345328,"status":"Running","eventId":1706,"owner":{"id":1,"username":"tester","avatar":null},
            "mine":true,"canChange":true},{"uuid":"e1","state":"scheduled","title":"Old","channel":null,"start":1,"stop":2,"size":null,
            "status":"Scheduled for recording","owner":null,"mine":false,"canChange":true}],"everyone":true,
            "shows":[{"key":"news","title":"News","poster":"/api/tmdb-image/poster/n.jpg","channel":null,"counts":{"recording":1,
            "scheduled":0,"recorded":0,"failed":0},"recordingNow":true,"latest":1793493000,"seasons":[{"season":1,"recordings":[
            {"uuid":"98e3","state":"recording","title":"News","start":1,"stop":2,"season":1,"episode":5,"still":"/api/tmdb-image/thumb/s.jpg"}],
            "poster":"/api/tmdb-image/poster/s1.jpg","counts":{"recording":1,"scheduled":0,"recorded":0,"failed":0}}]}]}"""
        val r = AppJson.decodeFromString(RecordingsResponse.serializer(), json)
        assertTrue(r.everyone)
        assertEquals(listOf("recording", "scheduled"), r.recordings.map { it.state })
        assertEquals("1 · Test One", r.recordings[0].channel?.let { "${it.numberLabel} · ${it.name}" })
        assertEquals(1345328L, r.recordings[0].size)
        assertEquals("tester", r.recordings[0].owner?.username)
        assertNull(r.recordings[1].owner)
        val show = r.shows.single()
        assertEquals(Triple("News", true, "/api/tmdb-image/poster/n.jpg"), Triple(show.title, show.recordingNow, show.poster))
        assertEquals(listOf(1 to 5), show.seasons.flatMap { s -> s.recordings.map { s.season to it.episode } })
        assertEquals("/api/tmdb-image/poster/s1.jpg", show.seasons[0].poster)
        assertEquals(1, show.seasons[0].counts.recording)
        assertEquals("/api/tmdb-image/thumb/s.jpg", show.seasons[0].recordings[0].still)
    }
}
