package app.reelhouse.android.ui.remote

import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Forward30
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay10
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Subtitles
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.reelhouse.android.container
import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.data.remote.RemoteControls
import app.reelhouse.android.ui.common.formatPosition
import app.reelhouse.android.ui.components.RemoteImage
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.livetv.ChannelLogo
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.delay

private const val BACK_SECONDS = 10.0
private const val FORWARD_SECONDS = 30.0

/**
 * The phone as a remote for the device it plays on: what's playing there, where, and the buttons. A film or episode
 * has a seek bar and skips; a channel, channel up and down. Its sound, subtitles and volume when the device says what
 * it offers (since 0.26.0); while this screen is open the phone's volume buttons change the device's volume.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RemoteControlScreen(onBack: () -> Unit) {
    val c = LocalContext.current.container
    val active by c.remote.active.collectAsState()
    val playback by c.remote.playback.collectAsState()
    val controls by c.remote.controls.collectAsState()
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
    var tracksOpen by remember { mutableStateOf(false) }
    val statusRow = statusRowBar()
    // The cover (a film's poster, an episode's season cover) behind it all.
    val cover = state?.let { details?.item?.images?.poster ?: details?.show?.images?.poster }
    // The phone's volume buttons go to the device while this screen is open (when its volume can be set from here).
    val keys = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { keys.requestFocus() } }

    Box(
        Modifier.fillMaxSize().background(Palette.Background).focusRequester(keys).focusable().onPreviewKeyEvent { e ->
            val up = e.key == Key.VolumeUp
            if (!up && e.key != Key.VolumeDown || controls?.volume == null) return@onPreviewKeyEvent false
            if (e.type == KeyEventType.KeyDown) c.remote.nudgeVolume(up)
            true
        },
    ) {
        cover?.let { CoverBehind(it) }
        Scaffold(
            containerColor = Color.Transparent,
            topBar = {
                TopAppBar(
                    // The device's name (it can be long: "Firefox on Windows"), after its icon; whose, if someone else's.
                    title = {
                        active?.let { t ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(targetIcon(t.kind), contentDescription = null, tint = Palette.Accent, modifier = Modifier.size(22.dp))
                                Text(
                                    t.label,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.padding(start = 10.dp).semantics { contentDescription = "Playing on ${t.label}" },
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
                        "Pick a film, an episode or a channel and press Play: it plays there.",
                        color = Palette.TextDim,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                    controls?.let { VolumeRow(it, onLevel = c.remote::volume, onMute = c.remote::mute) }
                    return@Column
                }
                if (state.live) {
                    // A channel: its logo (or its first letters), its name, and what's on.
                    val uuid = state.channel
                    if (uuid != null) {
                        ChannelLogo(Channel(uuid = uuid, name = state.title ?: "", radio = state.radio, icon = "/api/livetv/channels/$uuid/icon"), 140.dp)
                    }
                } else {
                    val item = details?.item
                    val picture = item?.images?.let { it.thumb ?: it.backdrop ?: it.poster }
                    Box(Modifier.widthIn(max = 520.dp).fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp))) {
                        RemoteImage(picture, 520.dp, contentDescription = null, modifier = Modifier.fillMaxSize())
                    }
                }
                Spacer(Modifier.height(20.dp))
                // No title: someone else's device playing what this account can't see (the server leaves out what).
                Text(state.title ?: if (state.paused) "Paused" else "Playing", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                state.secondLine?.let { Text(it, color = Palette.TextDim, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp)) }
                Spacer(Modifier.height(20.dp))

                val duration = state.duration?.takeIf { it > 0 }
                val position = playback?.positionAt(now) ?: 0.0
                if (state.live) {
                    Text(if (state.radio) "Live radio" else "Live", color = Palette.Accent, fontWeight = FontWeight.SemiBold)
                } else if (duration != null) {
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
                val canPause = controls?.canPause != false
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (state.live) {
                        IconButton(onClick = c.remote::previous) { Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "Channel down") }
                    } else {
                        if (state.show != null) IconButton(onClick = c.remote::previous) { Icon(Icons.Filled.SkipPrevious, contentDescription = "Previous episode") }
                        IconButton(onClick = { c.remote.skip(-BACK_SECONDS) }) { Icon(Icons.Filled.Replay10, contentDescription = "Back 10 seconds") }
                    }
                    if (canPause || state.paused) {
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
                    } else {
                        Spacer(Modifier.width(24.dp))
                    }
                    if (state.live) {
                        IconButton(onClick = c.remote::next) { Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "Channel up") }
                    } else {
                        IconButton(onClick = { c.remote.skip(FORWARD_SECONDS) }) { Icon(Icons.Filled.Forward30, contentDescription = "Forward 30 seconds") }
                        if (state.show != null) IconButton(onClick = c.remote::next) { Icon(Icons.Filled.SkipNext, contentDescription = "Next episode") }
                    }
                }
                controls?.let { VolumeRow(it, onLevel = c.remote::volume, onMute = c.remote::mute) }
                Spacer(Modifier.height(24.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (controls?.hasTracks == true) {
                        OutlinedButton(onClick = { tracksOpen = true }) {
                            Icon(Icons.Filled.Subtitles, contentDescription = null, modifier = Modifier.size(18.dp))
                            Text("Audio & subtitles", modifier = Modifier.padding(start = 6.dp))
                        }
                    }
                    OutlinedButton(onClick = c.remote::stop) {
                        Icon(Icons.Filled.Stop, contentDescription = null, modifier = Modifier.size(18.dp))
                        Text("Stop", modifier = Modifier.padding(start = 6.dp))
                    }
                }
            }
        }
    }
    val offer = controls
    if (tracksOpen && offer != null) {
        TracksSheet(offer, onAudio = c.remote::audio, onSubtitle = c.remote::subtitle, onDismiss = { tracksOpen = false })
    }
}

/**
 * The device's volume, when it can be set from here: mute, and a slider sent as it's let go (the device's report
 * follows; meanwhile it shows what was asked).
 */
