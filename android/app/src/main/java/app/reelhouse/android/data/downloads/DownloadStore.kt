package app.reelhouse.android.data.downloads

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.model.Item
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.io.File

@Serializable
enum class DownloadState { Queued, Downloading, Paused, Done, Failed }

/** A subtitle file saved next to a download (sidecar subtitles, as WebVTT). */
@Serializable
data class LocalSubtitle(val file: String, val language: String? = null, val label: String)

/** One movie or episode saved for offline viewing, with what's needed to show and play it without Reelhouse. */
@Serializable
data class Download(
    val itemId: Long,
    val serverId: String? = null,
    /** The item as it was when downloaded: title, numbers, overview, duration. */
    val item: Item,
    val showTitle: String? = null,
    val showId: Long? = null,
    val file: String,
    val totalBytes: Long = 0,
    val downloadedBytes: Long = 0,
    val state: DownloadState = DownloadState.Queued,
    val error: String? = null,
    val poster: String? = null,
    val thumb: String? = null,
    val subtitles: List<LocalSubtitle> = emptyList(),
    /** Where it was left when played from the download (seconds). */
    val position: Double = 0.0,
    val addedAt: Long = System.currentTimeMillis(),
    val completedAt: Long? = null,
) {
    val done get() = state == DownloadState.Done
    val active get() = state == DownloadState.Queued || state == DownloadState.Downloading
    val progress: Float get() = if (totalBytes > 0) (downloadedBytes.toFloat() / totalBytes).coerceIn(0f, 1f) else 0f
}

/** A watch report made while Reelhouse couldn't be reached, sent when it can. */
@Serializable
data class PendingReport(val itemId: Long, val position: Double, val duration: Double? = null, val state: String, val at: Long)

/**
 * The downloads list and the offline watch reports, each kept in a JSON file in [dir]; the videos live in
 * [dir]/item-<id>/.
 */
class DownloadStore(val dir: File) {
    private val listFile = File(dir, "downloads.json")
    private val reportsFile = File(dir, "pending-reports.json")
    private val _downloads = MutableStateFlow(load(listFile, ListSerializer(Download.serializer())))
    val downloads: StateFlow<List<Download>> = _downloads.asStateFlow()
    private var reports = load(reportsFile, ListSerializer(PendingReport.serializer()))

    init {
        dir.mkdirs()
        // Anything downloading when the app last stopped is queued again.
        if (_downloads.value.any { it.state == DownloadState.Downloading }) {
            write(_downloads.value.map { if (it.state == DownloadState.Downloading) it.copy(state = DownloadState.Queued) else it })
        }
    }

    fun get(itemId: Long): Download? = _downloads.value.firstOrNull { it.itemId == itemId }

    /** A finished download of the item, if its file is still there. */
    fun completed(itemId: Long): Download? = get(itemId)?.takeIf { it.done && File(it.file).isFile }

    fun folderFor(itemId: Long) = File(dir, "item-$itemId").also { it.mkdirs() }

    @Synchronized
    fun add(d: Download) {
        if (get(d.itemId) != null) return
        write(_downloads.value + d)
    }

    @Synchronized
    fun update(itemId: Long, change: (Download) -> Download) {
        write(_downloads.value.map { if (it.itemId == itemId) change(it) else it })
    }

    /** Removes a download and its files. */
    @Synchronized
    fun remove(itemId: Long) {
        File(dir, "item-$itemId").deleteRecursively()
        write(_downloads.value.filterNot { it.itemId == itemId })
    }

    @Synchronized
    fun removeAll() {
        dir.listFiles()?.filter { it.isDirectory && it.name.startsWith("item-") }?.forEach { it.deleteRecursively() }
        write(emptyList())
        reports = emptyList()
        save(reportsFile, ListSerializer(PendingReport.serializer()), reports)
    }

    /** The next download to work on: the oldest queued one. */
    fun nextQueued(): Download? = _downloads.value.filter { it.state == DownloadState.Queued }.minByOrNull { it.addedAt }

    /** Bytes the downloads take on the phone. */
    fun bytesUsed(): Long = dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }

    // ---------- offline watch reports ----------

    @Synchronized
    fun addReport(r: PendingReport) {
        // Only the latest report per item matters.
        reports = reports.filterNot { it.itemId == r.itemId } + r
        save(reportsFile, ListSerializer(PendingReport.serializer()), reports)
    }

    @Synchronized
    fun pendingReports(): List<PendingReport> = reports

    @Synchronized
    fun reportSent(r: PendingReport) {
        reports = reports.filterNot { it == r }
        save(reportsFile, ListSerializer(PendingReport.serializer()), reports)
    }

    // ---------- files ----------

    private fun write(list: List<Download>) {
        save(listFile, ListSerializer(Download.serializer()), list)
        _downloads.value = list
    }

    private fun <T> load(file: File, serializer: kotlinx.serialization.KSerializer<List<T>>): List<T> =
        runCatching { AppJson.decodeFromString(serializer, file.readText()) }.getOrDefault(emptyList())

    private fun <T> save(file: File, serializer: kotlinx.serialization.KSerializer<List<T>>, value: List<T>) {
        dir.mkdirs()
        val tmp = File(dir, file.name + ".new")
        tmp.writeText(AppJson.encodeToString(serializer, value))
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
    }
}
