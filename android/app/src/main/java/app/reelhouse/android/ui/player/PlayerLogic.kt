// The player's decisions that don't need a player: kept apart so they can be tested on the JVM.
package app.reelhouse.android.ui.player

import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.TrackSelectionParameters
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.data.playback.AudioTrack
import app.reelhouse.android.data.playback.Chapter
import app.reelhouse.android.data.playback.PlaybackInfo
import app.reelhouse.android.data.playback.Quality
import app.reelhouse.android.data.playback.SubtitleTrack
import java.util.Locale

/** The quality to ask for: what was picked for this place, else the original at home and the server's default away. */
fun chooseQuality(atHome: Boolean, picked: String?, remoteDefault: String): String = picked ?: if (atHome) "original" else remoteDefault

/**
 * Subtitles start as Settings → Languages says ([subtitleToShow]). Media3 would show the subtitle track a file marks
 * as its default, and one it marks as forced (the parts in another language); it's told to follow neither, and only
 * those in the language of Android's caption setting (when that's on) still come on by themselves, unless subtitles
 * start off altogether ([followCaptionSetting]). The film player puts the chosen track on itself: forced ones only
 * when they're believed, as some files flag their only, full track forced. A pick in the player carries on to the
 * next episode (PlayerViewModel's subtitleWish).
 */
fun subtitlesOffAtFirst(params: TrackSelectionParameters): TrackSelectionParameters =
    params.buildUpon().setIgnoredTextSelectionFlags(C.SELECTION_FLAG_DEFAULT or C.SELECTION_FLAG_FORCED).build()

/**
 * Whether Media3 may turn on subtitles in the language of Android's caption setting ([captionLanguages] and
 * [captionRoles], as the player started with them): not when Reelhouse says subtitles start off, forced ones too.
 */
fun followCaptionSetting(
    params: TrackSelectionParameters,
    follow: Boolean,
    captionLanguages: List<String>,
    captionRoles: Int,
): TrackSelectionParameters = params.buildUpon()
    .setPreferredTextLanguages(*(if (follow) captionLanguages else emptyList()).toTypedArray())
    .setPreferredTextRoleFlags(if (follow) captionRoles else 0)
    .build()

/** A subtitle track as the player has it, for [subtitleToShow]. */
data class TextTrackFacts(
    val language: String?,
    val label: String?,
    /** Flagged forced: by the file, or by the server for the tracks it hands over. */
    val forced: Boolean,
    val isDefault: Boolean = false,
    /** Handed over by the server, which already decided whether its forced flag is believed. */
    val fromServer: Boolean = false,
    /** For the deaf and hard of hearing (sound effects too): after a language's full track. */
    val sdh: Boolean = false,
)

/** How subtitles start (Settings → Languages): the server's mode and every code of the preferred language. */
data class SubtitlePrefs(val mode: String = "forced", val codes: List<String> = emptyList())

// As the server's (server/media/forced.js): a title that says the track is only some parts.
private val FORCED_TITLE = Regex("forced|foreign|signs|songs|parts|non[ -]?english|narrative", RegexOption.IGNORE_CASE)

// A title that says a track is for the deaf and hard of hearing.
private val SDH_TITLE = Regex("""\bsdh\b|hearing[ -]impaired|\bcc\b""", RegexOption.IGNORE_CASE)

/** Whether a track's title says it's for the deaf and hard of hearing. */
fun sdhTitle(title: String?): Boolean = SDH_TITLE.containsMatchIn(title.orEmpty())

/** A language as the server's codes list it: lower case, no region ("en-US" → "en"). */
fun plainLanguage(code: String?): String = code.orEmpty().trim().lowercase(Locale.ROOT).split('-', '_').first()

/** Whether a track's language is one of the server's codes for a language. */
fun inCodes(code: String?, codes: List<String>): Boolean = plainLanguage(code).let { it.isNotEmpty() && it in codes }

/**
 * Whether a track flagged forced really is forced subtitles (only the parts in another language), as the server
 * decides it: its title says so, or an ordinary track in the same language sits beside it. A release of The Big Bang
 * Theory flags its only, full English track forced, which would otherwise come on for every episode.
 */
fun believedForced(track: TextTrackFacts, all: List<TextTrackFacts>): Boolean {
    if (!track.forced) return false
    if (track.fromServer || FORCED_TITLE.containsMatchIn(track.label.orEmpty())) return true
    return all.any { it !== track && !it.forced && it.language == track.language }
}

