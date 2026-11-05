package app.reelhouse.android.ui.player

import android.content.pm.ActivityInfo
import android.view.View
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Audiotrack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.HighQuality
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Subtitles
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import app.reelhouse.android.ui.common.formatPosition
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import app.reelhouse.android.container
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.data.playback.AvSync
import app.reelhouse.android.ui.theme.Palette

private enum class Menu(val title: String) { Subtitles("Subtitles"), Audio("Audio"), Quality("Quality") }

@OptIn(UnstableApi::class)
@kotlin.OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlayerScreen(itemId: Long, startAt: Double, onBack: () -> Unit) {
    val context = LocalContext.current
    val c = context.container
    val vm = viewModel(key = "player-$itemId") { PlayerViewModel(c, context.applicationContext, itemId, startAt) }
    val ui by vm.ui.collectAsState()
    var controls by remember { mutableStateOf(true) }
    var menu by remember { mutableStateOf<Menu?>(null) }
    var syncing by remember { mutableStateOf(false) }

    ImmersiveLandscape()
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { vm.onBackground() }
    LaunchedEffect(ui.finished) { if (ui.finished) onBack() }
    BackHandler(onBack = onBack)

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    player = controlsPlayer(vm)
                    setShowSubtitleButton(false) // the top bar has the app's own menus
                    setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
                    keepScreenOn = true
                    controllerShowTimeoutMs = 4000
                    setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { v -> controls = v == View.VISIBLE })
                }
            },
            // ⏮ and ⏭ are there for a film with chapters (they go between them, see controlsPlayer); the next episode
            // comes from Up next instead.
            update = { view ->
                val chapters = usableChapters(ui.info?.chapters).isNotEmpty()
                view.setShowPreviousButton(chapters)
                view.setShowNextButton(chapters)
            },
            onRelease = { it.player = null },
            modifier = Modifier.fillMaxSize(),
        )

        AnimatedVisibility(controls || ui.error != null || ui.loading, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter)) {
            TopBar(ui, vm.qualityLabel(), onBack = onBack, onMenu = { menu = it })
        }
        if (ui.loading && ui.error == null) {
            CircularProgressIndicator(Modifier.align(Alignment.Center), color = Palette.Accent)
        }
        ui.chapterNote?.let { note ->
            Surface(
                color = Color.Black.copy(alpha = 0.7f),
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 72.dp),
            ) { Text(note, color = Color.White, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)) }
        }
        ui.status?.let { status ->
            Surface(
                color = Color.Black.copy(alpha = 0.7f),
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 96.dp),
            ) { Text(status, color = Color.White, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)) }
        }
        ui.error?.let { error ->
            Column(
                Modifier.align(Alignment.Center).widthIn(max = 420.dp).padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(error, color = Color.White, style = MaterialTheme.typography.bodyLarge)
                Spacer(Modifier.height(16.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = vm::retry) { Text("Try again") }
                    OutlinedButton(onClick = onBack) { Text("Back") }
                }
            }
        }
        ui.upNext?.let { next -> UpNext(next, ui.countdown, onPlay = vm::playNext, onCancel = vm::cancelUpNext, modifier = Modifier.align(Alignment.BottomEnd)) }
        if (syncing) {
            SyncPanel(
                ui.syncMs,
                ui.pictureDelayMs,
                onChange = vm::setSync,
                onDone = { syncing = false },
                modifier = Modifier.align(Alignment.BottomCenter).safeDrawingPadding().padding(bottom = 72.dp, start = 16.dp, end = 16.dp),
            )
        }
    }

    ui.askResume?.let { at ->
        AlertDialog(
            onDismissRequest = onBack,
            title = { Text(ui.item?.let { if (it.type == "episode") listOfNotNull(it.episodeLabel, it.title).joinToString(" · ") else it.title } ?: "Resume?") },
            text = { Text("You stopped at ${formatPosition(at)}.") },
            confirmButton = { TextButton(onClick = { vm.resumeFrom(fromStart = false) }) { Text("Resume from ${formatPosition(at)}") } },
            dismissButton = { TextButton(onClick = { vm.resumeFrom(fromStart = true) }) { Text("Start from the beginning") } },
        )
    }

    menu?.let { m ->
        val choices = remember(m, ui.tracks, ui.info, ui.syncMs, ui.pictureDelayMs) {
            when (m) {
                Menu.Subtitles -> vm.subtitleChoices()
                Menu.Audio -> vm.audioChoices() + Choice(
                    "Picture and sound",
                    selected = false,
                    note = "Automatic" + (if (ui.pictureDelayMs > 0) " (picture ${ui.pictureDelayMs} ms late, made up for)" else "") +
                        (if (ui.syncMs != 0) " · fine-tune ${AvSync.label(ui.syncMs)}" else ""),
                ) { syncing = true }
                Menu.Quality -> vm.qualityChoices()
            }
        }
        // Fully open: half a landscape screen hides most of the list.
        ModalBottomSheet(onDismissRequest = { menu = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Palette.Elevated) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
                Text(m.title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
                if (choices.isEmpty()) {
                    Text("Nothing to choose from.", color = Palette.TextDim, modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp))
                }
                choices.forEach { choice ->
                    Row(
                        Modifier.fillMaxWidth().clickable {
                            menu = null
                            choice.onPick()
                        }.padding(horizontal = 24.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.width(32.dp)) {
                            if (choice.selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = Palette.Accent, modifier = Modifier.size(20.dp))
                        }
                        Column(Modifier.weight(1f)) {
                            Text(choice.label)
                            choice.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TopBar(ui: PlayerViewModel.Ui, qualityLabel: String?, onBack: () -> Unit, onMenu: (Menu) -> Unit) {
    val item = ui.item
    Row(
        Modifier.fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.75f), Color.Transparent)))
            .safeDrawingPadding()
            .padding(horizontal = 4.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
        Column(Modifier.weight(1f)) {
            val title = when {
                item == null -> ""
                item.type == "episode" -> listOfNotNull(ui.showTitle, item.episodeLabel).joinToString(" · ")
                else -> item.title
            }
            Text(title, color = Color.White, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val line = listOfNotNull(
                item?.title?.takeIf { item.type == "episode" },
                ui.info?.let { playbackSummary(it, qualityLabel) },
            ).joinToString(" · ")
            if (line.isNotEmpty()) Text(line, color = Color.White.copy(alpha = 0.75f), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (ui.info != null) {
            IconButton(onClick = { onMenu(Menu.Subtitles) }) { Icon(Icons.Filled.Subtitles, contentDescription = "Subtitles", tint = Color.White) }
            IconButton(onClick = { onMenu(Menu.Audio) }) { Icon(Icons.Filled.Audiotrack, contentDescription = "Audio", tint = Color.White) }
            IconButton(onClick = { onMenu(Menu.Quality) }) { Icon(Icons.Filled.HighQuality, contentDescription = "Quality", tint = Color.White) }
        }
    }
}

@Composable
private fun UpNext(next: Item, seconds: Int, onPlay: () -> Unit, onCancel: () -> Unit, modifier: Modifier) {
    Surface(color = Palette.Elevated.copy(alpha = 0.95f), shape = RoundedCornerShape(10.dp), modifier = modifier.safeDrawingPadding().padding(24.dp).widthIn(max = 360.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text("Up next", style = MaterialTheme.typography.labelMedium, color = Palette.Accent)
            Text(listOfNotNull(next.episodeLabel, next.title).joinToString(" · "), style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = onPlay) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Play now ($seconds)")
                }
                TextButton(onClick = onCancel) { Text("Cancel") }
            }
        }
    }
}

/** Landscape and full screen while the player is open; back to normal after. */
@Composable
internal fun ImmersiveLandscape() {
    val activity = LocalActivity.current ?: return
    DisposableEffect(activity) {
        val previous = activity.requestedOrientation
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        val insets = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        insets.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        insets.hide(WindowInsetsCompat.Type.systemBars())
        onDispose {
            insets.show(WindowInsetsCompat.Type.systemBars())
            activity.requestedOrientation = previous
        }
    }
}

/**
 * The player as the on-screen controls see it (Media3 shows a setting, or enables a button, only when the player
 * offers its command): one whose speed can't be changed, so the ⚙ menu leaves out "Playback speed" (films always
 * play at normal speed); and for a film with chapters, ⏮ and ⏭ go between them ([PlayerViewModel.skipChapter]).
 */
@OptIn(UnstableApi::class)
private fun controlsPlayer(vm: PlayerViewModel): Player = object : ForwardingPlayer(vm.player) {
    private val chapters get() = vm.chapters.isNotEmpty()

    override fun getAvailableCommands(): Player.Commands = super.getAvailableCommands().buildUpon()
        .remove(Player.COMMAND_SET_SPEED_AND_PITCH)
        .apply { if (chapters) addAll(Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_NEXT) }
        .build()

    override fun isCommandAvailable(command: Int): Boolean = when (command) {
        Player.COMMAND_SET_SPEED_AND_PITCH -> false
        Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_NEXT -> chapters || super.isCommandAvailable(command)
        else -> super.isCommandAvailable(command)
    }

    override fun seekToNext() = if (chapters) vm.skipChapter(forward = true) else super.seekToNext()

    override fun seekToPrevious() = if (chapters) vm.skipChapter(forward = false) else super.seekToPrevious()
}
