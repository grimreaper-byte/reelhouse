package app.reelhouse.android.ui.player

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.annotation.OptIn
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import app.reelhouse.android.AppContainer
import app.reelhouse.android.data.connection.ConnectionManager.Phase
import app.reelhouse.android.data.connection.Route
import app.reelhouse.android.data.downloads.Download
import app.reelhouse.android.data.downloads.PendingReport
import java.io.File
import app.reelhouse.android.data.joinUrl
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.data.playback.AvSync
import app.reelhouse.android.data.playback.Chapter
import app.reelhouse.android.data.playback.DeviceCaps
import app.reelhouse.android.data.playback.PlayState
import app.reelhouse.android.data.playback.PlaybackInfo
import app.reelhouse.android.data.playback.PictureTiming
import app.reelhouse.android.data.playback.PlaybackRequest
import app.reelhouse.android.data.playback.Quality
import app.reelhouse.android.data.playback.TimedRenderersFactory
import app.reelhouse.android.ui.common.errorText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** A line in one of the player's menus. */
class Choice(val label: String, val selected: Boolean, val note: String? = null, val onPick: () -> Unit)

@OptIn(UnstableApi::class)
class PlayerViewModel(private val c: AppContainer, context: Context, itemId: Long, startAt: Double) : ViewModel() {
    data class Ui(
        val item: Item? = null,
        val showTitle: String? = null,
        val info: PlaybackInfo? = null,
        val loading: Boolean = true,
        val status: String? = null,
        val error: String? = null,
        val upNext: Item? = null,
        val countdown: Int = 0,
        val finished: Boolean = false,
        /** Changes when the tracks do, so menus are rebuilt. */
        val tracks: Int = 0,
        /** The item was left part-way (seconds): asking whether to resume there or start over. */
        val askResume: Double? = null,
        /** The manual picture and sound adjustment for this phone (ms, positive: the sound later), see [AvSync]. */
        val syncMs: Int = 0,
        /** How late this phone shows the picture, as measured and made up for (ms), see [PictureTiming]. */
        val pictureDelayMs: Int = 0,
        /** Where a chapter button just went ("Chapter 3 of 5 · Part Two"), for a moment. */
        val chapterNote: String? = null,
    )

    /** Read by the player's own thread for every position; set from the screen. */
    @Volatile
    private var syncMs = AvSync.clamp(c.prefs.avSyncMs)

    // Starts from what was measured last time, so a new video doesn't begin out of step.
    private val timing = PictureTiming(c.prefs.pictureDelayUs)