/** The track to turn on in a language (its place), a full one before SDH and never a forced one; -1 for none. */
fun preferredSubtitle(tracks: List<TextTrackFacts>, codes: List<String>): Int {
    val same = tracks.withIndex().filter { inCodes(it.value.language, codes) && !believedForced(it.value, tracks) }
    return (same.firstOrNull { !it.value.sdh } ?: same.firstOrNull())?.index ?: -1
}

/**
 * The track to show when nothing was picked or carried on (its place in [tracks]), or -1 for none, as the web app
 * and the Kodi add-on choose: none for "off"; for "always", or "foreign" while the sound is in another language than
 * the preferred one, a track in that language; else (and for "forced") a believed forced one in the sound's
 * language, or one marked as the default.
 */
fun subtitleToShow(tracks: List<TextTrackFacts>, audioLanguage: String?, prefs: SubtitlePrefs = SubtitlePrefs()): Int {
    if (prefs.mode == "off") return -1
    val audio = plainLanguage(audioLanguage)
    val known = audio.isNotEmpty() && audio != "und"
    if (prefs.mode == "always" || (prefs.mode == "foreign" && known && !inCodes(audio, prefs.codes))) {
        val k = preferredSubtitle(tracks, prefs.codes)
        if (k >= 0) return k
    }
    val forced = tracks.withIndex().filter { believedForced(it.value, tracks) }
    val pick = forced.firstOrNull { known && plainLanguage(it.value.language) == audio }
        ?: forced.firstOrNull { it.value.isDefault }
    return pick?.index ?: -1
}

/**
 * Where to start: the resume point, unless it's within the last 30 s. A watched item that's being watched again
 * has one too (the server keeps the watched mark and saves positions from 30 s on).
 */
fun resumePoint(item: Item): Double {
    val pos = item.state.position
    val duration = item.duration ?: return pos.coerceAtLeast(0.0)
    return if (pos > 0 && pos < duration - 30) pos else 0.0
}

// ---------- chapters (as the web player, web/js/chapters.js) ----------

/** Back within this many seconds of a chapter's start goes to the chapter before; later, to the start of its own. */
const val CHAPTER_RESTART_SECONDS = 3.0

// A position this little before a chapter's start counts as in it: a seek lands a moment either side.
private const val CHAPTER_SLACK = 0.5

/** Where a chapter button goes: the chapter (its index) and its start in seconds. */
data class ChapterTarget(val index: Int, val start: Double)

/** The chapters worth buttons: in order, and at least two of them (else none). */
fun usableChapters(list: List<Chapter>?): List<Chapter> {
    val chapters = list.orEmpty().filter { it.start.isFinite() }.sortedBy { it.start }
    return if (chapters.size >= 2) chapters else emptyList()
}

/** The chapter playing at [position] (its index), or -1 before the first. */
fun chapterIndex(chapters: List<Chapter>, position: Double): Int = chapters.indexOfLast { it.start <= position + CHAPTER_SLACK }

/** Where "next chapter" goes, or null in the last chapter. */
fun nextChapter(chapters: List<Chapter>, position: Double): ChapterTarget? {
    val index = chapters.indexOfFirst { it.start > position + CHAPTER_SLACK }
    return if (index < 0) null else ChapterTarget(index, chapters[index].start)
}

/** Where "previous chapter" goes: the start of the chapter playing, or of the one before it just after a start. */
fun previousChapter(chapters: List<Chapter>, position: Double): ChapterTarget {
    val i = chapterIndex(chapters, position)
    if (i < 0) return ChapterTarget(0, 0.0)
    val index = if (i > 0 && position - chapters[i].start < CHAPTER_RESTART_SECONDS) i - 1 else i
    return ChapterTarget(index, chapters[index].start)
}

// Titles that only repeat the number or the time ("Chapter 03", "Chapitre 3", "12", "00:05:12.000") say nothing new.
private val PLAIN_CHAPTER_TITLE = Regex("""^(?:\p{L}+\.?\s*)?\d+$|^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?$""")

/** A chapter's own title, or null when it has none worth showing. */
fun chapterTitle(chapter: Chapter): String? = chapter.title?.trim()?.takeIf { it.isNotEmpty() && !PLAIN_CHAPTER_TITLE.matches(it) }

/** "Chapter 3 of 12 · The Heist" (the title only when it says something). */
fun chapterLabel(chapters: List<Chapter>, index: Int): String =
    "Chapter ${index + 1} of ${chapters.size}" + (chapterTitle(chapters[index])?.let { " · $it" } ?: "")

/** The qualities to offer: those the server lists for the file (the original and presets below it), else all. */
fun offeredQualities(all: List<Quality>, forFile: List<String>): List<Quality> =
    if (forFile.isEmpty()) all else all.filter { it.id in forFile }

