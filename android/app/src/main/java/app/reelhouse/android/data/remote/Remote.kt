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
import java.util.concurrent.ConcurrentHashMap

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
    /** How old the report was when the server sent it (ms). */
    val age: Long = 0,
) {
    val paused: Boolean get() = state == "paused"

    /** "A Show · S1 · E3" for an episode, else nothing (the title says it). */
    val showLine: String?
        get() = show?.let { s -> listOfNotNull(s, season?.let { "S$it" }, episode?.let { "E$it" }).joinToString(" · ") }
}

/** A device the phone can control. [kind]: web | kodi | tv | phone. */
@Serializable
data class RemoteTarget(val id: String, val kind: String, val name: String, val state: RemoteState? = null)

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
    /** The phone's name. */
    val from: String? = null,
)

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

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)

    /** Things to tell the person: a device that went away, one that couldn't do something. */
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    private val waiting = ConcurrentHashMap<String, String>() // command id → the device's name, until it answers

    fun start() {
        scope.launch {
            live.events.collect { e ->
                when (e) {
                    ServerEvent.RemoteTargetsChanged, ServerEvent.Resync -> refresh()
                    is ServerEvent.RemoteStateChanged -> stateChanged(e.targetId, e.state)
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
        }
    }

    fun connect(target: RemoteTarget) {
        _active.value = target
        _playback.value = target.state?.let { Playback(it, clock()) }
    }

    fun disconnect() {
        _active.value = null
        _playback.value = null
    }

    private fun stateChanged(targetId: String, state: RemoteState?) {
        _targets.value = _targets.value.map { if (it.id == targetId) it.copy(state = state) else it }
        if (_active.value?.id == targetId) _playback.value = state?.let { Playback(it, clock()) }
    }

    private fun answered(e: ServerEvent.RemoteDone) {
        val name = waiting.remove(e.id) ?: return
        if (!e.ok) _messages.tryEmit(problemText(name, e.problem))
    }

    fun play(itemId: Long, start: Double) = send("play", itemId = itemId, start = start.coerceAtLeast(0.0))
    fun pause() = send("pause")
    fun resume() = send("resume")
    fun seek(position: Double) = send("seek", position = position.coerceAtLeast(0.0))
    fun skip(seconds: Double) = send("skip", seconds = seconds)
    fun stop() = send("stop")
    fun next() = send("next")
    fun previous() = send("previous")

    /** Where the active device is now, running on from its last report. */
    fun position(): Double? = _playback.value?.positionAt(clock())

    private fun send(type: String, itemId: Long? = null, start: Double? = null, position: Double? = null, seconds: Double? = null) {
        val target = _active.value ?: return
        expect(type, position, seconds)
        scope.launch {
            try {
                val id = api.remoteCommand(target.id, type, itemId, start, position, seconds)
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
    private fun expect(type: String, position: Double?, seconds: Double?) {
        val now = clock()
        val p = _playback.value ?: return
        val at = p.positionAt(now)
        val state = when (type) {
            "pause" -> p.state.copy(state = "paused", position = at, age = 0)
            "resume" -> p.state.copy(state = "playing", position = at, age = 0)
            "seek" -> p.state.copy(position = position ?: at, age = 0)
            "skip" -> p.state.copy(position = (at + (seconds ?: 0.0)).coerceAtLeast(0.0), age = 0)
            else -> return
        }
        _playback.value = Playback(state, now)
    }

    companion object {
        const val ANSWER_WITHIN_MS = 20_000L
    }
}

/**
 * A device's side: commands from a phone arrive here (LiveUpdates). A play opens the player (ui/Root.kt); the rest
 * go to the player on screen, which sets [player] while it's open: it does the command and says what went wrong, or
 * null when it's done.
 */
class RemoteReceiver(private val api: ReelhouseApi, private val scope: CoroutineScope) {
    private val _commands = MutableSharedFlow<RemoteCommand>(extraBufferCapacity = 16)
    val commands: SharedFlow<RemoteCommand> = _commands.asSharedFlow()

    @Volatile
    var player: ((RemoteCommand) -> String?)? = null

    fun received(command: RemoteCommand) {
        _commands.tryEmit(command)
    }

    /** Answers a command (null [problem]: done), for the phone that sent it. */
    fun done(command: RemoteCommand, problem: String? = null) {
        scope.launch { runCatching { api.remoteDone(command.id, problem) } }
    }
}