    val player: ExoPlayer = ExoPlayer.Builder(context, TimedRenderersFactory(context, timing) { syncMs * 1000L })
        // Everything goes through the app's HTTP client: the current route (maybe the tunnel) and the sign-in.
        .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(context, OkHttpDataSource.Factory(c.http))))
        .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
        .setHandleAudioBecomingNoisy(true)
        .build()

    private val _ui = MutableStateFlow(Ui(syncMs = syncMs, pictureDelayMs = pictureDelayMs()))

    private fun pictureDelayMs() = (timing.compensationUs / 1000).toInt()
    val ui: StateFlow<Ui> = _ui.asStateFlow()

    private var itemId = itemId
    private var info: PlaybackInfo? = null
    private var audioIndex: Int? = null
    private var burnSubtitle: Int? = null
    private var forced = false
    private var retries = 0
    private var endedReported = false
    private var remoteDefault = "4m-720"
    private var qualities: List<Quality> = DEFAULT_QUALITIES
    private var countdownJob: Job? = null
    private var startJob: Job? = null

    /** A file played as it is, with a picture: its first seconds are watched for frames ([PictureWatch]). */
    private var pictureJob: Job? = null
    private var pictureShown = false

    /**
     * The subtitles picked in this player (language and label), applied again whenever the tracks change: after a
     * restart for another quality or audio track, and for the next episode. Null: nothing picked (the defaults).
     */
    private var subtitleWish: SubtitleWish? = null

    private data class SubtitleWish(val off: Boolean, val language: String?, val label: String?)

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            when (state) {
                Player.STATE_READY -> _ui.update { it.copy(loading = false, status = null) }
                Player.STATE_BUFFERING -> Unit
                Player.STATE_ENDED -> onEnded()
                Player.STATE_IDLE -> Unit
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) {
                retries = 0
            } else if (player.playbackState == Player.STATE_READY && !player.playWhenReady) {
                report(PlayState.Paused)
            }
        }

        override fun onTracksChanged(tracks: Tracks) {
            Log.d(TAG, "text tracks: " + tracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }.joinToString { "${it.getTrackFormat(0).id}/${it.getTrackFormat(0).language}" })
            applySubtitleWish()
            _ui.update { it.copy(tracks = it.tracks + 1) }
        }

        override fun onPlayerError(error: PlaybackException) {
            handleError(error)
        }

        override fun onRenderedFirstFrame() {
            pictureShown = true
        }
    }

    init {
        player.addListener(listener)
        Log.i(TAG, "this phone plays: ${DeviceCaps.current.video.joinToString()} | ${DeviceCaps.current.audio.joinToString()}")
        viewModelScope.launch {
            runCatching { remoteDefault = c.api.me().defaults.remoteQuality }
            runCatching { c.api.qualities().takeIf { it.isNotEmpty() }?.let { qualities = it } }
        }
        startJob = viewModelScope.launch { open(itemId, startAt) }
        // While playing, the position goes to the server every 10 s (the resume point, Continue Watching).
        viewModelScope.launch {
            while (true) {
                delay(REPORT_EVERY_MS)
                if (player.isPlaying) report(PlayState.Playing)
            }
        }
        // The phone's picture delay as it's measured: shown in the sync panel, logged when it changes, and kept for
        // the next video.
        viewModelScope.launch {
            var logged = Long.MIN_VALUE
            var loggedMeasured: Long? = null
            while (true) {
                delay(PICTURE_TIMING_EVERY_MS)
                val us = timing.compensationUs
                val measured = timing.measuredUs
                val moved = measured != null && (loggedMeasured == null || kotlin.math.abs(measured - loggedMeasured) >= 5_000)
                if (us != logged || moved) {
                    Log.i(TAG, "picture timing: phone delay ${measured?.let { "${it / 1000} ms" } ?: "not measured yet"}, making up ${us / 1000} ms")
                    loggedMeasured = measured
                }
                if (us != logged) {
                    logged = us
                    c.prefs.pictureDelayUs = us
                    _ui.update { it.copy(pictureDelayMs = pictureDelayMs()) }
                }
            }
        }
    }

    // ---------- starting ----------

    private suspend fun open(id: Long, startAt: Double) {
        // On to another item (the next episode): the server can stop converting the previous one now, rather than
        // count it against its limit for a while longer.
        info?.sessionId?.takeIf { id != itemId }?.let { sid -> c.scope.launch { runCatching { c.api.endSession(sid) } } }
        itemId = id
        info = null
        audioIndex = null
        burnSubtitle = null
        forced = false
        retries = 0
        endedReported = false
        _ui.value = Ui(loading = true, syncMs = syncMs, pictureDelayMs = pictureDelayMs())
        local = c.downloads.store.completed(id)
        val details = try {
            if (local != null && c.connection.baseUrl == null) null else c.api.item(id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (local == null) {
                _ui.update { it.copy(loading = false, error = c.errorText(e)) }
                return
            }
            null // offline, but downloaded
        }
        val d = local
        // The server knows best where it was left; without it, the phone's own record of the download.
        val item = details?.item ?: d!!.item.copy(state = d.item.state.copy(position = d.position))
        localNext = if (d != null) details?.next ?: nextDownloaded(d) else null
        _ui.update { it.copy(item = item, showTitle = details?.show?.title ?: d?.showTitle) }
        if (startAt >= 0) {
            begin(startAt)
            return
        }
        // No position given: ask, if it was left part-way.
        val resume = resumePoint(item)
        if (resume > 0) _ui.update { it.copy(loading = false, askResume = resume) } else begin(0.0)
    }

    /** The download being played, if the item is downloaded (played from the phone even when online). */
    private var local: Download? = null
    private var localNext: Item? = null

    private suspend fun begin(at: Double) {
        val d = local
        // A downloaded AVI plays its sound about half a second ahead of the picture in Media3 (see DeviceCaps), so
        // while Reelhouse can be reached it plays converted from there instead.
        val streamInstead = d != null && d.file.endsWith(".avi", ignoreCase = true) && c.connection.baseUrl != null
        if (d != null && !streamInstead) playLocal(d, at) else start(at)
    }

    private fun playLocal(d: Download, at: Double) {
        val res = PlaybackInfo(
            playId = "download-${d.itemId}-${System.currentTimeMillis()}",
            mode = MODE_DOWNLOAD,
            url = d.file,
            duration = d.item.duration,
            next = localNext,
        )
        info = res
        val subtitles = d.subtitles.map { s ->
            MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(File(s.file)))
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage(s.language)
                .setLabel(s.label)
                .build()
        }
        Log.i(TAG, "playing item ${d.itemId} from the download, from ${at.toInt()} s")
        player.setMediaItem(MediaItem.Builder().setUri(Uri.fromFile(File(d.file))).setSubtitleConfigurations(subtitles).build(), (at * 1000).toLong())
        watchPicture(expected = d.item.videoResolution != null)
        player.prepare()
        player.playWhenReady = true
        _ui.update { it.copy(info = res, loading = false, error = null, status = null, finished = false) }
    }

    /** Offline, the next episode is the next one of the show that's downloaded. */
    private fun nextDownloaded(d: Download): Item? {
        if (d.item.type != "episode") return null
        val key = { i: Item -> (i.seasonNumber ?: 0) * 10_000 + (i.episodeNumber ?: 0) }
        return c.downloads.store.downloads.value
            .filter { it.done && it.showId == d.showId && it.item.type == "episode" && key(it.item) > key(d.item) }
            .minByOrNull { key(it.item) }?.item
    }

    /** The answer to "resume or start over?". */
    fun resumeFrom(fromStart: Boolean) {
        val at = _ui.value.askResume ?: return
        _ui.update { it.copy(askResume = null) }
        startJob?.cancel()
        startJob = viewModelScope.launch { begin(if (fromStart) 0.0 else at) }
    }

    private fun atHome() = c.connection.state.value.route is Route.Home

    private fun quality() = chooseQuality(atHome(), c.prefs.quality(atHome()), remoteDefault)

    /**
     * Asks the server how to play the item from [at] seconds (again, after a change) and starts it. Returns false
     * if that failed; the error is shown unless [quiet] (the caller will try again).
     */
    private suspend fun start(at: Double, quiet: Boolean = false): Boolean {
        _ui.update { it.copy(loading = true, error = null) }
        val base = awaitRoute() ?: run {
            if (!quiet) _ui.update { it.copy(loading = false, error = "Reelhouse can't be reached") }
            return false
        }
        val previous = info?.sessionId
        var res = try {
            c.api.playback(itemId, PlaybackRequest(DeviceCaps.current, quality(), audioIndex, burnSubtitle, forced, previous))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val text = c.errorText(e)
            if (!quiet) _ui.update { it.copy(loading = false, error = text) }
            return false
        }
        if (!res.converted && !forced && !DeviceCaps.canDecode(res.video?.codec, res.video?.width, res.video?.height)) {
            // The codec is fine but the picture is too big for this phone's decoder (e.g. 4K): convert instead.
            forced = true
            res = try {
                c.api.playback(itemId, PlaybackRequest(DeviceCaps.current, quality(), audioIndex, burnSubtitle, true, res.sessionId))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val text = c.errorText(e)
                if (!quiet) _ui.update { it.copy(loading = false, error = text) }
                return false
            }
        }
        info = res
        Log.i(TAG, "playing item $itemId ${res.mode} at ${res.quality}${if (res.reasons.isEmpty()) "" else " (${res.reasons.joinToString()})"} from ${at.toInt()} s")
        player.setMediaItem(mediaItem(base, res), (at * 1000).toLong())
        watchPicture(expected = !res.converted && res.video != null)
        player.prepare()
        player.playWhenReady = true
        _ui.update { it.copy(info = res, error = null, status = null, finished = false) }
        return true
    }

    private fun mediaItem(base: String, res: PlaybackInfo): MediaItem {
        // Sidecar subtitle files always come as WebVTT; when converting, the file's own text subtitles too.
        val subtitles = res.subtitleTracks
            .filter { it.kind == "text" && it.url != null && (res.converted || it.external) }
            .map { s ->
                MediaItem.SubtitleConfiguration.Builder(Uri.parse(joinUrl(base, s.url!!)))
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLanguage(s.language)
                    .setLabel(subtitleLabel(s))
                    .setId(s.id)
                    .setSelectionFlags(if (s.forced) C.SELECTION_FLAG_FORCED else 0)
                    .build()
            }
        return MediaItem.Builder()
            .setUri(joinUrl(base, res.url))
            .setMimeType(if (res.converted) MimeTypes.APPLICATION_M3U8 else null)
            .setSubtitleConfigurations(subtitles)
            .build()
    }

    /** The current route's address, waiting a while for one to appear. */
    private suspend fun awaitRoute(): String? {
        c.connection.baseUrl?.let { return it }
        c.connection.reconnect()
        return withTimeoutOrNull(ROUTE_WAIT_MS) {
            c.connection.state.first { it.phase == Phase.Connected && it.route != null }.route?.baseUrl
        }
    }

    private fun restart(at: Double = position()) {
        startJob?.cancel()
        startJob = viewModelScope.launch { start(at) }
    }

    fun retry() = restart()

    // ---------- trouble ----------

    private fun handleError(e: PlaybackException) {
        val at = position()
        val recovery = recoveryFor(e.errorCode, info?.converted == true, forced)
        Log.w(TAG, "playback error ${e.errorCodeName}: ${e.message} -> $recovery")
        if (recovery == Recovery.Fail || retries >= MAX_RETRIES) {
            _ui.update { it.copy(loading = false, error = "This can't be played: ${e.errorCodeName.removePrefix("ERROR_CODE_").lowercase().replace('_', ' ')}") }
            return
        }
        retries++
        when (recovery) {
            Recovery.Convert -> convertInstead(at, noPicture = false)
            Recovery.Reconnect -> {
                _ui.update { it.copy(status = "Reconnecting…") }
                startJob?.cancel()
                startJob = viewModelScope.launch {
                    // A new route, or Reelhouse coming back (e.g. after a restart): try for a while before giving up.
                    for ((n, wait) in RECONNECT_WAITS_MS.withIndex()) {
                        c.connection.reconnect()
                        delay(wait)
                        if (start(at, quiet = n < RECONNECT_WAITS_MS.lastIndex)) return@launch
                    }
                }
            }
            Recovery.Restart -> restart(at)
            Recovery.Fail -> Unit
        }
    }

    /**
     * The phone can't play the file as it is ([noPicture]: it plays the sound but shows no picture), so the server
     * converts it instead. A download is the original file: offline there's nothing more to try.
     */
    private fun convertInstead(at: Double, noPicture: Boolean) {
        pictureJob?.cancel()
        if (info?.mode == MODE_DOWNLOAD && c.connection.baseUrl == null) {
            player.pause()
            val what = if (noPicture) "show the downloaded file's picture" else "play the downloaded file as it is"
            _ui.update { it.copy(loading = false, error = "This phone can't $what. Connect to Reelhouse and it's converted while you watch.") }
            return
        }
        forced = true
        val what = if (noPicture) "show this file's picture" else "play the file as it is"
        _ui.update { it.copy(status = "This phone can't $what; converting…") }
        restart(at)
    }

    /** Watches a file played as it is for its first frame, and converts it if none comes ([PictureWatch]). */
    private fun watchPicture(expected: Boolean) {
        pictureJob?.cancel()
        pictureShown = false
        if (!expected) return
        val watch = PictureWatch(PICTURE_WAIT_MS)
        pictureJob = viewModelScope.launch {
            while (!pictureShown) {
                delay(PICTURE_CHECK_MS)
                // Frames are only drawn while there's a surface to draw on (the player is on screen).
                val onScreen = player.isPlaying && player.surfaceSize.width > 0
                if (!pictureShown && watch.noPicture(onScreen, player.currentPosition)) {
                    Log.w(TAG, "no picture after ${PICTURE_WAIT_MS / 1000} s of playing item $itemId as it is -> convert")
                    convertInstead(position(), noPicture = true)
                    return@launch
                }
            }
        }
    }

    // ---------- the end, and what's next ----------

    private fun onEnded() {
        if (!endedReported) {
            endedReported = true
            report(PlayState.Ended)
        }
        val next = info?.next
        if (next == null) {
            _ui.update { it.copy(finished = true) }
            return
        }
        countdownJob?.cancel()
        countdownJob = viewModelScope.launch {
            for (s in UP_NEXT_SECONDS downTo 1) {
                _ui.update { it.copy(upNext = next, countdown = s) }
                delay(1000)
            }
            playNext()
        }
    }

    fun playNext() {
        val next = _ui.value.upNext ?: info?.next ?: return
        countdownJob?.cancel()
        _ui.update { it.copy(upNext = null) }
        startJob?.cancel()
        // Episodes that follow on start from the beginning, whatever position they were left at.
        startJob = viewModelScope.launch { open(next.id, 0.0) }
    }

    fun cancelUpNext() {
        countdownJob?.cancel()
        _ui.update { it.copy(upNext = null, finished = true) }
    }

    // ---------- menus ----------

    fun audioChoices(): List<Choice> {
        val i = info ?: return emptyList()
        if (i.converted) {
            return i.audioTracks.map { a ->
                Choice(audioLabel(a), selected = a.index == i.audioIndex) {
                    if (a.index != i.audioIndex) {
                        audioIndex = a.index
                        restart()
                    }
                }
            }
        }
        // Playing the file itself: the phone switches between its audio tracks, unless it can't decode one.
        val groups = player.currentTracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        return groups.mapIndexed { k, g ->
            val f = g.getTrackFormat(0)
            val playable = g.isTrackSupported(0)
            Choice(formatLabel(f, k), selected = g.isSelected, note = if (playable) null else "converted") {
                if (playable) {
                    select(g)
                } else {
                    audioIndex = i.audioTracks.getOrNull(k)?.index
                    restart()
                }
            }
        }
    }

    /**
     * The subtitle tracks to offer. Media3 adds an empty CEA-608 closed-caption track to every HLS stream without
     * caption declarations; Reelhouse's conversions never carry captions, so it's left out there.
     */
    private fun textGroups(): List<Tracks.Group> = player.currentTracks.groups.filter { g ->
        g.type == C.TRACK_TYPE_TEXT && !(info?.converted == true && isClosedCaption(g.getTrackFormat(0)))
    }

    private fun isClosedCaption(f: Format) =
        listOfNotNull(f.sampleMimeType, f.codecs).any { it.contains("cea-608") || it.contains("cea-708") }

    fun subtitleChoices(): List<Choice> {
        val i = info ?: return emptyList()
        val texts = textGroups()
        val burned = i.burnSubtitle
        val list = mutableListOf<Choice>()
        list += Choice("Off", selected = burned == null && texts.none { it.isSelected }) {
            subtitleWish = SubtitleWish(off = true, language = null, label = null)
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
            if (burned != null) {
                burnSubtitle = null
                restart()
            }
        }
        texts.forEachIndexed { k, g ->
            val label = textTrackLabel(g, k)
            list += Choice(label, selected = burned == null && g.isSelected) {
                subtitleWish = SubtitleWish(off = false, language = g.getTrackFormat(0).language, label = label)
                if (burned != null) {
                    burnSubtitle = null
                    restart()
                }
                select(g)
            }
        }
        if (i.converted) {
            // Picture-based subtitles (e.g. PGS) can only be drawn into the converted video.
            i.subtitleTracks.filter { it.kind == "image" }.forEach { s ->
                list += Choice(subtitleLabel(s), selected = burned == s.streamIndex, note = "burned in") {
                    if (burned != s.streamIndex) {
                        burnSubtitle = s.streamIndex
                        restart()
                    }
                }
            }
        }
        return list
    }

    fun qualityChoices(): List<Choice> {
        if (info?.mode == MODE_DOWNLOAD) return listOf(Choice("Downloaded copy (original)", selected = true) {})
        val current = info?.quality
        return offeredQualities(qualities, info?.qualities.orEmpty()).map { q ->
            Choice(q.label, selected = q.id == current) {
                if (q.id != current) {
                    c.prefs.setQuality(atHome(), q.id)
                    restart()
                }
            }
        }
    }

    fun qualityLabel(): String? = info?.quality?.let { id -> qualities.firstOrNull { it.id == id }?.label }

    /** Changes the phone's picture and sound sync; it takes effect at once and is kept for every video. */
    fun setSync(ms: Int) {
        val v = AvSync.clamp(ms)
        syncMs = v
        c.prefs.avSyncMs = v
        _ui.update { it.copy(syncMs = v) }
    }

    /** A subtitle track's name: the server's (language, title, forced, file) when it came from the server's list. */
    private fun textTrackLabel(g: Tracks.Group, k: Int): String {
        val f = g.getTrackFormat(0)
        val id = f.id
        val fromServer = info?.subtitleTracks?.firstOrNull { s -> id != null && (id == s.id || id.endsWith(":${s.id}")) }
        return fromServer?.let(::subtitleLabel) ?: f.label ?: formatLabel(f, k)
    }

    /** Re-applies the picked subtitles to the current tracks (see [subtitleWish]). */
    private fun applySubtitleWish() {
        val wish = subtitleWish ?: return
        val params = player.trackSelectionParameters
        if (wish.off) {
            if (!params.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)) {
                player.trackSelectionParameters = params.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
            }
            return
        }
        val texts = textGroups()
        if (texts.isEmpty() || texts.any { it.isSelected && it.getTrackFormat(0).language == wish.language }) return
        val match = texts.withIndex().firstOrNull { (k, g) -> textTrackLabel(g, k) == wish.label }?.value
            ?: texts.firstOrNull { it.getTrackFormat(0).language == wish.language && wish.language != null }
            ?: return
        select(match)
    }

    private fun select(g: Tracks.Group) {
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(g.type, false)
            .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, 0))
            .build()
    }

    private fun formatLabel(f: Format, k: Int): String =
        listOfNotNull(
            f.label ?: languageName(f.language) ?: "Track ${k + 1}",
            f.sampleMimeType?.let(::codecName),
            channelsLabel(f.channelCount.takeIf { it != Format.NO_VALUE }),
        ).distinct().joinToString(" · ")

    // ---------- reporting, background, leaving ----------

    private fun position(): Double = player.currentPosition.coerceAtLeast(0) / 1000.0

    // ---------- chapters ----------

    /** The chapters of what's playing that are worth buttons ([usableChapters]); none for most files. */
    val chapters: List<Chapter> get() = usableChapters(info?.chapters)

    private var chapterNoteJob: Job? = null

    /** To the next chapter, or back to the start of this one (the one before, just after a start), as on the web. */
    fun skipChapter(forward: Boolean) {
        val list = chapters
        if (list.isEmpty()) return
        val at = position()
        val target = if (forward) nextChapter(list, at) else previousChapter(list, at)
        if (target != null) player.seekTo((target.start * 1000).toLong())
        val note = target?.let { chapterLabel(list, it.index) } ?: "This is the last chapter"
        _ui.update { it.copy(chapterNote = note) }
        chapterNoteJob?.cancel()
        chapterNoteJob = viewModelScope.launch {
            delay(CHAPTER_NOTE_MS)
            _ui.update { it.copy(chapterNote = null) }
        }
    }

    private fun duration(): Double? = info?.duration ?: player.duration.takeIf { it > 0 }?.let { it / 1000.0 }

    private fun report(state: PlayState) {
        val i = info ?: return
        val id = itemId
        val pos = position()
        val dur = duration()
        val fromDownload = i.mode == MODE_DOWNLOAD
        if (fromDownload) {
            // The phone's own record, for resuming offline.
            c.downloads.store.update(id) { it.copy(position = if (state == PlayState.Ended) 0.0 else pos) }
        }
        // Sent from the app's scope so a report made while leaving the player still goes out.
        c.scope.launch {
            val sent = runCatching { c.api.progress(id, pos, dur, state, i) }.isSuccess
            // Offline, a download's progress waits to be sent; the playing heartbeat isn't worth keeping.
            if (!sent && fromDownload && state != PlayState.Playing) {
                c.downloads.store.addReport(PendingReport(id, pos, dur, state.wire, System.currentTimeMillis()))
            }
        }
    }

    fun onBackground() {
        player.pause()
    }

    override fun onCleared() {
        if (!endedReported) report(PlayState.Stopped)
        info?.sessionId?.let { sid -> c.scope.launch { runCatching { c.api.endSession(sid) } } }
        player.removeListener(listener)
        player.release()
    }

    companion object {
        private const val TAG = "Reelhouse"
        const val REPORT_EVERY_MS = 10_000L
        const val ROUTE_WAIT_MS = 20_000L
        val RECONNECT_WAITS_MS = listOf(2_000L, 4_000L, 8_000L, 12_000L)
        const val MAX_RETRIES = 3
        const val PICTURE_WAIT_MS = 3_000L
        const val PICTURE_CHECK_MS = 500L
        const val PICTURE_TIMING_EVERY_MS = 2_000L
        const val UP_NEXT_SECONDS = 10
        const val CHAPTER_NOTE_MS = 2_000L
        const val MODE_DOWNLOAD = "download"

        /** Until the server's list (GET /api/qualities) arrives. */
        val DEFAULT_QUALITIES = listOf(
            Quality("original", "Original"),
            Quality("8m-1080", "1080p · 8 Mbps"),
            Quality("4m-720", "720p · 4 Mbps"),
            Quality("2m-720", "720p · 2 Mbps"),
            Quality("1500k-480", "480p · 1.5 Mbps"),
        )
    }
}

/** "AC3" for audio/ac3 and the like. */
fun codecName(mime: String): String? = when (mime) {
    MimeTypes.AUDIO_AAC -> "AAC"
    MimeTypes.AUDIO_AC3 -> "AC3"
    MimeTypes.AUDIO_E_AC3, MimeTypes.AUDIO_E_AC3_JOC -> "E-AC3"
    MimeTypes.AUDIO_DTS, MimeTypes.AUDIO_DTS_HD -> "DTS"
    MimeTypes.AUDIO_TRUEHD -> "TrueHD"
    MimeTypes.AUDIO_OPUS -> "Opus"
    MimeTypes.AUDIO_VORBIS -> "Vorbis"
    MimeTypes.AUDIO_FLAC -> "FLAC"
    MimeTypes.AUDIO_MPEG -> "MP3"
    MimeTypes.AUDIO_RAW -> "PCM"
    MimeTypes.APPLICATION_SUBRIP -> "SRT"
    MimeTypes.TEXT_SSA -> "SSA"
    MimeTypes.TEXT_VTT -> null
    MimeTypes.APPLICATION_PGS -> "PGS"
    else -> null
}
