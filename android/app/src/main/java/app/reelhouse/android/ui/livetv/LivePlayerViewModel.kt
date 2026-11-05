package app.reelhouse.android.ui.livetv

import android.content.Context
import android.util.Log
import androidx.annotation.OptIn
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import app.reelhouse.android.AppContainer
import app.reelhouse.android.data.api.ApiException
import app.reelhouse.android.data.api.OfflineException
import app.reelhouse.android.data.connection.Route
import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.data.model.LivePlayInfo
import app.reelhouse.android.data.model.Programme
import app.reelhouse.android.data.playback.AvSync
import app.reelhouse.android.data.playback.PictureTiming
import app.reelhouse.android.data.playback.Quality
import app.reelhouse.android.data.playback.TimedRenderersFactory
import app.reelhouse.android.ui.common.errorText
import app.reelhouse.android.ui.player.PlayerViewModel
import app.reelhouse.android.ui.player.chooseQuality
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

private const val TAG = "Reelhouse"

/**
 * The live player: a channel from Tvheadend, converted by Reelhouse into a live stream (server/transcode/live.js) and
 * played by Media3. No seeking, but pausing keeps a few minutes and Live goes back to now; the channel buttons change
 * channel without leaving the player (the old stream is stopped first, freeing its tuner). Leaving the app stops the
 * stream, and coming back starts it again. A radio station has no picture: the screen shows the station instead.
 */
@OptIn(UnstableApi::class)
class LivePlayerViewModel(private val c: AppContainer, context: Context, channelUuid: String, radio: Boolean) : ViewModel() {
    data class Ui(
        val channel: Channel? = null,
        val radio: Boolean = false,
        val now: Programme? = null,
        val next: Programme? = null,
        val loading: Boolean = true,
        val errorTitle: String? = null,
        val error: String? = null,
        val playing: Boolean = false,
        val behindMs: Long = 0,
        /** What it's converted at, and the qualities worth offering for this channel. */
        val quality: String? = null,
        val qualities: List<Quality> = emptyList(),
        /** The channel isn't there any more: back to the guide. */
        val missing: Boolean = false,
    )

    @Volatile
    private var syncMs = AvSync.clamp(c.prefs.avSyncMs)
    private val timing = PictureTiming(c.prefs.pictureDelayUs)

