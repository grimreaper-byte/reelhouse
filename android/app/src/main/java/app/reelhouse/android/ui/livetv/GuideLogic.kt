package app.reelhouse.android.ui.livetv

import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.data.model.Dvr
import app.reelhouse.android.data.model.Programme
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

// The guide's rules, as the web app's (web/js/views/livetv.js): times are epoch seconds.

const val HALF_HOUR = 1800L
const val CHUNK = 6 * 3600L // hours loaded at a time
const val MAX_SPAN = 24 * 3600L // from a day's start

/** Where today's guide starts: the half hour before the current one, so what's on now shows whole. */
fun todayStart(now: Long): Long = Math.floorDiv(now - HALF_HOUR, HALF_HOUR) * HALF_HOUR

/**
 * Today's guide left open: its start moves on with the time ([todayStart]), so the programmes move left and the now
 * line stays near the left instead of drifting right; at least [CHUNK] loaded from it. Null while it hasn't moved.
 */
fun followNow(from: Long, to: Long, now: Long): Pair<Long, Long>? {
    val start = todayStart(now)
    return if (start <= from) null else start to maxOf(to, start + CHUNK)
}

/**
 * The day picked ([day] days from [then]'s date), counted from [now]'s date instead: past midnight, tomorrow's guide
 * is today's (never before today).
 */
fun dayNow(day: Int, then: Long, now: Long, zone: ZoneId = ZoneId.systemDefault()): Int {
    val passed = ChronoUnit.DAYS.between(Instant.ofEpochSecond(then).atZone(zone).toLocalDate(), Instant.ofEpochSecond(now).atZone(zone).toLocalDate())
    return maxOf(0, day - passed.toInt())
}

/** Midnight [offset] days from today. */
fun startOfDay(offset: Int, now: Long, zone: ZoneId = ZoneId.systemDefault()): Long =
    Instant.ofEpochSecond(now).atZone(zone).toLocalDate().plusDays(offset.toLong()).atStartOfDay(zone).toEpochSecond()

/** Whether more hours may be loaded after [to] for the day picked ([dayStart]): up to a day and an hour on. */
fun canLoadMore(to: Long, dayStart: Long): Boolean = to - dayStart < MAX_SPAN + 2 * HALF_HOUR

/** "Today", "Tomorrow", "Yesterday", else e.g. "Wednesday 29 Oct". */
fun dayLabel(t: Long, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    val day = Instant.ofEpochSecond(t).atZone(zone).toLocalDate()
    return when (ChronoUnit.DAYS.between(Instant.ofEpochSecond(now).atZone(zone).toLocalDate(), day)) {
        0L -> "Today"
        1L -> "Tomorrow"
        -1L -> "Yesterday"
        else -> day.format(DateTimeFormatter.ofPattern("EEEE d MMM", locale))
    }
}

