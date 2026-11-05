package app.reelhouse.android.ui.downloads

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.DownloadDone
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import app.reelhouse.android.container
import app.reelhouse.android.data.downloads.Download
import app.reelhouse.android.data.downloads.DownloadState
import app.reelhouse.android.data.model.Item

/** "Downloading 45%", "Downloaded" and so on. */
fun downloadLabel(d: Download): String = when (d.state) {
    DownloadState.Queued -> if (d.downloadedBytes > 0) "Waiting · ${percent(d)}" else "Waiting to download"
    DownloadState.Downloading -> "Downloading ${percent(d)}"
    DownloadState.Paused -> "Paused · ${percent(d)}"
    DownloadState.Failed -> "Download failed"
    DownloadState.Done -> "Downloaded"
}

private fun percent(d: Download) = "${(d.progress * 100).toInt()}%"

/** Asks for the notification permission (Android 13+), which shows download progress; downloads work either way. */
@Composable
fun rememberNotificationAsk(): () -> Unit {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    return {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}

/**
 * Download, and the state of a download, for a movie or episode. Not shown at all when the server doesn't allow
 * downloads, unless the item is already downloaded.
 */
@Composable
fun DownloadButton(item: Item, showTitle: String?, showId: Long?) {
    if (item.type != "movie" && item.type != "episode") return
    val c = LocalContext.current.container
    val downloads by c.downloads.downloads.collectAsState()
    val allowed by c.downloads.allowed.collectAsState(initial = c.downloads.isAllowed())
    val turnedOff by c.downloads.turnedOff.collectAsState(initial = false)
    val askNotifications = rememberNotificationAsk()
    var menu by remember { mutableStateOf(false) }
    val d = downloads.firstOrNull { it.itemId == item.id }

    if (d == null) {
        if (!allowed) return
        OutlinedButton(onClick = {
            askNotifications()
            c.downloads.enqueue(item, showTitle, showId)
        }) {
            Icon(Icons.Filled.Download, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text("Download")
        }
        return
    }
    Box {
        OutlinedButton(onClick = { menu = true }) {
            Icon(
                when (d.state) {
                    DownloadState.Done -> Icons.Filled.DownloadDone
                    DownloadState.Failed -> Icons.Filled.ErrorOutline
                    DownloadState.Paused -> Icons.Filled.Pause
                    else -> Icons.Filled.Download
                },
                contentDescription = null,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(downloadLabel(d))
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DownloadActions(d, canResume = !turnedOff, onDone = { menu = false })
        }
    }
}

/** The menu lines for a download in its current state; [canResume] is false once the server has turned downloads off. */
@Composable
fun DownloadActions(d: Download, canResume: Boolean, onDone: () -> Unit) {
    val c = LocalContext.current.container
    d.error?.let { DropdownMenuItem(text = { Text(it) }, onClick = {}, enabled = false) }
    when (d.state) {
        DownloadState.Queued, DownloadState.Downloading ->
            DropdownMenuItem(text = { Text("Pause") }, onClick = { c.downloads.pause(d.itemId); onDone() })
        DownloadState.Paused, DownloadState.Failed ->
            if (canResume) DropdownMenuItem(text = { Text(if (d.state == DownloadState.Failed) "Try again" else "Resume") }, onClick = { c.downloads.resume(d.itemId); onDone() })
        DownloadState.Done -> Unit
    }
    DropdownMenuItem(
        text = { Text(if (d.done) "Remove download" else "Cancel download") },
        onClick = { c.downloads.remove(d.itemId); onDone() },
    )
}

/** On a season: download every episode not downloaded yet, or how many are. */
@Composable
fun SeasonDownloadButton(episodes: List<Item>, showTitle: String?, showId: Long?) {
    val c = LocalContext.current.container
    val downloads by c.downloads.downloads.collectAsState()
    val allowed by c.downloads.allowed.collectAsState(initial = c.downloads.isAllowed())
    val askNotifications = rememberNotificationAsk()
    val ids = episodes.map { it.id }.toSet()
    val mine = downloads.filter { it.itemId in ids }
    val missing = episodes.count { e -> mine.none { it.itemId == e.id } }
    if (episodes.isEmpty() || (!allowed && mine.isEmpty())) return
    OutlinedButton(
        onClick = {
            askNotifications()
            c.downloads.enqueueAll(episodes, showTitle, showId)
        },
        enabled = allowed && missing > 0,
    ) {
        Icon(if (missing == 0) Icons.Filled.DownloadDone else Icons.Filled.Download, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
        Text(
            when {
                missing == 0 && mine.all { it.done } -> "Season downloaded"
                missing == 0 -> "Downloading season"
                mine.isEmpty() -> "Download season"
                else -> "Download the other $missing"
            },
        )
    }
}
