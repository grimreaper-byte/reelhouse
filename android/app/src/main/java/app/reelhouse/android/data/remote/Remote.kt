package app.reelhouse.android.data.remote

import android.os.SystemClock
import app.reelhouse.android.data.api.ApiException
import app.reelhouse.android.data.api.ReelhouseApi
import app.reelhouse.android.data.connection.ConnectionManager
import app.reelhouse.android.data.events.LiveUpdates
import app.reelhouse.android.data.events.ServerEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.roundToInt

// The phone remote (server/remote.js): this phone plays things on, and controls, the person's other Reelhouse devices
// on the same network: a web tab, Kodi with the add-on, the app on a TV box. RemoteControl is the phone's side;
// RemoteReceiver is a TV box's (or a phone's, when switched on in Settings), which takes the commands.

/** What a device is playing, from its last progress report (server/remote.js stateOf). */
@Serializable
data class RemoteState(
    val itemId: Long? = null,
    val title: String? = null,
    val show: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val position: Double? = null,
    val duration: Double? = null,
    /** playing | paused */
    val state: String = "playing",
    val live: Boolean = false,
    /** A channel playing (since server 0.26.0): its id, whether it's radio, and the programme on when it started. */
    val channel: String? = null,
    val radio: Boolean = false,
    val programme: String? = null,
    /** How old the report was when the server sent it (ms). */
    val age: Long = 0,
) {
    val paused: Boolean get() = state == "paused"

    /** "A Show · S1 · E3" for an episode, else nothing (the title says it). */
    val showLine: String?
        get() = show?.let { s -> listOfNotNull(s, season?.let { "S$it" }, episode?.let { "E$it" }).joinToString(" · ") }

    /** The line under the title: an episode's show and number, or what's on a channel. */
    val secondLine: String? get() = if (live) programme else showLine
}

/** An audio or subtitle track a device offers the phone ([id] is the device's own). */
@Serializable
data class RemoteTrack(val id: String, val label: String)

/**
 * What the phone may change on a device (since server 0.26.0; server/remote.js cleanControls): its audio and subtitle
 * tracks and which are on ([subtitleId] null: off), its volume (0–100; null when it can't be set from here), and
 * whether what plays can pause.
 */
@Serializable
data class RemoteControls(
    val audio: List<RemoteTrack> = emptyList(),
    val audioId: String? = null,
    val subtitles: List<RemoteTrack> = emptyList(),
    val subtitleId: String? = null,
    val volume: Int? = null,
    val muted: Boolean = false,
    val canPause: Boolean = true,
) {
    /** Worth the Audio & subtitles sheet: more than one sound track, or any subtitles. */
    val hasTracks: Boolean get() = audio.size > 1 || subtitles.isNotEmpty()
}

/**
 * A device the phone can control. [kind]: web | kodi | tv | phone. [owner]: whose it is, when it's someone else's
 * that they share with anyone at home (it plays as their account).
 */
@Serializable
data class RemoteTarget(
    val id: String,
    val kind: String,
    val name: String,
    val owner: String? = null,
    val state: RemoteState? = null,
    val controls: RemoteControls? = null,
) {
    /** "Living room TV · dave's" for someone else's. */
    val label: String get() = owner?.let { "$name · $it's" } ?: name
}

@Serializable
data class RemoteTargetsResponse(val targets: List<RemoteTarget> = emptyList())

@Serializable
data class RemoteCommandSent(val commandId: String)

/** A command from a phone, as a device receives it (the stream's remote event). */
@Serializable
data class RemoteCommand(
    val id: String,
    val type: String,
    val itemId: Long? = null,
    val start: Double? = null,
    val position: Double? = null,
    val seconds: Double? = null,
    /** The phone's name ("sam's Galaxy" from someone else's phone). */
    val from: String? = null,
    /** A channel to play (since server 0.26.0), radio or not; [zap]: channel up/down in the channel player open. */
    val channel: String? = null,
    val radio: Boolean = false,
    val name: String? = null,
    val zap: Boolean = false,
    /** An audio or subtitle track to show (as this device named it in its controls; null subtitles: off). */
    val track: String? = null,
    /** The volume (0–100), or muted. */
    val level: Int? = null,
    val muted: Boolean? = null,
)

