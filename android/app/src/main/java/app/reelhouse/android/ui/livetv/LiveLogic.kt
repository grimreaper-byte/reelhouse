package app.reelhouse.android.ui.livetv

import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.data.playback.Quality
import kotlin.math.roundToLong

// The live player's rules, as the web app's (web/js/views/live-player.js).

const val REPORT_EVERY_MS = 10_000L // the heartbeat that keeps the stream going on the server
const val RESTARTS = 3 // a broken stream is started again this many times before giving up
const val AT_LIVE_MS = 10_000L // nearer the live edge than this counts as watching live
const val PLAYLIST_WAIT_MS = 30_000L // a channel's first seconds can take a while (tuning, the first segment)

/** The next or previous channel of the same kind (TV channels skip radio stations, and the other way round), round the end. */
fun zapTarget(channels: List<Channel>, current: String, radio: Boolean, step: Int): Channel? {
    val list = channels.filter { it.radio == radio || it.uuid == current }
    val i = list.indexOfFirst { it.uuid == current }
    if (i < 0 || list.size < 2) return null
    return list[Math.floorMod(i + step, list.size)]
}

/** The qualities to offer for a channel: the ones the server says are worth it (none said: all). */
fun offeredQualities(all: List<Quality>, offered: List<String>): List<Quality> =
    if (offered.isEmpty()) all else all.filter { it.id in offered }

/** How far behind live, from the live window's default position (the live edge, less a few seconds) and where it plays. */
fun behindLiveMs(defaultPositionMs: Long, positionMs: Long): Long = (defaultPositionMs - positionMs).coerceAtLeast(0)

/** "3 min behind", "<1 min behind"; null when at live. */
fun behindText(behindMs: Long): String? {
    if (behindMs <= AT_LIVE_MS) return null
    val minutes = (behindMs / 60_000.0).roundToLong()
    return "${if (minutes == 0L) "<1" else minutes} min behind"
}

/** When to ask again what's on: just after the current programme ends, else in five minutes (at most half an hour). */
fun nowRefreshDelayMs(stop: Long?, nowMs: Long): Long {
    val wait = if (stop != null) maxOf(5_000L, stop * 1000 - nowMs + 2_000L) else 5 * 60_000L
    return minOf(wait, 30 * 60_000L)
}

/**
 * The stream the server still has to stop when the player starts another (a channel change frees its tuner first).
 * It's kept until the server has taken a start that names it: a start cut short by another quick change, or by
 * leaving, mustn't lose it, or it would hold a tuner until it went quiet.
 */
class StreamToStop {
    private var id: String? = null

    /** A start is about to be asked for, leaving [playing] (if any): the stream it should stop. */
    fun starting(playing: String?): String? {
        if (playing != null) id = playing
        return id
    }

    /** The server took the start (and stopped the stream it named). */
    fun started() {
        id = null
    }

    /** Leaving: the stream to say stopped too, if a start that would have stopped it never got there. */
    fun take(): String? = id.also { id = null }
}