/** What to do about a playback error. */
enum class Recovery {
    /** The phone can't decode or read the file after all: ask the server to convert it. */
    Convert,

    /** The connection dropped (or the route changed): find a route and carry on. */
    Reconnect,

    /** The server lost the conversion (e.g. after a long pause): ask again. */
    Restart,

    /** Nothing more to try. */
    Fail,
}

fun recoveryFor(errorCode: Int, converted: Boolean, forced: Boolean): Recovery = when (errorCode) {
    PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
    PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
    PlaybackException.ERROR_CODE_DECODING_FAILED,
    PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
    PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
    PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
    PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
    PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED,
    -> if (!converted && !forced) Recovery.Convert else Recovery.Fail

    PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
    PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
    PlaybackException.ERROR_CODE_TIMEOUT,
    PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
    -> Recovery.Reconnect

    PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
    PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND,
    PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
    -> Recovery.Restart

    else -> Recovery.Fail
}

/**
 * Whether a file played as it is has gone on long enough without a picture to give up on it, like the web
 * player's check: Media3 plays a file whose video it can't decode as sound alone, without an error. Only time spent
 * playing on screen counts (without a surface no frames are drawn, on purpose), and seeking back starts again.
 */
class PictureWatch(private val waitMs: Long = 3_000) {
    private var fromMs = -1L

    /** Fed regularly until the first frame is shown; true once [waitMs] of the file has played without one. */
    fun noPicture(playingOnScreen: Boolean, positionMs: Long): Boolean {
        if (!playingOnScreen) {
            fromMs = -1
            return false
        }
        if (fromMs < 0 || positionMs < fromMs) {
            fromMs = positionMs
            return false
        }
        return positionMs - fromMs >= waitMs
    }
}

/** ISO 639-2 "bibliographic" codes, which files often carry, mapped to the two-letter codes Locale knows. */
private val BIBLIOGRAPHIC = mapOf(
    "fre" to "fr", "ger" to "de", "chi" to "zh", "dut" to "nl", "gre" to "el", "per" to "fa", "rum" to "ro", "slo" to "sk",
    "cze" to "cs", "ice" to "is", "mac" to "mk", "may" to "ms", "alb" to "sq", "arm" to "hy", "baq" to "eu", "bur" to "my",
    "geo" to "ka", "wel" to "cy", "tib" to "bo",
)

/** Two-letter codes by their three-letter (ISO 639-2/T) forms, e.g. "eng" → "en". */
private val THREE_LETTER: Map<String, String> by lazy {
    Locale.getISOLanguages().associateBy { runCatching { Locale.forLanguageTag(it).isO3Language }.getOrDefault("") }
}

/** "English" for en, eng or fre-style codes; the code itself when unknown; null for none or "und". */
fun languageName(code: String?): String? {
    val c = code?.trim()?.lowercase()?.takeIf { it.isNotEmpty() && it != "und" } ?: return null
    val base = c.substringBefore('-')
    val two = when {
        base.length == 3 -> BIBLIOGRAPHIC[base] ?: THREE_LETTER[base] ?: base
        else -> base
    }
    val name = Locale.forLanguageTag(two).getDisplayLanguage(Locale.getDefault())
    return if (name.isNullOrBlank() || name.equals(two, ignoreCase = true)) c.uppercase() else name
}

fun channelsLabel(n: Int?): String? = when (n) {
    null, 0 -> null
    1 -> "Mono"
    2 -> "Stereo"
    6 -> "5.1"
    8 -> "7.1"
    else -> "$n ch"
}

fun audioLabel(a: AudioTrack): String =
    listOfNotNull(languageName(a.language) ?: "Unknown language", a.title?.takeIf { it.isNotBlank() }, a.codec?.uppercase(), channelsLabel(a.channels))
        .distinct().joinToString(" · ")

fun subtitleLabel(s: SubtitleTrack): String =
    listOfNotNull(
        languageName(s.language) ?: "Unknown language",
        s.title?.takeIf { it.isNotBlank() },
        "Forced".takeIf { s.forced },
        "File".takeIf { s.external },
    ).distinct().joinToString(" · ")

/** One line for the top bar: how the item is being played, and why it's converted. */
fun playbackSummary(info: PlaybackInfo, qualityLabel: String?): String =
    if (info.mode == "download") "Downloaded"
    else if (!info.converted) "Direct play" + (qualityLabel?.let { " · $it" } ?: "")
    else "Converting" + (qualityLabel?.let { " · $it" } ?: "") +
        info.reasons.takeIf { it.isNotEmpty() }?.let { " (${it.joinToString(", ")})" }.orEmpty()
