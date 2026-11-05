package app.reelhouse.android.data.connection

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.reelhouse.android.data.api.ReelhouseApi
import app.reelhouse.android.data.store.ServerProfile
import app.reelhouse.android.data.store.ServerStore
import app.reelhouse.android.data.tunnel.ActiveTunnel
import app.reelhouse.android.data.tunnel.TunnelStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.first
import app.reelhouse.android.data.model.AppRelease
import app.reelhouse.android.data.model.Defaults
import app.reelhouse.android.data.model.LiveTvAccess
import app.reelhouse.android.data.model.RequestsAccess
import app.reelhouse.android.data.model.ServerInfo
import java.util.concurrent.atomic.AtomicInteger

/**
 * Keeps a route to the paired Reelhouse: picks one at start, on every network change and when asked (e.g. after a
 * request failed), runs the tunnel when that's the route, and stops it a while after the app leaves the screen.
 */
class ConnectionManager(
    private val context: Context,
    private val store: ServerStore,
    private val api: ReelhouseApi,
    private val planner: RoutePlanner,
    private val scope: CoroutineScope,
) {
    enum class Phase { SignedOut, Connecting, Connected, Offline }

    data class State(val phase: Phase, val route: Route? = null, val problem: String? = null)

    private val _state = MutableStateFlow(State(if (store.profile.value == null) Phase.SignedOut else Phase.Connecting))
    val state: StateFlow<State> = _state.asStateFlow()

    /** Reelhouse's address on the current route, or null when there's none. */
    val baseUrl: String? get() = _state.value.route?.baseUrl

    /** Auto, or tunnel-only for testing the tunnel at home. */
    var mode: RouteMode = RouteMode.Auto
        set(value) {
            field = value
            reconnect()
        }

    /** The server's defaults for this user (e.g. whether downloads are allowed), read on each connect. */
    private val _serverDefaults = MutableStateFlow<Defaults?>(null)
    val serverDefaults: StateFlow<Defaults?> = _serverDefaults.asStateFlow()

    /** The Android app the server offers (for updating this one), read on each connect. */
    private val _appRelease = MutableStateFlow<AppRelease?>(null)
    val appRelease: StateFlow<AppRelease?> = _appRelease.asStateFlow()

    /** Live TV and Radio for this account (shown in the sidebar), read on each connect and when the server says. */
    private val _liveTv = MutableStateFlow(LiveTvAccess())
    val liveTv: StateFlow<LiveTvAccess> = _liveTv.asStateFlow()

    /** Requested films (the sidebar's Requests and its count), read on each connect and kept up by live updates. */
    private val _requests = MutableStateFlow(RequestsAccess())
    val requests: StateFlow<RequestsAccess> = _requests.asStateFlow()

    private val lock = Mutex()
    private val holds = AtomicInteger(0)
    private val triggers = Channel<Unit>(Channel.CONFLATED)
    @Volatile private var tunnel: ActiveTunnel? = null
    @Volatile private var networkChanged = false
    @Volatile private var foreground = true
    private var pauseJob: Job? = null
    private var retryJob: Job? = null
    private var offlineRetryMs = OFFLINE_RETRY_FIRST_MS

    fun start() {
        scope.launch { for (t in triggers) evaluate() }
        scope.launch {
            store.profile.map { it?.token }.distinctUntilChanged().collect { token ->
                if (token == null) {
                    lock.withLock {
                        stopTunnel()
                        _serverDefaults.value = null
                        _appRelease.value = null
                        _liveTv.value = LiveTvAccess()
                        _requests.value = RequestsAccess()
                        _state.value = State(Phase.SignedOut)
                    }
                } else {
                    reconnect()
                }
            }
        }
        val cm = context.getSystemService(ConnectivityManager::class.java)
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = onNetworkChange()
            override fun onLost(network: Network) = onNetworkChange()
        })
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                foreground = true
                pauseJob?.cancel()
                if (_state.value.phase != Phase.Connected) reconnect() else scope.launch { refreshServerDefaults() }
            }

            override fun onStop(owner: LifecycleOwner) {
                foreground = false
                schedulePause()
            }
        })
    }

    /** Stops the tunnel a minute after the app leaves the screen, unless something holds the connection. */
    private fun schedulePause() {
        pauseJob?.cancel()
        pauseJob = scope.launch {
            delay(PAUSE_AFTER_MS)
            lock.withLock {
                if (!foreground && holds.get() == 0 && tunnel != null) {
                    // No need to keep WireGuard's keepalives going while nobody looks.
                    stopTunnel()
                    _state.value = State(Phase.Connecting)
                }
            }
        }
    }

    /**
     * Keeps the connection (and the tunnel) up while the app isn't on screen, e.g. for downloads. Close the
     * returned handle when done.
     */
    fun hold(): AutoCloseable {
        holds.incrementAndGet()
        pauseJob?.cancel()
        if (_state.value.phase != Phase.Connected) reconnect()
        var closed = false
        return AutoCloseable {
            if (!closed) {
                closed = true
                if (holds.decrementAndGet() == 0 && !foreground) schedulePause()
            }
        }
    }

    /** The current route's address, waiting up to [timeoutMs] for one. */
    suspend fun awaitRoute(timeoutMs: Long): String? {
        baseUrl?.let { return it }
        reconnect()
        return withTimeoutOrNull(timeoutMs) { state.first { it.phase == Phase.Connected && it.route != null }.route?.baseUrl }
    }

    /** Reads the server's defaults, the app it offers, Live TV and your account (its picture can change on the web) again. */
    suspend fun refreshServerDefaults() {
        runCatching { api.me() }.onSuccess {
            _serverDefaults.value = it.defaults
            _appRelease.value = it.androidApp
            _liveTv.value = it.liveTv
            _requests.value = it.requests
            store.updateUser(it.user)
        }
    }

    /** The number of requests changed (a live update). */
    fun requestsChanged(count: Int) {
        if (store.profile.value != null) _requests.value = _requests.value.copy(count = count)
    }

    /** The server announced new defaults (a live update). */
    fun serverDefaultsChanged(defaults: Defaults) {
        if (store.profile.value != null) _serverDefaults.value = defaults
    }

    /** Checks the route again (coalesced: many calls while one runs make one more check). */
    fun reconnect() {
        triggers.trySend(Unit)
    }

    private fun onNetworkChange() {
        networkChanged = true
        reconnect()
    }

    fun tunnelStatus(): TunnelStatus? = tunnel?.status()

    private suspend fun evaluate() = lock.withLock {
        val profile = store.profile.value ?: return@withLock
        if (_state.value.phase != Phase.Connected) _state.value = State(Phase.Connecting)
        if (networkChanged) {
            networkChanged = false
            delay(NETWORK_SETTLE_MS) // the new network's addresses and DNS take a moment
            tunnel?.let { t ->
                runCatching { t.rebind() }
                profile.tunnel?.let { runCatching { t.setEndpoint(it.endpoint) } } // re-resolves a dynamic DNS name
            }
        }
        val choice = try {
            withContext(Dispatchers.IO) { planner.choose(profile, tunnel, mode, proberFor(profile)) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Never let one failed check end the loop that keeps the route (or crash the app).
            Log.w(TAG, "route check failed", e)
            RoutePlanner.Choice(null, tunnel, "Reelhouse can't be reached: ${e.message}")
        }
        tunnel = choice.tunnel
        if (store.profile.value?.token != profile.token) {
            // Signed out (or paired again) meanwhile.
            stopTunnel()
            return@withLock
        }
        _state.value = if (choice.route != null) State(Phase.Connected, choice.route) else State(Phase.Offline, problem = choice.problem)
        Log.i(TAG, "route: ${choice.route?.javaClass?.simpleName ?: "none (${choice.problem})"}")
        scheduleOfflineRetry(offline = choice.route == null)
        if (choice.route != null) scope.launch {
            refreshTunnelSettings()
            refreshServerDefaults()
        }
    }

    /**
     * While offline and on screen, looks again now and then (30 s, doubling to 5 min): Reelhouse may be back
     * without the phone's network changing, and downloads can be watched meanwhile.
     */
    private fun scheduleOfflineRetry(offline: Boolean) {
        retryJob?.cancel()
        if (!offline) {
            offlineRetryMs = OFFLINE_RETRY_FIRST_MS
            return
        }
        val wait = offlineRetryMs
        offlineRetryMs = (wait * 2).coerceAtMost(OFFLINE_RETRY_MAX_MS)
        retryJob = scope.launch {
            delay(wait)
            if (foreground && _state.value.phase == Phase.Offline) reconnect()
        }
    }

    /** Reelhouse answers at the address, and (if both know it) it's the same Reelhouse as the one paired. */
    private fun proberFor(profile: ServerProfile) = Prober { base, timeoutMs ->
        val info = api.serverInfo(base, timeoutMs)
        isPairedServer(profile.serverId, info).also { paired -> if (paired) noteServerName(info) }
    }

    /**
     * An admin can rename Reelhouse (Settings → General), e.g. "my-server" to "My-Server": the name stored at pairing follows,
     * so Home and Settings show the current one.
     */
    private suspend fun noteServerName(info: ServerInfo) {
        val stored = store.profile.value?.serverName ?: return
        val name = renamedTo(stored, info) ?: return
        withContext(Dispatchers.IO) { store.update { it.copy(serverName = name) } }
    }

    /** The home IP or the endpoint may have changed since pairing: take the server's current tunnel settings. */
    private suspend fun refreshTunnelSettings() {
        val current = store.profile.value?.tunnel ?: return
        val fresh = runCatching { api.tunnel() }.getOrNull() ?: return
        val updated = current.updatedFrom(fresh)
        if (updated == current) return
        store.update { it.copy(tunnel = updated) }
        if (updated.endpoint != current.endpoint) tunnel?.let { t -> runCatching { t.setEndpoint(updated.endpoint) } }
    }

    private fun stopTunnel() {
        tunnel?.stop()
        tunnel = null
    }

    /** Signs this device out of Reelhouse (best effort) and forgets the server. */
    suspend fun signOut() {
        val profile = store.profile.value ?: return
        baseUrl?.let { b -> runCatching { api.logout(b, profile.token) } }
        store.clear()
    }

    companion object {
        private const val TAG = "Reelhouse"
        const val PAUSE_AFTER_MS = 60_000L
        const val NETWORK_SETTLE_MS = 700L
        const val OFFLINE_RETRY_FIRST_MS = 30_000L
        const val OFFLINE_RETRY_MAX_MS = 300_000L
    }
}