/** A volume button press on the phone while its remote screen is open: 5 up or down, within 0–100. */
fun stepVolume(level: Int, up: Boolean): Int = (level + if (up) 5 else -5).coerceIn(0, 100)

/**
 * A player's volume as the phone remote sets it: 0–100, or muted (the level kept for when it's unmuted). Kept
 * outside the player, which only has a level: muting sets it to 0.
 */
class RemoteVolume(private val get: () -> Float, private val set: (Float) -> Unit) {
    var muted = false
        private set
    private var kept = 1f

    /** 0–100 (what it'll go back to while muted). */
    fun level(): Int = ((if (muted) kept else get()) * 100).roundToInt()

    fun setLevel(level: Int) {
        val v = level.coerceIn(0, 100) / 100f
        muted = v == 0f
        if (v > 0f) kept = v
        set(v)
    }

    fun setMuted(on: Boolean) {
        if (on == muted) return
        if (on) {
            get().takeIf { it > 0f }?.let { kept = it }
            set(0f)
        } else {
            set(kept.takeIf { it > 0f } ?: 1f)
        }
        muted = on
    }
}

/**
 * Where playback is [sinceMs] after a report arrived, running on while it plays (the report was already [age] old
 * when sent), never past the end.
 */
fun runOn(state: RemoteState, sinceMs: Long): Double {
    val at = state.position ?: 0.0
    if (state.state != "playing") return at
    val moved = at + (state.age + sinceMs).coerceAtLeast(0) / 1000.0
    return state.duration?.takeIf { it > 0 }?.let { moved.coerceAtMost(it) } ?: moved
}

/** What the phone says when a device couldn't do something (server/remote.js commandDone's problem). */
fun problemText(name: String, problem: String?): String = when (problem) {
    "blocked" -> "$name needs a press of Play: browsers don't start videos by themselves"
    null, "" -> "$name couldn't do that"
    else -> problem
}

/** A device's last report and when it arrived (elapsedRealtime), so the position can run on between reports. */
data class Playback(val state: RemoteState, val receivedAt: Long) {
    fun positionAt(now: Long): Double = runOn(state, now - receivedAt)
}