@Composable
private fun VolumeRow(controls: RemoteControls, onLevel: (Int) -> Unit, onMute: (Boolean) -> Unit) {
    val level = controls.volume ?: return
    var dragging by remember { mutableStateOf<Float?>(null) }
    val shown = dragging ?: if (controls.muted) 0f else level.toFloat()
    Row(
        Modifier.widthIn(max = 520.dp).fillMaxWidth().padding(top = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = { onMute(!controls.muted) }) {
            Icon(
                if (controls.muted || level == 0) Icons.AutoMirrored.Filled.VolumeOff else Icons.AutoMirrored.Filled.VolumeUp,
                contentDescription = if (controls.muted) "Unmute" else "Mute",
            )
        }
        Slider(
            value = shown,
            onValueChange = { dragging = it },
            onValueChangeFinished = {
                dragging?.let { onLevel(it.toInt()) }
                dragging = null
            },
            valueRange = 0f..100f,
            colors = SliderDefaults.colors(thumbColor = Palette.Accent, activeTrackColor = Palette.Accent),
            modifier = Modifier.weight(1f).semantics { contentDescription = "Volume" },
        )
        Text("${shown.toInt()}", style = MaterialTheme.typography.labelMedium, color = Palette.TextDim, modifier = Modifier.width(36.dp), textAlign = TextAlign.End)
    }
}

/** The device's sound tracks (when there's more than one) and subtitles, as it named them; picking one sends it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TracksSheet(controls: RemoteControls, onAudio: (String) -> Unit, onSubtitle: (String?) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Palette.Elevated) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            if (controls.audio.size > 1) {
                SheetHeading("Audio")
                for (t in controls.audio) {
                    TrackRow(t.label, selected = t.id == controls.audioId) {
                        onAudio(t.id)
                        onDismiss()
                    }
                }
            }
            SheetHeading("Subtitles")
            TrackRow("Off", selected = controls.subtitleId == null) {
                onSubtitle(null)
                onDismiss()
            }
            for (t in controls.subtitles) {
                TrackRow(t.label, selected = t.id == controls.subtitleId) {
                    onSubtitle(t.id)
                    onDismiss()
                }
            }
        }
    }
}

@Composable
private fun SheetHeading(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, color = Palette.TextDim, modifier = Modifier.padding(horizontal = 24.dp, vertical = 10.dp))
}

@Composable
private fun TrackRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 24.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = if (selected) Palette.Accent else Palette.Text, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = Palette.Accent)
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
