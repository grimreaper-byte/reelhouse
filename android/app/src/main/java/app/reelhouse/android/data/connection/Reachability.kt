package app.reelhouse.android.data.connection

import app.reelhouse.android.data.model.ServerInfo
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** Whether [info] (GET /api/server) is from the paired Reelhouse, as far as the paired server's id ([pairedId]) shows. */
fun isPairedServer(pairedId: String?, info: ServerInfo): Boolean =
    info.version.isNotEmpty() && (pairedId == null || info.id == pairedId)

/** The name to store once the paired Reelhouse has answered as [info]: its new name if it was renamed, else null. */
fun renamedTo(stored: String, info: ServerInfo): String? = info.name.trim().takeIf { it.isNotEmpty() && it != stored }

/** Answers whether Reelhouse answers at an address within a time limit. */
fun interface Prober {
    suspend fun reaches(base: String, timeoutMs: Long): Boolean
}

/** Tries all addresses at once and returns the first to answer, or null when none does; the rest are cancelled. */
suspend fun firstReachable(urls: List<String>, timeoutMs: Long, prober: Prober): String? {
    if (urls.isEmpty()) return null
    return coroutineScope {
        val answers = Channel<String?>(urls.size)
        val jobs = urls.map { url ->
            launch { answers.send(url.takeIf { runCatching { prober.reaches(url, timeoutMs) }.getOrDefault(false) }) }
        }
        repeat(urls.size) {
            answers.receive()?.let { url ->
                jobs.forEach { it.cancel() }
                return@coroutineScope url
            }
        }
        null
    }
}
