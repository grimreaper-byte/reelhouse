// The player's decisions that don't need a player: kept apart so they can be tested on the JVM.
package app.reelhouse.android.ui.player

import androidx.media3.common.PlaybackException
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
