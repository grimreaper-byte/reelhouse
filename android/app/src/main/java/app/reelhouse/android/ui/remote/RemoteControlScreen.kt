package app.reelhouse.android.ui.remote

import android.os.SystemClock
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Forward30
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay10
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.background
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.reelhouse.android.container
import app.reelhouse.android.ui.common.formatPosition
import app.reelhouse.android.ui.components.RemoteImage
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.delay

private const val BACK_SECONDS = 10.0
private const val FORWARD_SECONDS = 30.0

/** The phone as a remote for the device it plays on: what's playing there, where, and the buttons. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RemoteControlScreen(onBack: () -> Unit) {
    val c = LocalContext.current.container
    val active by c.remote.active.collectAsState()
    val playback by c.remote.playback.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { c.remote.messages.collect { snackbar.showSnackbar(it) } }
    // Disconnected (here, or the device went away): back to where the phone was.
    LaunchedEffect(active == null) { if (active == null) onBack() }
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = SystemClock.elapsedRealtime()
            delay(500)
        }
    }
    val state = playback?.state
    // The artwork: the film's or episode's own picture.
    val itemId = state?.itemId
    val details by produceState<app.reelhouse.android.data.model.ItemDetails?>(null, itemId) {
        value = itemId?.let { runCatching { c.api.item(it) }.getOrNull() }
    }
    var dragging by remember { mutableStateOf<Float?>(null) }
    val statusRow = statusRowBar()
    // The cover (a film's poster, an episode's season cover) behind it all.
    val cover = state?.let { details?.item?.images?.poster ?: details?.show?.images?.poster }

    Box(Modifier.fillMaxSize().background(Palette.Background)) {
        cover?.let { CoverBehind(it) }
        Scaffold(
            containerColor = Color.Transparent,
            topBar = {
                TopAppBar(
                    // The device's name (it can be long: "Firefox on Windows"), after its icon.
                    title = {
                        active?.let { t ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(targetIcon(t.kind), contentDescription = null, tint = Palette.Accent, modifier = Modifier.size(22.dp))
                                Text(
                                    t.name,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.padding(start = 10.dp).semantics { contentDescription = "Playing on ${t.name}" },
                                )
                            }
                        }
                    },
                    navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                    actions = { TextButton(onClick = { c.remote.disconnect() }) { Text("Disconnect") } },
                    expandedHeight = statusRow.height,
                    windowInsets = statusRow.insets,
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                )
            },
            snackbarHost = { SnackbarHost(snackbar) },
        ) { padding ->
            Column(
                Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                val target = active ?: return@Column
                if (state == null) {
                    Spacer(Modifier.height(48.dp))
                    Icon(targetIcon(target.kind), contentDescription = null, tint = Palette.TextDim, modifier = Modifier.size(56.dp))
                    Spacer(Modifier.height(16.dp))
                    Text("Nothing is playing on ${target.name}", style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
                    Text(
                        "Pick a film or an episode and press Play: it plays there.",
                        color = Palette.TextDim,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                    return@Column
                }
                val item = details?.item
                val picture = item?.images?.let { it.thumb ?: it.backdrop ?: it.poster }
                Box(Modifier.widthIn(max = 520.dp).fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp))) {
                    RemoteImage(picture, 520.dp, contentDescription = null, modifier = Modifier.fillMaxSize())
                }
                Spacer(Modifier.height(20.dp))
                Text(state.title ?: "", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                state.showLine?.let { Text(it, color = Palette.TextDim, modifier = Modifier.padding(top = 4.dp)) }
                Spacer(Modifier.height(20.dp))

                val duration = state.duration?.takeIf { it > 0 }
                val position = playback?.positionAt(now) ?: 0.0
                if (duration != null && !state.live) {
                    Slider(
                        value = dragging ?: position.toFloat().coerceIn(0f, duration.toFloat()),
                        onValueChange = { dragging = it },
                        onValueChangeFinished = {
                            dragging?.let { c.remote.seek(it.toDouble()) }
                            dragging = null
                        },
                        valueRange = 0f..duration.toFloat(),
                        colors = SliderDefaults.colors(thumbColor = Palette.Accent, activeTrackColor = Palette.Accent),
                        modifier = Modifier.widthIn(max = 520.dp).fillMaxWidth(),
                    )
                    Row(Modifier.widthIn(max = 520.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(formatPosition(dragging?.toDouble() ?: position), style = MaterialTheme.typography.labelMedium, color = Palette.TextDim)
                        Text("−" + formatPosition((duration - (dragging?.toDouble() ?: position)).coerceAtLeast(0.0)), style = MaterialTheme.typography.labelMedium, color = Palette.TextDim)
                    }
                }
                Spacer(Modifier.height(16.dp))
                val episode = state.show != null
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (episode) IconButton(onClick = c.remote::previous) { Icon(Icons.Filled.SkipPrevious, contentDescription = "Previous episode") }
                    IconButton(onClick = { c.remote.skip(-BACK_SECONDS) }) { Icon(Icons.Filled.Replay10, contentDescription = "Back 10 seconds") }
                    FilledIconButton(
                        onClick = { if (state.paused) c.remote.resume() else c.remote.pause() },
                        modifier = Modifier.size(72.dp),
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = Palette.Accent, contentColor = Palette.AccentText),
                    ) {
                        Icon(
                            if (state.paused) Icons.Filled.PlayArrow else Icons.Filled.Pause,
                            contentDescription = if (state.paused) "Play" else "Pause",
                            modifier = Modifier.size(40.dp),
                        )
                    }
                    IconButton(onClick = { c.remote.skip(FORWARD_SECONDS) }) { Icon(Icons.Filled.Forward30, contentDescription = "Forward 30 seconds") }
                    if (episode) IconButton(onClick = c.remote::next) { Icon(Icons.Filled.SkipNext, contentDescription = "Next episode") }
                }
                Spacer(Modifier.height(24.dp))
                OutlinedButton(onClick = c.remote::stop) {
                    Icon(Icons.Filled.Stop, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("Stop", modifier = Modifier.padding(start = 6.dp))
                }
            }
        }
    }
}

/**
 * The cover filling the screen behind the remote: softened a little (Android 12 and newer) and darkened, more towards
 * the bottom, so the buttons stay readable over it while the cover can still be told.
 */
@Composable
private fun CoverBehind(path: String) {
    val bg = Palette.Background
    val window = LocalWindowInfo.current.containerSize
    // Wide enough to cover the window's height at a poster's 2:3.
    val width = with(LocalDensity.current) { maxOf(window.width, window.height * 2 / 3).toDp() }
    Box(Modifier.fillMaxSize()) {
        RemoteImage(path, width, contentDescription = null, modifier = Modifier.fillMaxSize().blur(6.dp), placeholder = bg)
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    0f to bg.copy(alpha = 0.6f),
                    0.35f to bg.copy(alpha = 0.62f),
                    0.7f to bg.copy(alpha = 0.78f),
                    1f to bg.copy(alpha = 0.9f),
                ),
            ),
        )
    }
}
