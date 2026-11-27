package app.reelhouse.android.ui.player

import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.TrackSelectionParameters
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

    @Test
    fun `subtitles start off, Media3 follows neither a file's default flag nor its forced one`() {
        val params = subtitlesOffAtFirst(TrackSelectionParameters.Builder().setPreferredAudioLanguage("en").build())
        assertEquals(C.SELECTION_FLAG_DEFAULT or C.SELECTION_FLAG_FORCED, params.ignoredTextSelectionFlags)
        assertEquals(listOf("en"), params.preferredAudioLanguages) // the rest is kept
        assertTrue(params.disabledTrackTypes.isEmpty())
    }

    @Test
    fun `a lone track flagged forced is an ordinary one, so subtitles stay off`() {
        // As The Big Bang Theory's: its only, full English track flagged forced (and default), named "English".
        val lone = TextTrackFacts(language = "en", label = "English", forced = true, isDefault = true)
        assertFalse(believedForced(lone, listOf(lone)))
        assertEquals(-1, subtitleToShow(listOf(lone), audioLanguage = "en"))
        val french = TextTrackFacts(language = "fr", label = "Français", forced = false)
        assertEquals("another language doesn't make it forced", -1, subtitleToShow(listOf(lone, french), audioLanguage = "en"))
    }

    @Test
    fun `forced parts beside a full track show for the audio's language, or when marked the default`() {
        val full = TextTrackFacts(language = "en", label = "English", forced = false)
        val parts = TextTrackFacts(language = "en", label = null, forced = true)
        assertTrue(believedForced(parts, listOf(full, parts)))
        assertFalse(believedForced(full, listOf(full, parts)))
        assertEquals(1, subtitleToShow(listOf(full, parts), audioLanguage = "en"))
        assertEquals("English parts aren't for French sound", -1, subtitleToShow(listOf(full, parts), audioLanguage = "fr"))
        assertEquals(1, subtitleToShow(listOf(full, parts.copy(isDefault = true)), audioLanguage = null))
        assertEquals("nothing forced: off", -1, subtitleToShow(listOf(full), audioLanguage = "en"))
    }

    @Test
    fun `a title that says so is believed, and so is the server's flag on the tracks it hands over`() {
        for (title in listOf("English (Forced)", "Foreign parts", "Signs & Songs", "Non-English parts")) {
            val t = TextTrackFacts(language = "en", label = title, forced = true)
            assertEquals(title, 0, subtitleToShow(listOf(t), audioLanguage = "en"))
        }
        val handed = TextTrackFacts(language = "en", label = "English", forced = true, fromServer = true)
        assertEquals(0, subtitleToShow(listOf(handed), audioLanguage = "en"))
        val unflagged = TextTrackFacts(language = "en", label = "English", forced = false, fromServer = true)
        assertEquals(-1, subtitleToShow(listOf(unflagged), audioLanguage = "en"))
    }

    // Settings → Languages: how subtitles start, with the preferred language's codes (as the server sends them).
    private val en = listOf("en", "eng")
    private val fr = listOf("fr", "fre", "fra")
    private val full = TextTrackFacts(language = "en", label = "English", forced = false, isDefault = true)
    private val sdh = TextTrackFacts(language = "en", label = "English", forced = false, sdh = true)
    private val parts = TextTrackFacts(language = "en", label = "English (forced)", forced = true)
    private val french = TextTrackFacts(language = "fr", label = "Français", forced = false)
    private val all = listOf(sdh, full, parts, french)

    @Test
    fun `off shows nothing, forced parts included`() {
        assertEquals(-1, subtitleToShow(all, "en", SubtitlePrefs("off", en)))
    }

    @Test
    fun `always shows the preferred language's full track, before SDH and never a forced one`() {
        assertEquals(1, subtitleToShow(all, "en", SubtitlePrefs("always", en)))
        assertEquals(3, subtitleToShow(all, "en", SubtitlePrefs("always", fr)))
        assertEquals("SDH when it's the only full one", 0, subtitleToShow(listOf(sdh, parts), "en", SubtitlePrefs("always", en)))
        assertEquals("none in it: the forced parts, as usual", 2, subtitleToShow(all, "en", SubtitlePrefs("always", listOf("de", "ger", "deu"))))
    }

    @Test
    fun `foreign shows the preferred language only while the sound is in another one`() {
        assertEquals("French sound: English subtitles", 1, subtitleToShow(all, "fr", SubtitlePrefs("foreign", en)))
        assertEquals("English sound: the forced parts", 2, subtitleToShow(all, "en", SubtitlePrefs("foreign", en)))
        assertEquals("a region is the same language", 2, subtitleToShow(all, "en-us", SubtitlePrefs("foreign", en)))
        assertEquals("sound in an unknown language: as forced", -1, subtitleToShow(all, null, SubtitlePrefs("foreign", en)))
        assertEquals(-1, subtitleToShow(all, "und", SubtitlePrefs("foreign", en)))
    }

    @Test
    fun `older servers say nothing, so forced parts only`() {
        assertEquals(2, subtitleToShow(all, "en"))
        assertTrue(inCodes("ENG", en) && inCodes("en-GB", en) && !inCodes(null, en) && !inCodes("fre", en))
        assertTrue(sdhTitle("English (SDH)") && sdhTitle("Hearing Impaired") && !sdhTitle("English") && !sdhTitle(null))
    }

    @Test
    fun `Android's caption setting is followed unless subtitles start off`() {
        val start = TrackSelectionParameters.Builder().setPreferredTextLanguage("en").setPreferredTextRoleFlags(C.ROLE_FLAG_CAPTION).build()
        val off = followCaptionSetting(start, follow = false, captionLanguages = listOf("en"), captionRoles = C.ROLE_FLAG_CAPTION)
        assertTrue(off.preferredTextLanguages.isEmpty())
        assertEquals(0, off.preferredTextRoleFlags)
        val on = followCaptionSetting(off, follow = true, captionLanguages = listOf("en"), captionRoles = C.ROLE_FLAG_CAPTION)
        assertEquals(listOf("en"), on.preferredTextLanguages)
        assertEquals(C.ROLE_FLAG_CAPTION, on.preferredTextRoleFlags)
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
    fun `an error reading the file in its last seconds is its end - bytes after an MKV's segment`() {
        val io = PlaybackException.ERROR_CODE_IO_UNSPECIFIED // Media3's EOFException at the end of such a file
        // The Big Bang Theory 3x07 on the user's Fire TV: 1174.7 s long, the error once the position reached the end.
        assertTrue(errorAtTheEnd(io, 1180.0, 1174.72))
        assertTrue(errorAtTheEnd(io, 1162.0, 1174.72)) // within the last 15 s
        assertTrue(errorAtTheEnd(PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED, 39.0, 40.0))
        assertFalse(errorAtTheEnd(io, 600.0, 1174.72)) // part-way through: the usual recovery
        assertFalse(errorAtTheEnd(io, 1150.0, 1174.72))
        assertFalse(errorAtTheEnd(PlaybackException.ERROR_CODE_DECODING_FAILED, 1174.0, 1174.72)) // not reading the file
        assertFalse(errorAtTheEnd(io, 1174.0, null)) // the length isn't known
        assertFalse(errorAtTheEnd(io, 10.0, 0.0))
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
