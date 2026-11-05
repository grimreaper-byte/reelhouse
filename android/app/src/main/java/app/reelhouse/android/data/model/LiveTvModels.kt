package app.reelhouse.android.data.model

import kotlinx.serialization.Serializable

/** Live TV for this account, from GET /api/me (Settings → Live TV and the account's switches). */
@Serializable
data class LiveTvAccess(val available: Boolean = false, val canRecord: Boolean = false, val radio: Boolean = false)

/** A Tvheadend channel the account may watch (server/routes/livetv.js publicChannel). */
@Serializable
data class Channel(
    val uuid: String,
    val name: String,
    val number: Double? = null,
    val radio: Boolean = false,
    /** /api/livetv/channels/<uuid>/icon?v=…, or null when Tvheadend has no logo for it. */
    val icon: String? = null,
) {
    /** "7", or "7.1" for a sub-channel; null without a number. */
    val numberLabel: String? get() = number?.let { if (it % 1.0 == 0.0) it.toLong().toString() else it.toString() }
}

/**
 * Scheduled or recording in Tvheadend. [state]: scheduled | recording | skipped | completed | failed; [canChange]: whether this
 * account may cancel or stop it (its own; any, for an admin). Servers before 0.14.0 don't say: then it's offered as
 * before. [series]: the series recording that made it, if one did (servers since 0.20.0).
 */
@Serializable
data class Dvr(val uuid: String, val state: String = "scheduled", val canChange: Boolean = true, val series: String? = null)

/** One guide entry (server/routes/livetv.js publicEvent); times in epoch seconds. */
@Serializable
data class Programme(
    val id: Long,
    val channel: String,
    val start: Long,
    val stop: Long,
    val title: String = "Untitled",
    val subtitle: String? = null,
    val summary: String? = null,
    val description: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val episodeLabel: String? = null,
    /** ETSI EN 300 468 content types, e.g. 0x14 (comedy). */
    val genre: List<Int> = emptyList(),
    val genreName: String? = null,
    val dvr: Dvr? = null,
)

/** GET /api/livetv/guide: [from, to) with every channel and what's on them. */
@Serializable
data class GuideResponse(
    val from: Long,
    val to: Long,
    val now: Long,
    val channels: List<Channel> = emptyList(),
    val events: List<Programme> = emptyList(),
    val canRecord: Boolean = false,
    /** This account may set series recordings (servers since 0.20.0). */
    val canRecordSeries: Boolean = false,
)

/** GET /api/livetv/channels */
@Serializable
data class ChannelsResponse(val channels: List<Channel> = emptyList())

/** GET /api/livetv/channels/<uuid>/now */
@Serializable
data class NowNext(val now: Programme? = null, val next: Programme? = null)

/** POST /api/livetv/play/<uuid>: the live stream started for this phone. */
@Serializable
data class LivePlayInfo(
    val playId: String,
    /** /api/live/<playId>/index.m3u8 (the session id is the key; it needs no sign-in). */
    val url: String,
    val radio: Boolean = false,
    val channel: Channel? = null,
    /** What it's converted at, and the qualities worth offering for this channel. */
    val quality: String? = null,
    val qualities: List<String> = emptyList(),
    val now: Programme? = null,
    val next: Programme? = null,
)

/** POST /api/livetv/record */
@Serializable
data class RecordResponse(val dvrUuid: String? = null)

/** POST /api/livetv/series */
@Serializable
data class SeriesResponse(
    val uuid: String? = null,
    /** This account had one of that show on that channel already. */
    val already: Boolean = false,
)

/** A recording on the Recordings screen (server/routes/livetv.js, GET /api/livetv/recordings); times in epoch seconds. */
@Serializable
data class Recording(
    val uuid: String,
    /** scheduled | recording | recorded | failed */
    val state: String,
    val title: String = "Untitled",
    val subtitle: String? = null,
    val description: String? = null,
    val channel: Channel? = null,
    val start: Long,
    val stop: Long,
    /** Bytes on disk so far, or null before anything is. */
    val size: Long? = null,
    /** Tvheadend's own word for it ("Completed OK", "Time missed"…). */
    val status: String? = null,
    /** Who set it through Reelhouse; null for ones Reelhouse didn't schedule (or whose account is gone). */
    val owner: User? = null,
    val mine: Boolean = false,
    /** Its owner may change it, and an admin any. */
    val canChange: Boolean = false,
    /** Its series and episode numbers, when the guide gave them (servers since 0.16.0). */
    val season: Int? = null,
    val episode: Int? = null,
    /** Its episode's picture: TMDB's still, else the guide's (servers since 0.17.0), or null. */
    val still: String? = null,
    /** The series recording that made it, if one did and is still there (servers since 0.20.0). */
    val series: String? = null,
    /** Under way but not going to plan: [status] says why ("Waiting for stream"; servers since 0.20.1). */
    val problem: Boolean = false,
)

/** How many of a show's recordings are in each state. */
@Serializable
data class RecordingCounts(val recording: Int = 0, val scheduled: Int = 0, val recorded: Int = 0, val failed: Int = 0)

/**
 * One series of a show's recordings ([season] null: those without a series number), with its cover ([poster]: TMDB's
 * for the series, else the show's; servers since 0.17.0) and how many are in each state.
 */
@Serializable
data class RecordingSeason(
    val season: Int? = null,
    val poster: String? = null,
    val counts: RecordingCounts = RecordingCounts(),
    val recordings: List<Recording> = emptyList(),
)

/**
 * A show on the Recordings screen (server/livetv/recordings.js groupShows): its recordings by series, with cover art
 * ([poster]: TMDB's, or the guide's picture, through Reelhouse) and its newest recording's channel.
 */
@Serializable
data class RecordingShow(
    val key: String,
    val title: String,
    val poster: String? = null,
    val channel: Channel? = null,
    val counts: RecordingCounts = RecordingCounts(),
    val recordingNow: Boolean = false,
    /** When its newest recording that has started began, and when its next scheduled one records (epoch seconds). */
    val latest: Long = 0,
    val nextScheduled: Long? = null,
    val seasons: List<RecordingSeason> = emptyList(),
)

/**
 * A series recording on Manage Recordings (server/livetv/recordings.js seriesList): every episode of a show on a channel.
 * [key] is its show's, for that show's page; [counts] what it has made so far; [next] when the next one records.
 */
@Serializable
data class SeriesRecording(
    val uuid: String,
    val key: String,
    val title: String,
    val poster: String? = null,
    val channel: Channel? = null,
    val owner: User? = null,
    val mine: Boolean = false,
    val canChange: Boolean = false,
    val counts: RecordingCounts = RecordingCounts(),
    val next: Long? = null,
)

/** How full Tvheadend's recordings drive is, in bytes; [recordings]: what its recordings take up. */
@Serializable
data class RecordingsDrive(val free: Long, val total: Long, val recordings: Long? = null)

/** GET /api/livetv/recordings: yours, or everyone's ([everyone], admins asking for it), also grouped by show. */
@Serializable
data class RecordingsResponse(
    val recordings: List<Recording> = emptyList(),
    val shows: List<RecordingShow> = emptyList(),
    val series: List<SeriesRecording> = emptyList(),
    val everyone: Boolean = false,
    val drive: RecordingsDrive? = null,
)

/** POST /api/livetv/recordings/delete */
@Serializable
data class DeletedRecordings(val deleted: Int = 0, val skipped: List<String> = emptyList())
