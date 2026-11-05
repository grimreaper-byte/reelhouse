package app.reelhouse.android.ui.recordings

import app.reelhouse.android.data.model.Recording
import app.reelhouse.android.data.model.RecordingCounts
import app.reelhouse.android.data.model.RecordingSeason
import app.reelhouse.android.data.model.RecordingShow
import app.reelhouse.android.data.model.RecordingsDrive
import app.reelhouse.android.data.model.SeriesRecording
import app.reelhouse.android.data.model.User
import app.reelhouse.android.ui.common.formatSize
import app.reelhouse.android.ui.livetv.dayLabel
import app.reelhouse.android.ui.livetv.title

/** What a recording offers, as on the web: Stop (what's recorded stays), Cancel, or Delete (its file too). */
enum class RecordingAction(val action: String, val label: String, val done: String) {
    Stop("stop", "Stop", "Recording stopped"),
    Cancel("cancel", "Cancel", "Recording cancelled"),
    Delete("delete", "Delete", "Recording deleted"),
    /** An episode of a series recording, rather than Cancel: cancelled, Tvheadend would schedule it again. */
    Skip("cancel", "Skip", "Episode skipped"),
}

/** Stop while recording, Cancel (or Skip) while scheduled, Delete once recorded or failed; null for someone else's. */
fun recordingAction(r: Recording): RecordingAction? = if (!r.canChange) null else when (r.state) {
    "recording" -> RecordingAction.Stop
    "scheduled" -> if (r.series != null) RecordingAction.Skip else RecordingAction.Cancel
    "recorded", "failed" -> RecordingAction.Delete
    else -> null
}

/** Deleting always asks first (it can't be undone); stopping or cancelling only someone else's (an admin can). */
fun actionNeedsConfirming(r: Recording, action: RecordingAction): Boolean = action == RecordingAction.Delete || !r.mine

/** "1 · Test One · Today, 21:00–22:00 · 60 min · 1.2 GB so far" */
fun recordingMeta(r: Recording, now: Long, timeOf: (Long) -> String): String = listOfNotNull(
    r.channel?.title(),
    "${dayLabel(r.start, now)}, ${timeOf(r.start)}–${timeOf(r.stop)}",
    "${(r.stop - r.start) / 60} min",
    r.size?.let { formatSize(it) + if (r.state == "recording") " so far" else "" },
).joinToString(" · ")

/** Tvheadend's word for one that isn't going or didn't go to plan ("Waiting for stream", "Time missed"…), else null. */
fun recordingTrouble(r: Recording): String? = r.status?.takeIf { r.problem || r.state == "failed" || (r.state == "recorded" && it != "Completed OK") }

/** "1 recording now · 2 scheduled · 5 recorded", as much as there is. */
fun countsLine(c: RecordingCounts): String = listOfNotNull(
    c.recording.takeIf { it > 0 }?.let { "$it recording now" },
    c.scheduled.takeIf { it > 0 }?.let { "$it scheduled" },
    c.recorded.takeIf { it > 0 }?.let { "$it recorded" },
    c.failed.takeIf { it > 0 }?.let { "$it failed" },
).joinToString(" · ")

/**
 * The Manage Recordings sections, each left out when it has no shows: Recording now; Recorded, newest first;
 * Scheduled, soonest first. A show is in each section it has something for.
 */
enum class ShowSection(val title: String) { Now("Recording now"), Recorded("Recorded"), Scheduled("Scheduled") }

fun showSections(shows: List<RecordingShow>): List<Pair<ShowSection, List<RecordingShow>>> = listOf(
    ShowSection.Now to shows.filter { it.recordingNow },
    ShowSection.Recorded to shows.filter { it.counts.recorded + it.counts.failed > 0 }.sortedByDescending { it.latest },
    ShowSection.Scheduled to shows.filter { it.nextScheduled != null }.sortedBy { it.nextScheduled },
).filter { it.second.isNotEmpty() }

/** What a show has in a section: who set those is what its cover there says. */
fun sectionRecordings(section: ShowSection, show: RecordingShow): List<Recording> = show.seasons.flatMap { it.recordings }.filter {
    when (section) {
        ShowSection.Now -> it.state == "recording"
        ShowSection.Recorded -> it.state == "recorded" || it.state == "failed"
        ShowSection.Scheduled -> it.state == "scheduled"
    }
}

/** What a series recording is doing: recording, when the next one records ([word] in front: a cover has no room for it), or that none is yet. */
fun seriesLine(s: SeriesRecording, now: Long, timeOf: (Long) -> String, word: String = "Next: "): String = when {
    s.counts.recording > 0 -> "Recording now"
    s.next != null -> "$word${dayLabel(s.next, now)}, ${timeOf(s.next)}"
    else -> "Nothing scheduled yet"
}