/** The phone's side: the devices it may control, the one it plays on, and the commands. */
class RemoteControl(
    private val api: ReelhouseApi,
    private val live: LiveUpdates,
    private val connection: ConnectionManager,
    private val scope: CoroutineScope,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
) {
    private val _targets = MutableStateFlow<List<RemoteTarget>>(emptyList())

    /** The person's devices on this network (none on an older Reelhouse, or away from them all). */
    val targets: StateFlow<List<RemoteTarget>> = _targets.asStateFlow()

    private val _active = MutableStateFlow<RemoteTarget?>(null)

    /** The device Play goes to (null: this phone). */
    val active: StateFlow<RemoteTarget?> = _active.asStateFlow()

    private val _playback = MutableStateFlow<Playback?>(null)

    /** What the active device is playing (null: nothing). */
    val playback: StateFlow<Playback?> = _playback.asStateFlow()

    private val _controls = MutableStateFlow<RemoteControls?>(null)

    /** What the phone may change on the active device: tracks, volume (null: nothing, or a device from before 0.26.0). */
    val controls: StateFlow<RemoteControls?> = _controls.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)

    /** Things to tell the person: a device that went away, one that couldn't do something. */
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    private val waiting = ConcurrentHashMap<String, String>() // command id → the device's name, until it answers

    fun start() {
        scope.launch {
            live.events.collect { e ->
                when (e) {
                    ServerEvent.RemoteTargetsChanged, ServerEvent.Resync -> refresh()
                    is ServerEvent.RemoteStateChanged -> stateChanged(e.targetId, e.state, e.controls)
                    is ServerEvent.RemoteDone -> answered(e)
                    else -> Unit
                }
            }
        }
        scope.launch {
            connection.state.map { it.route?.baseUrl }.distinctUntilChanged().collectLatest { base ->
                if (base == null) _targets.value = emptyList() else refresh()
            }
        }
    }

    /** Asks Reelhouse again which devices there are. */
    suspend fun refresh() {
        val list = try {
            api.remoteTargets()
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            if (e.status != 404) return
            emptyList() // a Reelhouse from before the phone remote
        } catch (_: Exception) {
            return
        }
        _targets.value = list
        val was = _active.value ?: return
        // The same device, maybe on a new stream (its page or app reconnected).
        val now = list.firstOrNull { it.id == was.id } ?: list.firstOrNull { it.kind == was.kind && it.name == was.name }
        if (now == null) {
            disconnect()
            _messages.tryEmit("${was.name} isn't there any more")
        } else {
            _active.value = now
            _playback.value = now.state?.let { Playback(it, clock()) }
            _controls.value = now.controls
        }
    }

    fun connect(target: RemoteTarget) {
        _active.value = target
        _playback.value = target.state?.let { Playback(it, clock()) }
        _controls.value = target.controls
    }

    fun disconnect() {
        _active.value = null
        _playback.value = null
        _controls.value = null
    }

    private fun stateChanged(targetId: String, state: RemoteState?, controls: RemoteControls?) {
        _targets.value = _targets.value.map { if (it.id == targetId) it.copy(state = state, controls = controls) else it }
        if (_active.value?.id == targetId) {
            _playback.value = state?.let { Playback(it, clock()) }
            _controls.value = controls
        }
    }

    private fun answered(e: ServerEvent.RemoteDone) {
        val name = waiting.remove(e.id) ?: return
        if (!e.ok) _messages.tryEmit(problemText(name, e.problem))
    }

    fun play(itemId: Long, start: Double) = send(command("play") { put("itemId", itemId); put("start", start.coerceAtLeast(0.0)) })

    /** A live channel or radio station, on the active device. */
    fun playChannel(uuid: String) = send(command("play") { put("channel", uuid) })
    fun pause() = send(command("pause"))
    fun resume() = send(command("resume"))
    fun seek(position: Double) = send(command("seek") { put("position", position.coerceAtLeast(0.0)) })
    fun skip(seconds: Double) = send(command("skip") { put("seconds", seconds) })
    fun stop() = send(command("stop"))

    /** The next episode, or the next channel while one plays (the server works out which). */
    fun next() = send(command("next"))
    fun previous() = send(command("previous"))

    /** An audio track the device offered (its [RemoteControls]). */
    fun audio(id: String) = send(command("audio") { put("track", id) })

    /** Subtitles the device offered, or off (null). */
    fun subtitle(id: String?) = send(command("subtitle") { put("track", id) })
    fun volume(level: Int) = send(command("volume") { put("level", level.coerceIn(0, 100)) })
    fun mute(muted: Boolean) = send(command("mute") { put("muted", muted) })

    /** A phone volume button pressed on the remote screen: the device's volume 5 up or down. */
    fun nudgeVolume(up: Boolean) {
        val level = _controls.value?.takeIf { it.volume != null }?.let { if (it.muted) 0 else it.volume } ?: return
        volume(stepVolume(level, up))
    }

    /** Where the active device is now, running on from its last report. */
    fun position(): Double? = _playback.value?.positionAt(clock())

    private fun command(type: String, more: JsonObjectBuilder.() -> Unit = {}): JsonObject = buildJsonObject {
        put("type", type)
        more()
    }

    private fun send(body: JsonObject) {
        val target = _active.value ?: return
        expect(body)
        scope.launch {
            try {
                val id = api.remoteCommand(target.id, body)
                waiting[id] = target.name
                delay(ANSWER_WITHIN_MS)
                if (waiting.remove(id) != null) _messages.tryEmit("No answer from ${target.name}")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _messages.tryEmit(e.message ?: "${target.name} couldn't be reached")
                if (e is ApiException && e.status == 404) refresh()
            }
        }
    }

    /** Shows what a command will do straight away; the device's own report follows within a moment. */
    private fun expect(body: JsonObject) {
        val type = body.string("type")
        _controls.value?.let { c ->
            _controls.value = when (type) {
                "volume" -> body.int("level")?.let { c.copy(volume = it, muted = it == 0) } ?: c
                "mute" -> c.copy(muted = body["muted"]?.jsonPrimitive?.booleanOrNull == true)
                "audio" -> c.copy(audioId = body.string("track"))
                "subtitle" -> c.copy(subtitleId = body.string("track"))
                else -> c
            }
        }
        val now = clock()
        val p = _playback.value ?: return
        val at = p.positionAt(now)
        val state = when (type) {
            "pause" -> p.state.copy(state = "paused", position = at, age = 0)
            "resume" -> p.state.copy(state = "playing", position = at, age = 0)
            "seek" -> p.state.copy(position = body.double("position") ?: at, age = 0)
            "skip" -> p.state.copy(position = (at + (body.double("seconds") ?: 0.0)).coerceAtLeast(0.0), age = 0)
            else -> return
        }
        _playback.value = Playback(state, now)
    }

    private fun JsonObject.string(key: String) = this[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
    private fun JsonObject.int(key: String) = this[key]?.jsonPrimitive?.intOrNull
    private fun JsonObject.double(key: String) = this[key]?.jsonPrimitive?.doubleOrNull

    companion object {
        const val ANSWER_WITHIN_MS = 20_000L
    }
}

