package app.reelhouse.android.ui.downloads

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.painter.ColorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.reelhouse.android.container
import app.reelhouse.android.data.downloads.Download
import app.reelhouse.android.data.downloads.DownloadState
import app.reelhouse.android.ui.common.CenteredMessage
import app.reelhouse.android.ui.common.formatPosition
import app.reelhouse.android.ui.common.formatSize
import app.reelhouse.android.ui.common.remoteFocus
import app.reelhouse.android.ui.components.RemoteImage
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.theme.Palette
import coil3.compose.AsyncImage
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Downloads under one heading: a show's episodes, or the movies. */
data class DownloadGroup(val title: String, val downloads: List<Download>)

/** Movies first, then each show's episodes in order. */
fun groupDownloads(list: List<Download>): List<DownloadGroup> {
    val movies = list.filter { it.item.type != "episode" }.sortedBy { it.item.title.lowercase() }
    val shows = list.filter { it.item.type == "episode" }
        .groupBy { it.showTitle ?: "Episodes" }
        .toSortedMap(String.CASE_INSENSITIVE_ORDER)
        .map { (title, eps) -> DownloadGroup(title, eps.sortedWith(compareBy({ it.item.seasonNumber ?: 0 }, { it.item.episodeNumber ?: 0 }))) }
    return listOfNotNull(DownloadGroup("Movies", movies).takeIf { movies.isNotEmpty() }) + shows
}

/** The line under a download's title. */
fun downloadStatus(d: Download): String = when (d.state) {
    DownloadState.Done -> listOfNotNull(
        "Downloaded",
        d.totalBytes.takeIf { it > 0 }?.let(::formatSize),
        d.position.takeIf { it > 0 }?.let { "watched to ${formatPosition(it)}" },
    ).joinToString(" · ")
    DownloadState.Downloading -> downloadLabel(d) + if (d.totalBytes > 0) " · ${formatSize(d.downloadedBytes)} of ${formatSize(d.totalBytes)}" else ""
    DownloadState.Failed -> d.error ?: downloadLabel(d)
    else -> downloadLabel(d) + (d.error?.let { " · $it" } ?: "")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DownloadsScreen(onPlay: (Long) -> Unit, onBack: () -> Unit) {
    val c = LocalContext.current.container
    val downloads by c.downloads.downloads.collectAsState()
    val turnedOff by c.downloads.turnedOff.collectAsState(initial = false)
    var used by remember { mutableLongStateOf(0L) }
    LaunchedEffect(downloads.map { it.state }) { used = withContext(Dispatchers.IO) { c.downloads.store.bytesUsed() } }

    val statusRow = statusRowBar()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Downloads") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                expandedHeight = statusRow.height,
                windowInsets = statusRow.insets,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.Background),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (turnedOff) {
                Text(
                    "Downloads are turned off in Reelhouse. What's already downloaded still plays, but nothing new can download.",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
                        .clip(RoundedCornerShape(6.dp)).background(Palette.Elevated2).padding(12.dp),
                )
            }
            if (downloads.isEmpty()) {
                CenteredMessage(
                    if (turnedOff) "Nothing downloaded." else "Nothing downloaded yet. Use Download on a movie, an episode or a season to watch it without a connection.",
                )
                return@Column
            }
            val groups = groupDownloads(downloads)
            val startsAt = groups.firstOrNull()?.downloads?.firstOrNull()?.itemId
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                groups.forEach { group ->
                    item(key = "group-${group.title}") {
                        Text(group.title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 6.dp))
                    }
                    items(group.downloads, key = { it.itemId }) { d -> DownloadRow(d, canResume = !turnedOff, first = d.itemId == startsAt, onPlay = { onPlay(d.itemId) }) }
                }
                item(key = "footer") {
                    Text(
                        buildString {
                            append("${formatSize(used)} on this device")
                            if (downloads.any { it.active } && c.prefs.wifiOnlyDownloads) append(" · downloading on Wi-Fi only (see Settings)")
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = Palette.TextDim,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 16.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun DownloadRow(d: Download, canResume: Boolean, first: Boolean, onPlay: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.remoteFocus("download-${d.itemId}", first).fillMaxWidth().clickable { if (d.done) onPlay() else menu = true }.padding(start = 16.dp, top = 6.dp, bottom = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(112.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(6.dp))) {
            val local = d.thumb ?: d.poster
            if (local != null) {
                AsyncImage(
                    model = File(local),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    placeholder = ColorPainter(Palette.Elevated2),
                    error = ColorPainter(Palette.Elevated2),
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                // The pictures are saved once the video is: until then, Reelhouse's (when it can be reached).
                RemoteImage(d.item.images.thumb ?: d.item.images.poster, 112.dp, null, Modifier.fillMaxSize())
            }
        }
        Column(Modifier.weight(1f)) {
            Text(
                listOfNotNull(d.item.episodeLabel, d.item.title).joinToString(" · "),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(downloadStatus(d), style = MaterialTheme.typography.bodySmall, color = if (d.state == DownloadState.Failed) MaterialTheme.colorScheme.error else Palette.TextDim, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (!d.done) {
                Spacer(Modifier.height(6.dp))
                LinearProgressIndicator(progress = { d.progress }, modifier = Modifier.fillMaxWidth())
            }
        }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "Download options") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DownloadActions(d, canResume, onDone = { menu = false })
            }
        }
    }
}
