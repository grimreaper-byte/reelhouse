package app.reelhouse.android.ui.player

import androidx.media3.common.PlaybackException
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.data.model.ItemState
import app.reelhouse.android.data.playback.AudioTrack
import app.reelhouse.android.data.playback.PlaybackInfo
import app.reelhouse.android.data.playback.Quality
import app.reelhouse.android.data.playback.SubtitleTrack
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class PlayerLogicTest {
    @Test
    fun `quality is the original at home and the server's default away, unless picked`() {
        assertEquals("original", chooseQuality(atHome = true, picked = null, remoteDefault = "4m-720"))
        assertEquals("4m-720", chooseQuality(atHome = false, picked = null, remoteDefault = "4m-720"))
        assertEquals("2m-720", chooseQuality(atHome = true, picked = "2m-720", remoteDefault = "4m-720"))
    }

    private fun item(position: Double, duration: Double?, watched: Boolean = false) =
        Item(id = 1, type = "movie", title = "x", duration = duration, state = ItemState(position = position, watched = watched))

    @Test
    fun `resume where it was left, unless it's finished or nearly so`() {
        assertEquals(600.0, resumePoint(item(600.0, 6000.0)), 0.0)
        assertEquals(0.0, resumePoint(item(5990.0, 6000.0)), 0.0) // the credits
        assertEquals(600.0, resumePoint(item(600.0, 6000.0, watched = true)), 0.0) // watching it again
        assertEquals(0.0, resumePoint(item(0.0, 6000.0, watched = true)), 0.0)
        assertEquals(0.0, resumePoint(item(0.0, 6000.0)), 0.0)
    }

    @Test
    fun `decoding trouble with the file itself asks for a conversion, once`() {
        val code = PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED
        assertEquals(Recovery.Convert, recoveryFor(code, converted = false, forced = false))
        assertEquals(Recovery.Fail, recoveryFor(code, converted = false, forced = true))
        assertEquals(Recovery.Fail, recoveryFor(code, converted = true, forced = false))
    }

    @Test
    fun `only the qualities the server lists for the file are offered`() {
        val all = listOf(Quality("original", "Original"), Quality("8m-1080", "1080p · 8 Mbps"), Quality("4m-720", "720p · 4 Mbps"))
        assertEquals(listOf("original", "4m-720"), offeredQualities(all, listOf("original", "4m-720", "720k-360")).map { it.id })
        assertEquals(listOf("original"), offeredQualities(all, listOf("original")).map { it.id })
        assertEquals(all, offeredQualities(all, emptyList())) // an older server doesn't say
    }

    @Test
    fun `no picture is only judged on 3 s of the file playing on screen`() {
        val w = PictureWatch(3_000)
        assertFalse(w.noPicture(playingOnScreen = true, positionMs = 600_000)) // starts the wait
        assertFalse(w.noPicture(playingOnScreen = true, positionMs = 602_000))
        assertFalse(w.noPicture(playingOnScreen = false, positionMs = 602_500)) // paused or in the background: wait again
        assertFalse(w.noPicture(playingOnScreen = true, positionMs = 602_500))
        assertFalse(w.noPicture(playingOnScreen = true, positionMs = 605_000))
        assertFalse(w.noPicture(playingOnScreen = true, positionMs = 10_000)) // sought back: wait again
        assertFalse(w.noPicture(playingOnScreen = true, positionMs = 12_900))
        assertTrue(w.noPicture(playingOnScreen = true, positionMs = 13_000))
    }

    @Test
    fun `network trouble reconnects, and a lost conversion starts again`() {
        assertEquals(Recovery.Reconnect, recoveryFor(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, converted = true, forced = false))
        assertEquals(Recovery.Restart, recoveryFor(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, converted = true, forced = false))
        assertEquals(Recovery.Fail, recoveryFor(PlaybackException.ERROR_CODE_DRM_UNSPECIFIED, converted = false, forced = false))
    }

    @Test
    fun `language codes become names, whichever form the file uses`() {
        Locale.setDefault(Locale.ENGLISH)
        assertEquals("English", languageName("eng"))
        assertEquals("English", languageName("en"))
        assertEquals("Spanish", languageName("spa"))
        assertEquals("French", languageName("fre")) // bibliographic form
        assertEquals("German", languageName("ger"))
        assertEquals("English", languageName("en-GB"))
        assertNull(languageName("und"))
        assertNull(languageName(""))
        assertEquals("QQQ", languageName("qqq"))
    }

    @Test
    fun `track and playback labels`() {
        Locale.setDefault(Locale.ENGLISH)
        assertEquals("English · AC3 · 5.1", audioLabel(AudioTrack(index = 1, codec = "ac3", channels = 6, language = "eng")))
        assertEquals("Unknown language · Director's commentary · AAC · Stereo", audioLabel(AudioTrack(index = 2, codec = "aac", channels = 2, title = "Director's commentary")))
        assertEquals("Spanish · Forced · File", subtitleLabel(SubtitleTrack(id = "x0", language = "spa", forced = true, external = true)))
        val direct = PlaybackInfo(playId = "p", mode = "direct", url = "/api/stream/1")
        assertEquals("Direct play · Original", playbackSummary(direct, "Original"))
        assertEquals("Downloaded", playbackSummary(PlaybackInfo(playId = "p", mode = "download", url = "/sdcard/x.mp4"), null))
        val hls = PlaybackInfo(playId = "p", mode = "hls", url = "/x.m3u8", reasons = listOf("ac3 audio"))
        assertTrue(playbackSummary(hls, "720p · 4 Mbps").startsWith("Converting · 720p · 4 Mbps (ac3 audio)"))
    }
}