/** Who set these recordings: each person once, as they come. */
fun recordingOwners(recs: List<Recording>): List<User> = recs.mapNotNull { it.owner }.distinctBy { it.id }

/** The line under a show's cover in a section: "Recording now", "3 recorded", or when its next one records (a cover is narrow, and that's what the row is for). */
fun showSectionLine(section: ShowSection, show: RecordingShow, now: Long, timeOf: (Long) -> String): String = when (section) {
    ShowSection.Now -> "Recording now"
    ShowSection.Recorded -> countsLine(RecordingCounts(recorded = show.counts.recorded, failed = show.counts.failed))
    ShowSection.Scheduled -> show.nextScheduled?.let { t -> "${dayLabel(t, now)}, ${timeOf(t)}" }.orEmpty()
}

/** The line under a show's poster: "Recording now", else what it has ("3 scheduled · 1 recorded"). */
fun showCardLine(show: RecordingShow): String = if (show.recordingNow) "Recording now" else countsLine(show.counts.copy(recording = 0))

/** Recorded and failed recordings this account may delete: what Delete series and Delete show take. */
fun deletable(recs: List<Recording>): List<Recording> = recs.filter { it.canChange && (it.state == "recorded" || it.state == "failed") }

/** How a recording is known on its show's page: "Episode 4 · Part 4", else its subtitle, else its title. */
fun episodeLine(r: Recording): String =
    listOfNotNull(r.episode?.let { "Episode $it" }, r.subtitle).joinToString(" · ").ifEmpty { r.title }

/** A series' name: "Series 1"; recordings without a number "Other recordings", or "Recordings" when none have one. */
fun seriesName(s: RecordingSeason, show: RecordingShow): String = when {
    s.season != null -> "Series ${s.season}"
    show.seasons.any { it.season != null } -> "Other recordings"
    else -> "Recordings"
}

/** What deleting a series is called in its question: "series 1 of “News”", or "the other recordings of “News”". */
fun seriesWhat(s: RecordingSeason, show: RecordingShow): String =
    if (s.season != null) "series ${s.season} of “${show.title}”" else "the other recordings of “${show.title}”"

/** The line under an episode's picture: "Today, 21:00 · 60 min · 1.2 GB". */
fun episodeCardLine(r: Recording, now: Long, timeOf: (Long) -> String): String = listOfNotNull(
    "${dayLabel(r.start, now)}, ${timeOf(r.start)}",
    "${(r.stop - r.start) / 60} min",
    r.size?.let { formatSize(it) },
).joinToString(" · ")

/** What Delete series / Delete show asks: how many go, whose, and that what's still to come keeps recording. */
fun deleteManyText(recs: List<Recording>): String {
    val gone = deletable(recs)
    val waiting = recs.count { it.state == "scheduled" || it.state == "recording" }
    val others = gone.count { !it.mine }
    return buildString {
        append(if (gone.size == 1) "Its recording" else "All ${gone.size} of its recordings")
        append(" will be deleted from Tvheadend’s recordings drive. This can’t be undone.")
        if (others > 0) {
            append(if (others == gone.size) " They were set by someone else." else " $others of them ${if (others == 1) "was" else "were"} set by someone else.")
        }
        if (waiting > 0) append(if (waiting == 1) " The one still to come keeps recording." else " The $waiting still to come keep recording.")
    }
}

/** A size on the recordings drive's line, written as the web app and Kodi write it: "372.53 GB", "1.82 TB". */
fun driveSize(bytes: Long): String {
    if (bytes <= 0) return "0 B"
    val units = listOf("B", "KB", "MB", "GB", "TB")
    var n = bytes.toDouble()
    var i = 0
    while (n >= 1024 && i < units.lastIndex) {
        n /= 1024
        i++
    }
    return "%.${if (i >= 3) 2 else if (i > 0) 1 else 0}f %s".format(n, units[i])
}

fun driveLine(d: RecordingsDrive): String = "${driveSize(d.free)} free of ${driveSize(d.total)}"

/** Under 10% free: a warning, and the bar in red. */
fun driveLow(d: RecordingsDrive): Boolean = d.free.toDouble() / d.total < 0.1

/** How full it is, 0 to 1, for the bar. */
fun driveUsed(d: RecordingsDrive): Float = ((d.total - d.free).toDouble() / d.total).coerceIn(0.0, 1.0).toFloat()

/** What recordings take up, when Tvheadend says. */
fun driveHint(d: RecordingsDrive): String? = d.recordings?.let { if (it > 0) "Recordings take up ${driveSize(it)}" else "No recordings yet" }
