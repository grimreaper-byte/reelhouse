package app.reelhouse.android.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import app.reelhouse.android.container
import app.reelhouse.android.data.playback.AvSync
import app.reelhouse.android.data.playback.Quality
import app.reelhouse.android.data.update.AppUpdater
import app.reelhouse.android.ui.common.formatSize
import app.reelhouse.android.ui.player.PlayerViewModel
import app.reelhouse.android.ui.player.SYNC_HINT
import app.reelhouse.android.ui.player.SyncAdjuster
import app.reelhouse.android.ui.player.pictureTimingText
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.launch

/** The quality to start at, at home and away (choosing one in the player changes these too). */
@Composable
internal fun PlaybackSection() {
    val c = LocalContext.current.container
    val defaults by c.connection.serverDefaults.collectAsState()
    var qualities by remember { mutableStateOf(PlayerViewModel.DEFAULT_QUALITIES) }
    LaunchedEffect(Unit) { runCatching { c.api.qualities() }.getOrNull()?.takeIf { it.isNotEmpty() }?.let { qualities = it } }
    var home by remember { mutableStateOf(c.prefs.quality(atHome = true)) }
    var away by remember { mutableStateOf(c.prefs.quality(atHome = false)) }
    var picking by remember { mutableStateOf<Boolean?>(null) } // true: at home, false: away
    val label = { id: String? -> qualities.firstOrNull { it.id == id }?.label ?: id }
    val automatic = { atHome: Boolean ->
        if (atHome) "Automatic (original)"
        else "Automatic (" + (label(defaults?.remoteQuality) ?: "Reelhouse's choice") + ")"
    }

    Section("Playback")
    ChoiceRow("Quality at home", home?.let(label) ?: automatic(true)) { picking = true }
    ChoiceRow("Quality away from home", away?.let(label) ?: automatic(false)) { picking = false }
    Text(
        "Choosing a quality in the player changes these too. Downloads are always the original.",
        style = MaterialTheme.typography.bodySmall,
        color = Palette.TextDim,
    )
    var sync by remember { mutableStateOf(AvSync.clamp(c.prefs.avSyncMs)) }
    var syncing by remember { mutableStateOf(false) }
    val pictureDelayMs = (c.prefs.pictureDelayUs / 1000).toInt()
    ChoiceRow(
        "Picture and sound",
        "Automatic" + (if (pictureDelayMs > 0) " (picture $pictureDelayMs ms late, made up for)" else "") +
            (if (sync != 0) " · fine-tune ${AvSync.label(sync)}" else ""),
    ) { syncing = true }
    if (syncing) {
        val set = { ms: Int ->
            sync = AvSync.clamp(ms)
            c.prefs.avSyncMs = sync
        }
        AlertDialog(
            onDismissRequest = { syncing = false },
            title = { Text("Picture and sound") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(pictureTimingText(pictureDelayMs), style = MaterialTheme.typography.bodyMedium)
                    Text("Fine-tune", style = MaterialTheme.typography.labelMedium, color = Palette.TextDim)
                    SyncAdjuster(sync, set)
                    Text(SYNC_HINT + " The player's Audio menu has this too, so you can watch while you change it.", style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
                }
            },
            confirmButton = { TextButton(onClick = { syncing = false }) { Text("Done") } },
            dismissButton = { TextButton(onClick = { set(0) }, enabled = sync != 0) { Text("Reset") } },
        )
    }

    picking?.let { atHome ->
        QualityDialog(
            title = if (atHome) "Quality at home" else "Quality away from home",
            automatic = automatic(atHome),
            qualities = qualities,
            selected = if (atHome) home else away,
            onPick = { id ->
                c.prefs.setQuality(atHome, id)
                if (atHome) home = id else away = id
                picking = null
            },
            onDismiss = { picking = null },
        )
    }
}

@Composable
private fun ChoiceRow(label: String, value: String, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClickLabel = "Change", onClick = onClick).padding(vertical = 8.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun QualityDialog(
    title: String,
    automatic: String,
    qualities: List<Quality>,
    selected: String?,
    onPick: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                RadioRow(automatic, selected == null) { onPick(null) }
                qualities.forEach { q -> RadioRow(q.label, selected == q.id) { onPick(q.id) } }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun RadioRow(text: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectable(selected = selected, onClick = onClick, role = Role.RadioButton).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Text(text, modifier = Modifier.padding(start = 12.dp))
    }
}

/** A newer version of the app on Reelhouse: download it and hand it to Android's installer. */
@Composable
internal fun UpdateRow() {
    val c = LocalContext.current.container
    val release by c.updater.available.collectAsState(initial = null)
    val state by c.updater.state.collectAsState()
    // Checked again on coming back from Android's "Install unknown apps" switch.
    var canInstall by remember { mutableStateOf(c.updater.canInstall()) }
    LifecycleResumeEffect(Unit) {
        canInstall = c.updater.canInstall()
        onPauseOrDispose {}
    }
    val r = release ?: return
    // Started from the app's scope, so leaving Settings doesn't stop the download.
    val download = { c.scope.launch { c.updater.downloadAndInstall(r) } }
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text("Update available", style = MaterialTheme.typography.bodySmall, color = Palette.Accent)
        Text("Reelhouse ${r.versionName} is on your Reelhouse" + if (r.size > 0) " (${formatSize(r.size)})." else ".")
        Spacer(Modifier.height(8.dp))
        when (val s = state) {
            is AppUpdater.State.Downloading -> {
                LinearProgressIndicator(progress = { s.progress }, modifier = Modifier.fillMaxWidth())
                Text("Downloading…", style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
            }
            is AppUpdater.State.Ready -> {
                Button(onClick = { c.updater.install(s.file) }) { Text("Install") }
                if (!canInstall) {
                    Text(
                        "Android asks first: allow Reelhouse to install apps, then come back and tap Install.",
                        style = MaterialTheme.typography.bodySmall,
                        color = Palette.TextDim,
                    )
                }
            }
            is AppUpdater.State.Failed -> {
                Text(s.message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                OutlinedButton(onClick = { download() }) { Text("Try again") }
            }
            AppUpdater.State.Idle -> Button(onClick = { download() }) { Text("Download and install") }
        }
    }
}
