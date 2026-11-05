package app.reelhouse.android

import android.app.Application
import android.os.Build
import app.reelhouse.android.data.api.Http
import app.reelhouse.android.data.api.ReelhouseApi
import app.reelhouse.android.data.connection.ConnectionManager
import app.reelhouse.android.data.connection.RoutePlanner
import app.reelhouse.android.data.events.LiveUpdates
import app.reelhouse.android.data.events.ServerEvent
import app.reelhouse.android.data.downloads.DownloadManager
import app.reelhouse.android.data.downloads.DownloadStore
import app.reelhouse.android.data.downloads.FileDownloader
import app.reelhouse.android.data.downloads.downloadsToRemove
import app.reelhouse.android.data.update.AppUpdater
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import app.reelhouse.android.data.joinUrl
import app.reelhouse.android.data.pairing.Pairer
import app.reelhouse.android.data.pairing.PendingPairLink
import app.reelhouse.android.data.store.KeystoreSecretBox
import app.reelhouse.android.data.store.Prefs
import app.reelhouse.android.data.store.ServerStore
import app.reelhouse.android.data.tunnel.GoTunnels
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import java.io.File

/** The app's long-lived pieces, made once in [ReelhouseApp]. */
class AppContainer(app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val store = ServerStore(File(app.filesDir, "server.bin"), KeystoreSecretBox())
    val prefs = Prefs(app)
    val deviceName: String = deviceName()

    /** A message for the pairing screen, e.g. why this device was signed out. */
    val notice = MutableStateFlow<String?>(null)

    /** A reelhouse://pair link opened from outside the app, waiting to be used. */
    val pendingPairLink = MutableStateFlow<PendingPairLink?>(null)

    val http: OkHttpClient = Http.client(::tokenFor)
    val api: ReelhouseApi = ReelhouseApi(http, base = { connection.baseUrl }, onUnauthorized = ::signedOutByServer)
    val connection: ConnectionManager = ConnectionManager(app, store, api, RoutePlanner(GoTunnels), scope)
    val live = LiveUpdates(http, connection, scope)
    val downloadStore = DownloadStore(File(app.getExternalFilesDir(null) ?: app.filesDir, "downloads"))
    val fileDownloader = FileDownloader(http)
    val downloads = DownloadManager(app, downloadStore, prefs, connection, store)
    val updater = AppUpdater(app, connection, fileDownloader)

    /** Background chores that follow the sign-in and the connection. */
    fun start() {
        // Watch reports made offline go out once Reelhouse can be reached.
        scope.launch {
            connection.state.map { it.phase == ConnectionManager.Phase.Connected }.distinctUntilChanged().collect { connected ->
                if (connected) sendPendingReports()
            }
        }
        // Downloads belong to the sign-in: signing out (or being signed out) removes them, and so does pairing with
        // another Reelhouse.
        scope.launch {
            var before = store.profile.value
            store.profile.collect { after ->
                val all = downloadStore.downloads.value
                val gone = downloadsToRemove(before, after, all)
                if (gone.isNotEmpty() && gone.size == all.size) downloads.removeAll() else gone.forEach { downloads.remove(it.itemId) }
                before = after
            }
        }
        // Downloads turned off (or on), or Live TV, in Reelhouse show at once; after a gap in live updates, ask again.
        scope.launch {
            live.events.collect { e ->
                when (e) {
                    is ServerEvent.DefaultsChanged -> connection.serverDefaultsChanged(e.defaults)
                    ServerEvent.Resync, ServerEvent.LiveTvChanged -> connection.refreshServerDefaults()
                    is ServerEvent.RequestsChanged -> connection.requestsChanged(e.count)
                    else -> Unit
                }
            }
        }
        downloads.schedule() // carries on with anything queued before the app stopped
    }

    private suspend fun sendPendingReports() {
        for (r in downloadStore.pendingReports()) {
            val age = System.currentTimeMillis() - r.at
            runCatching { api.progress(r.itemId, r.position, r.duration, r.state, null, "download", "original", ageMs = age) }
                .onSuccess { downloadStore.reportSent(r) }
        }
    }

    fun pairer() = Pairer(api, GoTunnels, GoTunnels, deviceName)

    /** Full address of something on Reelhouse (an image, a stream) on the current route, or null when offline. */
    fun url(path: String?): String? {
        if (path.isNullOrEmpty()) return null
        return connection.baseUrl?.let { joinUrl(it, path) }
    }

    /** The token goes only to Reelhouse's current address, never anywhere else. */
    private fun tokenFor(url: HttpUrl): String? {
        val token = store.profile.value?.token ?: return null
        val base = connection.baseUrl?.toHttpUrlOrNull()?.toString()?.trimEnd('/') ?: return null
        val target = url.toString()
        return token.takeIf { target == base || target.startsWith("$base/") }
    }

    private fun signedOutByServer() {
        if (store.profile.value == null) return
        notice.value = "This device was signed out of Reelhouse. Pair it again to continue."
        store.clear()
    }

    private fun deviceName(): String {
        val maker = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.titlecase() }
        val model = Build.MODEL.orEmpty()
        return when {
            model.isEmpty() -> maker.ifEmpty { "Android" }
            model.startsWith(maker, ignoreCase = true) -> model
            else -> "$maker $model"
        }.take(60)
    }
}
