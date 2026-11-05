package app.reelhouse.android.data.downloads

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import app.reelhouse.android.data.connection.ConnectionManager
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.data.store.Prefs
import app.reelhouse.android.data.store.ServerProfile
import app.reelhouse.android.data.store.ServerStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Downloads that go when the sign-in changes from [before] to [after]: all of them on signing out (or being signed
 * out by Reelhouse), and those from another Reelhouse on pairing. A sign-in that couldn't be read when the app
 * started isn't a sign-out: pairing with the same Reelhouse again finds the downloads still there.
 */
fun downloadsToRemove(before: ServerProfile?, after: ServerProfile?, downloads: List<Download>): List<Download> = when {
    before != null && after == null -> downloads
    after?.serverId != null -> downloads.filter { it.serverId != null && it.serverId != after.serverId }
    else -> emptyList()
}

/**
 * Downloads for offline viewing: what's queued, downloading and done, and the background work that fetches them.
 * Only offered when the server allows downloads ("Allow downloads" in its settings); the server refuses them
 * otherwise anyway.
 */
class DownloadManager(
    private val context: Context,
    val store: DownloadStore,
    private val prefs: Prefs,
    private val connection: ConnectionManager,
    private val servers: ServerStore,
) {
    val downloads: StateFlow<List<Download>> = store.downloads

    /** Whether the server allows downloads, as last heard (false until it's known). */
    val allowed: Flow<Boolean> = connection.serverDefaults.map { it?.allowDownloads == true }

    fun isAllowed() = connection.serverDefaults.value?.allowDownloads == true

    /** Whether the server has said downloads are off (not just unknown, as when it can't be reached). */
    val turnedOff: Flow<Boolean> = connection.serverDefaults.map { it != null && !it.allowDownloads }

    fun get(itemId: Long) = store.get(itemId)

    /** Queues a movie or episode. Does nothing when the server doesn't allow downloads. */
    fun enqueue(item: Item, showTitle: String? = null, showId: Long? = null): Boolean {
        if (!isAllowed() || (item.type != "movie" && item.type != "episode")) return false
        if (store.get(item.id) != null) return true
        val name = "video" + (item.media?.container?.let { ".$it" } ?: "")
        store.add(
            Download(
                itemId = item.id,
                serverId = servers.profile.value?.serverId,
                item = item,
                showTitle = showTitle ?: item.show?.title,
                showId = showId ?: item.showId,
                file = File(store.folderFor(item.id), name).path,
            ),
        )
        schedule()
        return true
    }

    /** Queues every episode of a season that isn't downloaded yet. */
    fun enqueueAll(episodes: List<Item>, showTitle: String?, showId: Long?): Int =
        episodes.count { it.type == "episode" && store.get(it.id) == null && enqueue(it, showTitle, showId) }

    fun pause(itemId: Long) = store.update(itemId) { if (it.active) it.copy(state = DownloadState.Paused) else it }

    /**
     * Resumes a paused download or tries a failed one again. Allowed while the server can't be reached too:
     * the worker asks it before downloading anything.
     */
    fun resume(itemId: Long) {
        if (connection.serverDefaults.value?.allowDownloads == false) return
        store.update(itemId) { if (it.state == DownloadState.Paused || it.state == DownloadState.Failed) it.copy(state = DownloadState.Queued, error = null) else it }
        schedule()
    }

    fun remove(itemId: Long) = store.remove(itemId)

    /** Removes every download (also done on signing out). */
    fun removeAll() {
        WorkManager.getInstance(context).cancelUniqueWork(WORK)
        store.removeAll()
    }

    /** Starts (or carries on) the background work; [replace] applies a changed Wi-Fi-only setting. */
    fun schedule(replace: Boolean = false) {
        if (store.nextQueued() == null && !replace) return
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (prefs.wifiOnlyDownloads) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresStorageNotLow(true)
            .build()
        val request = OneTimeWorkRequestBuilder<DownloadWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        // Appending makes a download queued while the worker is finishing still get picked up.
        WorkManager.getInstance(context).enqueueUniqueWork(WORK, if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }

    companion object {
        const val WORK = "downloads"
    }
}