    val player: ExoPlayer = ExoPlayer.Builder(context, TimedRenderersFactory(context, timing) { syncMs * 1000L })
        // Through the app's HTTP client, as films: the current route (maybe the tunnel).
        .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(context, OkHttpDataSource.Factory(c.http))))
        .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
        .setHandleAudioBecomingNoisy(true)
        .build()

    private val _ui = MutableStateFlow(Ui(radio = radio))
    val ui: StateFlow<Ui> = _ui.asStateFlow()

    private var channelUuid = channelUuid
    private var channels: List<Channel> = emptyList()
    private var allQualities: List<Quality> = PlayerViewModel.DEFAULT_QUALITIES
    private var info: LivePlayInfo? = null
    private val toStop = StreamToStop()
    private var restarts = 0
    private var startJob: Job? = null
    private var nowJob: Job? = null
    private var healthyJob: Job? = null

    /** Left the app: the stream was stopped (freeing the tuner), to start again on coming back. */
    private var stopped = false

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            when (state) {
                Player.STATE_READY -> _ui.update { it.copy(loading = false) }
                Player.STATE_BUFFERING -> _ui.update { it.copy(loading = true) }
                else -> Unit
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            _ui.update { it.copy(playing = isPlaying) }
            healthyJob?.cancel()
            if (isPlaying) {
                // Playing for a while: a later break gets its few restarts again.
                healthyJob = viewModelScope.launch {
                    delay(15_000)
                    restarts = 0
                }
            } else if (player.playbackState == Player.STATE_READY && !player.playWhenReady) {
                report("paused")
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            Log.w(TAG, "live: ${error.errorCodeName}", error)
            // Paused for longer than the stream keeps: on from live.
            if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                player.seekToDefaultPosition()
                player.prepare()
                return
            }
            // The stream broke (the server ended it, or the connection dropped): start the channel again, a few times.
            if (restarts < RESTARTS) {
                restarts++
                start()
            } else {
                _ui.update { it.copy(loading = false, errorTitle = if (it.radio) "Radio stopped" else "Live TV stopped", error = "The stream failed repeatedly.") }
            }
        }
    }

    init {
        player.addListener(listener)
        begin()
        // The heartbeat that keeps the stream going on the server and the activity list current.
        viewModelScope.launch {
            while (true) {
                delay(REPORT_EVERY_MS)
                report(if (player.playWhenReady) "playing" else "paused")
            }
        }
        // How far behind live (paused, or after a hiccup): the Live button says so.
        viewModelScope.launch {
            val window = Timeline.Window()
            while (true) {
                delay(1000)
                val timeline = player.currentTimeline
                val behind = if (!timeline.isEmpty && player.isCurrentMediaItemLive) {
                    timeline.getWindow(player.currentMediaItemIndex, window)
                    behindLiveMs(window.defaultPositionMs, player.currentPosition)
                } else {
                    0L
                }
                if (behind / 1000 != _ui.value.behindMs / 1000) _ui.update { it.copy(behindMs = behind) }
            }
        }
        // The phone's picture delay as measured, kept for the next video (films use it too).
        viewModelScope.launch {
            while (true) {
                delay(2_000)
                if (timing.compensationUs != c.prefs.pictureDelayUs) c.prefs.pictureDelayUs = timing.compensationUs
            }
        }
    }

    /** The channel list (for the channel's name and logo, and changing channel), then the channel. */
    fun begin() {
        startJob?.cancel()
        _ui.update { it.copy(loading = true, error = null, errorTitle = null) }
        startJob = viewModelScope.launch {
            try {
                channels = c.api.channels()
                runCatching { c.api.qualities() }.getOrNull()?.takeIf { it.isNotEmpty() }?.let { allQualities = it }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, errorTitle = "Can’t play this channel", error = c.errorText(e)) }
                return@launch
            }
            val channel = channels.firstOrNull { it.uuid == channelUuid }
            if (channel == null) {
                _ui.update { it.copy(missing = true) }
                return@launch
            }
            _ui.update { it.copy(channel = channel, radio = channel.radio) }
            start()
        }
    }

    private fun atHome() = c.connection.state.value.route is Route.Home

    private fun quality() = chooseQuality(atHome(), c.prefs.quality(atHome()), c.connection.serverDefaults.value?.remoteQuality ?: "4m-720")

    /** Starts the channel (again): a fresh stream on the server, the one before stopped first. */
    fun start() {
        if (channels.isEmpty()) return begin()
        startJob?.cancel()
        val previous = toStop.starting(info?.playId)
        info = null
        player.stop()
        player.clearMediaItems()
        _ui.update { it.copy(loading = true, error = null, errorTitle = null, behindMs = 0) }
        startJob = viewModelScope.launch {
            try {
                val started = c.api.playLive(channelUuid, quality(), previous)
                toStop.started()
                info = started
                _ui.update {
                    it.copy(
                        // Found to be radio as it started (Tvheadend hadn't said): shown as a station.
                        radio = started.radio,
                        channel = started.channel?.let { ch -> it.channel?.copy(radio = ch.radio) ?: ch } ?: it.channel,
                        now = started.now,
                        next = started.next,
                        quality = started.quality,
                        qualities = offeredQualities(allQualities, started.qualities),
                    )
                }
                scheduleNowRefresh()
                // The playlist answers "Not ready" until the first seconds are there.
                withTimeoutOrNull(PLAYLIST_WAIT_MS) {
                    while (!c.api.livePlaylistReady(started.url)) delay(500)
                } ?: throw ApiException(504, "The channel didn’t start in time: Tvheadend may have no free tuner, or no signal on it.")
                val url = c.url(started.url) ?: throw OfflineException()
                player.setMediaItem(MediaItem.Builder().setUri(url).setMimeType(MimeTypes.APPLICATION_M3U8).build())
                player.prepare()
                player.playWhenReady = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, errorTitle = "Can’t play this channel", error = c.errorText(e)) }
            }
        }
    }

    /** What's on now and next, again once the current programme ends. */
    private fun scheduleNowRefresh() {
        nowJob?.cancel()
        nowJob = viewModelScope.launch {
            while (true) {
                delay(nowRefreshDelayMs(_ui.value.now?.stop, System.currentTimeMillis()))
                runCatching { c.api.nowAndNext(channelUuid) }.onSuccess { nn -> _ui.update { it.copy(now = nn.now, next = nn.next) } }
            }
        }
    }

    /** The next (1) or previous (-1) channel of the same kind. */
    fun zap(step: Int) {
        val target = zapTarget(channels, channelUuid, _ui.value.radio, step) ?: return
        channelUuid = target.uuid
        restarts = 0
        _ui.update { it.copy(channel = target, radio = target.radio, now = null, next = null) }
        start()
    }

    fun togglePlay() {
        if (player.playWhenReady) player.pause() else player.play()
    }

    /** Back to now, after pausing. */
    fun goLive() {
        player.seekToDefaultPosition()
        player.play()
    }

    /** A quality picked in the player is kept for the next channel and for films too (at home or away, as now). */
    fun setQuality(id: String) {
        c.prefs.setQuality(atHome(), id)
        restarts = 0
        start()
    }

    /** Left the app: the stream stops now (freeing Tvheadend's tuner) rather than playing to nobody. */
    fun onBackground() {
        if (stopped) return
        stopped = true
        startJob?.cancel()
        report("stopped")
        stopEarlier()
        info = null
        player.stop()
    }

    /** Back in the app: the channel starts again. */
    fun onForeground() {
        if (!stopped) return
        stopped = false
        restarts = 0
        start()
    }

    private fun report(state: String) {
        val id = info?.playId ?: return
        c.scope.launch { runCatching { c.api.liveProgress(id, state) } }
    }

    /** A stream a channel change was to stop, when that start never reached the server. */
    private fun stopEarlier() {
        val id = toStop.take() ?: return
        c.scope.launch { runCatching { c.api.liveProgress(id, "stopped") } }
    }

    override fun onCleared() {
        report("stopped") // frees the tuner straight away
        stopEarlier()
        player.removeListener(listener)
        player.release()
    }
}
