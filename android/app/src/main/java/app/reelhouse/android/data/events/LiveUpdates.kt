package app.reelhouse.android.data.events

import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.connection.ConnectionManager
import app.reelhouse.android.data.joinUrl
import app.reelhouse.android.data.model.Defaults
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit

/** Something changed on the server that a screen may be showing. */
sealed interface ServerEvent {
    /** A library's items or metadata changed (null: a library was added or deleted). */
    data class LibraryChanged(val libraryId: Long?) : ServerEvent

    /** This user's watch state changed for these movies and episodes (e.g. watched on another device). */
    data class StateChanged(val itemIds: Set<Long>) : ServerEvent

    /** The server's choices for apps changed, e.g. downloads were turned off. */
    data class DefaultsChanged(val defaults: Defaults) : ServerEvent

    /** Live TV was turned on or off, or this account's Live TV switches changed: GET /api/me says what's allowed. */
    data object LiveTvChanged : ServerEvent

    /** Someone asked for a film, a request was removed, or a requested film arrived; [count] requests now. */
    data class RequestsChanged(val count: Int) : ServerEvent

    /** Events may have been missed (e.g. while the app was in the background): refresh everything. */
    data object Resync : ServerEvent
}

/** Parses one server-sent event (server/events.js). Null for events the app doesn't use. */
fun parseServerEvent(type: String?, data: String): ServerEvent? = runCatching {
    val obj = AppJson.parseToJsonElement(data).jsonObject
    when (type) {
        "library" -> ServerEvent.LibraryChanged(
            if (obj["deleted"]?.jsonPrimitive?.booleanOrNull == true) null else obj.long("libraryId"),
        )
        "state" -> ServerEvent.StateChanged(obj["itemIds"]?.jsonArray?.mapNotNull { it.jsonPrimitive.longOrNull }?.toSet() ?: emptySet())
        "defaults" -> ServerEvent.DefaultsChanged(AppJson.decodeFromJsonElement(Defaults.serializer(), obj))
        "livetv" -> ServerEvent.LiveTvChanged
        "requests" -> ServerEvent.RequestsChanged(obj.long("count")?.toInt() ?: 0)
        else -> null
    }
}.getOrNull()

private fun JsonObject.long(key: String) = this[key]?.jsonPrimitive?.longOrNull

/**
 * Keeps Reelhouse's live update stream (GET /api/events) open while the app is on screen and connected, on whatever
 * route is current, and passes the events on.
 */
class LiveUpdates(client: OkHttpClient, private val connection: ConnectionManager, private val scope: CoroutineScope) {
    // The server sends a keepalive every 25 s; a minute of silence means the connection is dead.
    private val sse = EventSources.createFactory(client.newBuilder().readTimeout(70, TimeUnit.SECONDS).build())
    private val _events = MutableSharedFlow<ServerEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<ServerEvent> = _events.asSharedFlow()

    private val foreground = MutableStateFlow(true)
    @Volatile private var connectedBefore = false
    private var job: Job? = null

    fun start() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                foreground.value = true
            }

            override fun onStop(owner: LifecycleOwner) {
                foreground.value = false
            }
        })
        job = scope.launch {
            combine(connection.state, foreground) { state, fg -> state.route?.baseUrl.takeIf { fg } }
                .distinctUntilChanged()
                .collectLatest { base -> if (base != null) stream(base) }
        }
    }

    /** Streams from [base] until cancelled (route change, background), reconnecting after drops. */
    private suspend fun stream(base: String) {
        var source: EventSource? = null
        try {
            while (true) {
                val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
                val request = Request.Builder().url(joinUrl(base, "/api/events")).header("Accept", "text/event-stream").build()
                source = sse.newEventSource(request, object : EventSourceListener() {
                    override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                        if (type == "hello") {
                            // Watch-state changes don't show in the server's version, so after any gap (a drop,
                            // the background, a new route) screens refresh rather than trust they missed nothing.
                            if (connectedBefore) _events.tryEmit(ServerEvent.Resync)
                            connectedBefore = true
                            return
                        }
                        parseServerEvent(type, data)?.let { _events.tryEmit(it) }
                    }

                    override fun onClosed(eventSource: EventSource) {
                        closed.complete(Unit)
                    }

                    override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                        if (response?.code == 401) Log.i(TAG, "live updates refused (signed out?)")
                        closed.complete(Unit)
                    }
                })
                closed.await()
                delay(RETRY_MS)
            }
        } finally {
            source?.cancel()
        }
    }

    companion object {
        private const val TAG = "Reelhouse"
        const val RETRY_MS = 5_000L
    }
}