/**
 * A device's side: commands from a phone arrive here (LiveUpdates). A play opens the player (ui/Root.kt); the rest
 * go to the player on screen, which sets [player] while it's open: it does the command and says what went wrong, or
 * null when it's done.
 */
class RemoteReceiver(
    private val api: ReelhouseApi,
    private val scope: CoroutineScope,
    /** Whether phones may control this device now (Settings): only then is what it offers sent. */
    private val isTarget: () -> Boolean = { true },
) {
    private val _commands = MutableSharedFlow<RemoteCommand>(extraBufferCapacity = 16)
    val commands: SharedFlow<RemoteCommand> = _commands.asSharedFlow()

    @Volatile
    var player: ((RemoteCommand) -> String?)? = null

    @Volatile
    private var offered: RemoteControls? = null
    private var sent: Any? = NOTHING_SENT
    private var reportJob: kotlinx.coroutines.Job? = null

    fun received(command: RemoteCommand) {
        _commands.tryEmit(command)
    }

    /** Answers a command (null [problem]: done), for the phone that sent it. */
    fun done(command: RemoteCommand, problem: String? = null) {
        scope.launch { runCatching { api.remoteDone(command.id, problem) } }
    }

    /**
     * What the player on screen offers the phone now (null: nothing plays): told to Reelhouse a moment later, once
     * for a burst of changes, and only when it differs from what was told last.
     */
    fun offer(controls: RemoteControls?) {
        offered = controls
        reportJob?.cancel()
        reportJob = scope.launch {
            delay(REPORT_AFTER_MS)
            val now = offered
            if (!isTarget() || now == sent) return@launch
            runCatching { api.remoteStatus(now) }.onSuccess { sent = now }
        }
    }

    /** A new event stream (remote-hello): Reelhouse hears again what's offered. */
    fun hello() {
        sent = NOTHING_SENT
        offer(offered)
    }

    private companion object {
        const val REPORT_AFTER_MS = 300L
        val NOTHING_SENT = Any()
    }
}
