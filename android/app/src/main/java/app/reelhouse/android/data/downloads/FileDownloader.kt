package app.reelhouse.android.data.downloads

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.api.await
import app.reelhouse.android.data.model.ErrorBody
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import kotlin.coroutines.coroutineContext

/** Fetches one file, carrying on from what's already in the file when the server allows it. */
class FileDownloader(private val client: OkHttpClient) {
    sealed interface Outcome {
        data class Done(val bytes: Long) : Outcome

        /** [shouldStop] said so (paused or removed); what's been fetched stays in the file. */
        data object Stopped : Outcome

        /** The server said no (e.g. 403: downloads are turned off). */
        data class Refused(val status: Int, val message: String?) : Outcome

        /** The connection failed; try again later. */
        data class Failed(val error: IOException) : Outcome
    }

    /**
     * Downloads [url] into [file]. If [file] already has data, asks for the rest (HTTP range); a server that sends
     * the whole file again is fine too. The file's version (ETag or Last-Modified) is kept next to it as
     * <file>.validator and sent along (If-Range), so a file that changed on the server meanwhile comes whole again
     * instead of being joined to the old one. [onProgress] gets (bytes so far, total or -1) every so often.
     */
    suspend fun download(
        url: String,
        file: File,
        onProgress: (Long, Long) -> Unit = { _, _ -> },
        shouldStop: () -> Boolean = { false },
    ): Outcome = withContext(Dispatchers.IO) {
        val have = if (file.isFile) file.length() else 0L
        val validatorFile = File(file.path + ".validator")
        val validator = if (have > 0) runCatching { validatorFile.readText().trim() }.getOrNull()?.takeIf { it.isNotEmpty() } else null
        val req = Request.Builder().url(url).apply {
            if (have > 0) header("Range", "bytes=$have-")
            validator?.let { header("If-Range", it) }
        }.build()
        try {
            client.newCall(req).await().use { res ->
                when {
                    res.code == 416 && have > 0 -> { // nothing left to fetch
                        validatorFile.delete()
                        return@withContext Outcome.Done(have)
                    }
                    !res.isSuccessful -> {
                        val text = runCatching { res.body.string() }.getOrNull()
                        val message = text?.let { runCatching { AppJson.decodeFromString(ErrorBody.serializer(), it).error }.getOrNull() }
                        return@withContext Outcome.Refused(res.code, message)
                    }
                }
                val resuming = res.code == 206 && have > 0
                if (!resuming) {
                    (res.header("ETag") ?: res.header("Last-Modified"))?.let { runCatching { validatorFile.writeText(it) } }
                        ?: validatorFile.delete()
                }
                val length = res.body.contentLength()
                val total = when {
                    length < 0 -> -1L
                    resuming -> have + length
                    else -> length
                }
                var done = if (resuming) have else 0L
                var lastReport = 0L
                FileOutputStream(file, resuming).use { out ->
                    val input = res.body.byteStream()
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        coroutineContext.ensureActive()
                        if (shouldStop()) return@withContext Outcome.Stopped
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        val now = System.currentTimeMillis()
                        if (now - lastReport > PROGRESS_EVERY_MS) {
                            lastReport = now
                            onProgress(done, total)
                        }
                    }
                }
                if (total >= 0 && done < total) return@withContext Outcome.Failed(IOException("The download ended early ($done of $total bytes)"))
                onProgress(done, total)
                validatorFile.delete()
                Outcome.Done(done)
            }
        } catch (e: IOException) {
            Outcome.Failed(e)
        }
    }

    companion object {
        const val PROGRESS_EVERY_MS = 500L
    }
}