/** A day chip's name: "Today", "Tomorrow", then the weekday. */
fun dayChip(offset: Int, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String = when (offset) {
    0 -> "Today"
    1 -> "Tomorrow"
    else -> Instant.ofEpochSecond(now).atZone(zone).toLocalDate().plusDays(offset.toLong()).format(DateTimeFormatter.ofPattern("EEEE", locale))
}

fun Programme.airing(now: Long) = start <= now && stop > now

fun Programme.past(now: Long) = stop <= now

/** How far through it is, 0..1. */
fun Programme.progress(now: Long): Float = ((now - start).toFloat() / max(1L, stop - start)).coerceIn(0f, 1f)

/** Whole minutes left while it's on (at least 1). */
fun Programme.minutesLeft(now: Long): Int = max(1, ((stop - now) / 60.0).roundToInt())

fun Programme.minutes(): Int = ((stop - start) / 60.0).roundToInt()

/** While it's on, how much is left of it; otherwise how long it is. */
fun Programme.lengthText(now: Long): String = if (airing(now)) "${minutesLeft(now)} min left" else "${minutes()} min"

/**
 * Its genre group, coloured in the guide as Kodi does: the first hex digit of its ETSI EN 300 468 content type
 * (1 film / drama, 2 news, 3 show / game show, 4 sport, 5 children's, 6 music, 7 arts, 8 social / political,
 * 9 education / science, 10 leisure / hobbies, 11 special characteristics), or null.
 */
fun Programme.genreGroup(): Int? = genre.map { it shr 4 }.firstOrNull { it in 1..11 }

/** "S2 · E5" as Reelhouse writes episodes elsewhere, else the guide's own label ("Series 3, Ep 2"). */
fun Programme.episodeText(): String? = when {
    season != null && episode != null -> "S$season · E$episode"
    episodeLabel != null -> episodeLabel
    episode != null -> "Episode $episode"
    else -> null
}

fun recordingLabel(dvr: Dvr): String = when (dvr.state) {
    "recording" -> "Recording now"
    "scheduled" -> if (dvr.series != null) "Series recording" else "Will be recorded"
    "skipped" -> "Skipped"
    "failed" -> "Recording failed"
    else -> "Recorded"
}

/** Whether the guide marks a programme as recording: not an episode of a series recording that's been skipped, or one that failed. */
fun Programme.markedRecording(): Boolean = dvr != null && dvr.state != "skipped" && dvr.state != "failed"

/** What can be done with a recording from the guide (for accounts allowed to record). */
enum class RecordAction(val label: String) {
    Record("Record"), Cancel("Cancel recording"), Stop("Stop recording"),
    /** An episode of a series recording: cancelled, Tvheadend would schedule it again. */
    Skip("Skip this episode"),
    /** One that was skipped, wanted after all. */
    Restore("Record"),
}

/**
 * Record, Cancel, Skip or Stop for a programme that isn't over; null when there's nothing to do (it's recorded, or someone
 * else set its recording: only they or an admin can change it).
 */
fun recordAction(p: Programme, now: Long, canRecord: Boolean): RecordAction? = when {
    !canRecord || p.past(now) -> null
    p.dvr == null -> RecordAction.Record
    !p.dvr.canChange -> null
    p.dvr.state == "recording" -> RecordAction.Stop
    p.dvr.state == "scheduled" -> if (p.dvr.series != null) RecordAction.Skip else RecordAction.Cancel
    p.dvr.state == "skipped" -> RecordAction.Restore
    else -> null
}

/** What can be done from the guide about a show's series recording. */
enum class SeriesAction(val label: String) { Record("Record series"), Cancel("Cancel series recording") }

/**
 * Cancel for a programme a series recording made (its person's or an admin's to change), Record series for the rest if
 * the account may set them; null when it's over, or someone else's recording holds it.
 */
fun seriesAction(p: Programme, now: Long, canRecordSeries: Boolean): SeriesAction? = when {
    p.past(now) || p.dvr?.canChange == false -> null
    p.dvr?.series != null -> SeriesAction.Cancel
    canRecordSeries -> SeriesAction.Record
    else -> null
}

/** A show's own name, as Reelhouse keeps it: without the "New: " UK guides put on new episodes. */
fun showName(title: String): String = title.replace(Regex("^\\s*new\\s*:\\s*", RegexOption.IGNORE_CASE), "")

/** What cancelling a series recording asks; [who] is who set it, when that isn't the person asking. */
fun cancelSeriesText(title: String, someoneElses: Boolean = false, who: String? = null): String =
    "New episodes of “$title” won’t be recorded any more, and what it has scheduled is cancelled. What’s recording now or already recorded stays." +
        if (someoneElses) " ${if (who != null) "$who set it" else "It wasn’t set through Reelhouse"}." else ""

/** One channel's row: its programmes in time order. */
data class GuideRow(val channel: Channel, val programmes: List<Programme>)

/** The channels in their order, each with its programmes. */
fun guideRows(channels: List<Channel>, events: List<Programme>): List<GuideRow> {
    val by = events.groupBy { it.channel }
    return channels.map { c -> GuideRow(c, by[c.uuid].orEmpty().sortedBy { it.start }) }
}

/** What's on now on a row, and what's next after it (or after now). */
fun GuideRow.nowAndNext(now: Long): Pair<Programme?, Programme?> {
    val current = programmes.firstOrNull { it.airing(now) }
    val next = programmes.firstOrNull { it.start >= (current?.stop ?: now) }
    return current to next
}

/** What's on now on the first channel with anything (else its next programme): highlighted before anything's tapped. */
fun firstHighlight(rows: List<GuideRow>, now: Long, from: Long): Programme? {
    for (row in rows) {
        val pick = row.programmes.firstOrNull { it.airing(now) }
            ?: row.programmes.firstOrNull { it.stop > max(now, from) }
            ?: row.programmes.firstOrNull()
        if (pick != null) return pick
    }
    return null
}

/** New programmes from a later window added to [events] (the same programme isn't listed twice). */
fun mergeEvents(events: List<Programme>, more: List<Programme>): List<Programme> {
    val seen = events.mapTo(HashSet()) { it.id }
    return events + more.filter { it.id !in seen }
}

/** A programme's place on the grid's time axis, in minutes from [from] (clipped to [from, to]). */
data class Span(val startMin: Float, val endMin: Float) {
    val lengthMin get() = endMin - startMin
}

fun Programme.span(from: Long, to: Long): Span =
    Span((max(start, from) - from) / 60f, (minOf(stop, to).coerceAtLeast(from) - from) / 60f)

/** The half hours along the top of the grid. */
fun halfHours(from: Long, to: Long): List<Long> = generateSequence(from) { it + HALF_HOUR }.takeWhile { it < to }.toList()
