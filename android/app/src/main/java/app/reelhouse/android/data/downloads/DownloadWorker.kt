package app.reelhouse.android.data.downloads

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import app.reelhouse.android.R
import app.reelhouse.android.container
import app.reelhouse.android.data.joinUrl
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.data.playback.SubtitleTrack
import app.reelhouse.android.ui.components.sizedImagePath
import app.reelhouse.android.ui.player.subtitleLabel
import kotlinx.coroutines.CancellationException
import java.io.File

/** Works through the download queue in the background, as a foreground service with a progress notification. */
class DownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val c = context.container
    private val store = c.downloads.store
    private var lastNotice = 0L

    override suspend fun doWork(): Result {
        if (store.nextQueued() == null) return Result.success()
        runCatching { setForeground(foregroundInfo("Preparing downloads…", null)) }
        c.connection.hold().use {
            while (true) {
                val d = store.nextQueued() ?: return Result.success()
                val base = c.connection.awaitRoute(ROUTE_WAIT_MS) ?: return Result.retry()
                // Ask now rather than trust what was heard earlier: downloads may have been turned off since.
                val allowed = try {
                    c.api.me().defaults.allowDownloads
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    return Result.retry()
                }
                if (!allowed) {
                    stopQueue(TURNED_OFF)
                    return Result.success()
                }
                when (val outcome = fetch(d, base)) {
                    is FileDownloader.Outcome.Done -> Unit
                    // Paused or removed, or downloads were just turned off (asked again at the top of the loop).
                    FileDownloader.Outcome.Stopped -> store.update(d.itemId) { if (it.state == DownloadState.Downloading) it.copy(state = DownloadState.Queued) else it }
                    is FileDownloader.Outcome.Refused -> when (outcome.status) {
                        403 -> {
                            stopQueue(TURNED_OFF)
                            return Result.success()
                        }
                        404 -> fail(d, "It's no longer on Reelhouse.")
                        410 -> fail(d, outcome.message ?: "Reelhouse can't reach the file right now.")
                        else -> fail(d, outcome.message ?: "Reelhouse answered ${outcome.status}.")
                    }
                    is FileDownloader.Outcome.Failed -> {
                        Log.w(TAG, "download of ${d.itemId} interrupted", outcome.error)
                        store.update(d.itemId) { it.copy(state = DownloadState.Queued, error = "Waiting to continue (${outcome.error.message})") }
                        return Result.retry()
                    }
                }
            }
        }
    }

    private suspend fun fetch(queued: Download, base: String): FileDownloader.Outcome {
        var d = queued
        if (File(d.file).extension.isEmpty()) {
            // Queued from a list without file details (a season's episodes): name it after its container.
            runCatching { c.api.item(d.itemId).item.media?.container }.getOrNull()?.let { container ->
                val named = File(File(d.file).parentFile, "video.$container").path
                store.update(d.itemId) { it.copy(file = named) }
                d = d.copy(file = named)
            }
        }
        store.update(d.itemId) { it.copy(state = DownloadState.Downloading, error = null) }
        val part = File(d.file + ".part")
        val outcome = c.fileDownloader.download(
            joinUrl(base, "/api/stream/${d.itemId}?download=1"),
            part,
            onProgress = { done, total ->
                store.update(d.itemId) { it.copy(downloadedBytes = done, totalBytes = if (total > 0) total else it.totalBytes) }
                notifyProgress(d, done, total)
            },
            shouldStop = { store.get(d.itemId)?.state != DownloadState.Downloading || c.connection.serverDefaults.value?.allowDownloads == false },
        )
        if (outcome is FileDownloader.Outcome.Done) {
            if (!part.renameTo(File(d.file))) {
                fail(d, "Couldn't save the file.")
                return outcome
            }
            val extras = runCatching { saveExtras(d, base) }.getOrNull()
            store.update(d.itemId) {
                it.copy(
                    state = DownloadState.Done,
                    downloadedBytes = outcome.bytes,
                    totalBytes = outcome.bytes,
                    completedAt = System.currentTimeMillis(),
                    item = extras?.item ?: it.item,
                    poster = extras?.poster ?: it.poster,
                    thumb = extras?.thumb ?: it.thumb,
                    subtitles = extras?.subtitles ?: it.subtitles,
                )
            }
            Log.i(TAG, "downloaded ${d.itemId} (${outcome.bytes} bytes)")
        }
        return outcome
    }

    private class Extras(val item: Item, val poster: String?, val thumb: String?, val subtitles: List<LocalSubtitle>)

    /** The pictures and sidecar subtitles, so the download looks and plays right without Reelhouse. */
    private suspend fun saveExtras(d: Download, base: String): Extras {
        val folder = store.folderFor(d.itemId)
        val details = runCatching { c.api.item(d.itemId) }.getOrNull()
        val item = details?.item ?: d.item
        suspend fun image(path: String?, name: String, width: Int): String? {
            path ?: return null
            val f = File(folder, name)
            val r = c.fileDownloader.download(joinUrl(base, sizedImagePath(path, width)), f)
            return f.path.takeIf { r is FileDownloader.Outcome.Done }
        }
        val poster = image(item.images.poster ?: details?.show?.images?.poster, "poster.jpg", 320)
        val thumb = image(item.images.thumb, "thumb.jpg", 640)
        val subtitles = item.media?.external.orEmpty().mapIndexedNotNull { i, s ->
            val f = File(folder, "sub-x$i.vtt")
            val r = c.fileDownloader.download(joinUrl(base, "/api/subtitles/${d.itemId}/x$i.vtt"), f)
            if (r is FileDownloader.Outcome.Done) {
                LocalSubtitle(f.path, s.language, subtitleLabel(SubtitleTrack(id = "x$i", language = s.language, title = s.title, forced = s.forced, external = true)))
            } else null
        }
        return Extras(item, poster, thumb, subtitles)
    }

    private fun fail(d: Download, message: String) {
        store.update(d.itemId) { it.copy(state = DownloadState.Failed, error = message) }
    }

    /** Downloads were turned off on the server: nothing queued can go on. */
    private fun stopQueue(message: String) {
        store.downloads.value.filter { it.active }.forEach { d -> fail(d, message) }
    }

    private fun notifyProgress(d: Download, done: Long, total: Long) {
        val now = System.currentTimeMillis()
        if (now - lastNotice < 1000) return
        lastNotice = now
        val title = d.item.episodeLabel?.let { "${d.showTitle ?: d.item.title} · $it" } ?: d.item.title
        runCatching { setForegroundAsync(foregroundInfo(title, if (total > 0) (done * 100 / total).toInt() else null)) }
    }

    private fun foregroundInfo(text: String, percent: Int?): ForegroundInfo {
        val nm = applicationContext.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW))
        }
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Downloading for offline viewing")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(100, percent ?: 0, percent == null)
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        private const val TAG = "Reelhouse"
        const val CHANNEL = "downloads"
        const val NOTIFICATION_ID = 7001
        const val ROUTE_WAIT_MS = 30_000L
        const val TURNED_OFF = "Downloads are turned off in Reelhouse."
    }
}
