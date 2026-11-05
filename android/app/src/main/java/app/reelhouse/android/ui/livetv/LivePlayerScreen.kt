package app.reelhouse.android.ui.livetv

import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import app.reelhouse.android.container
import app.reelhouse.android.data.model.Programme
import app.reelhouse.android.ui.player.ImmersiveLandscape
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.delay

private const val HIDE_CONTROLS_MS = 3000L

/**
 * Watching a channel, or listening to a radio station: TV full screen on its side with the controls over the picture
 * (tap to show or hide them); radio as the station's logo and programme, with the controls always there.
 */
@OptIn(UnstableApi::class)
@Composable
fun LivePlayerScreen(channel: String, radio: Boolean, onBack: () -> Unit) {
    val context = LocalContext.current
    val c = context.container
    val vm = viewModel(key = "live-player") { LivePlayerViewModel(c, context.applicationContext, channel, radio) }
    val ui by vm.ui.collectAsState()
    val timeOf = rememberTimeOf()
    val clock = minuteClock()
    var controls by remember { mutableStateOf(true) }
    var picking by remember { mutableStateOf(false) }

    if (!ui.radio) ImmersiveLandscape()
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { vm.onBackground() }
    LifecycleEventEffect(Lifecycle.Event.ON_START) { vm.onForeground() }
    LaunchedEffect(ui.missing) { if (ui.missing) onBack() }
    BackHandler(onBack = onBack)
    // The controls get out of the picture's way while it plays.
    LaunchedEffect(controls, ui.playing, ui.radio, picking) {
        if (controls && ui.playing && !ui.radio && !picking) {
            delay(HIDE_CONTROLS_MS)
            controls = false
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    player = vm.player
                    useController = false // the app's own controls
                    setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
                    setArtworkDisplayMode(PlayerView.ARTWORK_DISPLAY_MODE_OFF)
                    keepScreenOn = true
                }
            },
            onRelease = { it.player = null },
            modifier = Modifier.fillMaxSize(),
        )
        if (ui.radio) {
            RadioScreen(
                ui, clock, timeOf,
                onBack = onBack, onQuality = { picking = true }, onPrevious = { vm.zap(-1) }, onNext = { vm.zap(1) },
                onPlayPause = vm::togglePlay, onLive = vm::goLive,
            )
        } else {
            // A tap anywhere shows or hides the controls.
            Box(Modifier.fillMaxSize().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { controls = !controls })
            AnimatedVisibility(controls || !ui.playing, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.fillMaxSize()) {
                TvControls(
                    ui, clock, timeOf,
                    onBack = onBack, onQuality = { picking = true }, onPrevious = { vm.zap(-1) }, onNext = { vm.zap(1) },
                    onPlayPause = vm::togglePlay, onLive = vm::goLive,
                )
            }
        }
        if (ui.loading && ui.error == null) {
            CircularProgressIndicator(Modifier.align(Alignment.Center).size(56.dp), color = Palette.Accent)
        }
        ui.error?.let { error ->
            Surface(color = Color.Black.copy(alpha = 0.85f), shape = RoundedCornerShape(16.dp), modifier = Modifier.align(Alignment.Center).widthIn(max = 420.dp).padding(24.dp)) {
                Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(ui.errorTitle ?: "Can’t play this channel", style = MaterialTheme.typography.titleMedium, color = Color.White)
                    Text(error, color = Palette.TextDim, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
                    Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = vm::start) { Text("Try again") }
                        OutlinedButton(onClick = onBack) { Text(if (ui.radio) "Back to Radio" else "Back to the guide") }
                    }
                }
            }
        }
    }

    if (picking) {
        QualityDialog(ui, onPick = { id -> picking = false; if (id != ui.quality) vm.setQuality(id) }, onDismiss = { picking = false })
    }
}

/** TV: the channel along the top, the channel and play buttons in the middle, what's on along the bottom. */
@Composable
private fun TvControls(
    ui: LivePlayerViewModel.Ui,
    now: Long,
    timeOf: (Long) -> String,
    onBack: () -> Unit,
    onQuality: () -> Unit,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onPlayPause: () -> Unit,
    onLive: () -> Unit,
) {
    Box(Modifier.fillMaxSize()) {
        TopBar(ui, onBack, onQuality, Modifier.align(Alignment.TopCenter).background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.7f), Color.Transparent))))
        if (!ui.loading || ui.playing) PlayButtons(ui, onPrevious, onNext, onPlayPause, Modifier.align(Alignment.Center))
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.8f))))
                .windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 20.dp, vertical = 12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ui.channel?.let { ChannelLogo(it, 52.dp) }
                NowText(ui, now, timeOf, Modifier.weight(1f).padding(horizontal = 14.dp))
                LiveButton(ui.behindMs, onLive)
            }
        }
    }
}

/** Radio: the station's logo and programme fill the screen, and the controls stay. */
@Composable
private fun RadioScreen(
    ui: LivePlayerViewModel.Ui,
    now: Long,
    timeOf: (Long) -> String,
    onBack: () -> Unit,
    onQuality: () -> Unit,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onPlayPause: () -> Unit,
    onLive: () -> Unit,
) {
    Column(Modifier.fillMaxSize().background(Palette.Background).windowInsetsPadding(WindowInsets.safeDrawing)) {
        TopBar(ui, onBack, onQuality)
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            ui.channel?.let { ChannelLogo(it, 160.dp) }
            Spacer(Modifier.height(20.dp))
            ui.channel?.let { Text(it.title(), style = MaterialTheme.typography.titleMedium, color = Palette.TextDim) }
            val p = ui.now
            if (p != null) {
                Text(p.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
                Text(listOfNotNull("${timeOf(p.start)}–${timeOf(p.stop)}", p.subtitle).joinToString(" · "), color = Palette.TextDim, textAlign = TextAlign.Center)
                ProgressBar(p, now, Modifier.width(240.dp).padding(vertical = 10.dp))
                (p.description ?: p.summary)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Palette.TextDim, textAlign = TextAlign.Center, maxLines = 6, overflow = TextOverflow.Ellipsis) }
            } else {
                Text("No guide information", color = Palette.TextFaint, modifier = Modifier.padding(top = 8.dp))
            }
            ui.next?.let { Text("Next: ${timeOf(it.start)} ${it.title}", style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 12.dp)) }
        }
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Spacer(Modifier.weight(1f))
            PlayButtons(ui, onPrevious, onNext, onPlayPause)
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) { LiveButton(ui.behindMs, onLive) }
        }
    }
}

@Composable
private fun TopBar(ui: LivePlayerViewModel.Ui, onBack: () -> Unit, onQuality: () -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = if (ui.radio) "Back to Radio" else "Back to the guide", tint = Color.White)
        }
        Text(ui.channel?.title() ?: "", style = MaterialTheme.typography.titleMedium, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = 4.dp))
        if (ui.qualities.size > 1) {
            IconButton(onClick = onQuality) { Icon(Icons.Filled.Settings, contentDescription = "Quality", tint = Color.White) }
        }
    }
}

/** Previous channel, play/pause, next channel. */
@Composable
private fun PlayButtons(ui: LivePlayerViewModel.Ui, onPrevious: () -> Unit, onNext: () -> Unit, onPlayPause: () -> Unit, modifier: Modifier = Modifier) {
    val noun = if (ui.radio) "station" else "channel"
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(24.dp)) {
        RoundButton(onPrevious, 48) { Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "Previous $noun", tint = Color.White, modifier = Modifier.size(30.dp)) }
        RoundButton(onPlayPause, 64) {
            Icon(if (ui.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, contentDescription = if (ui.playing) "Pause" else "Play", tint = Color.White, modifier = Modifier.size(38.dp))
        }
        RoundButton(onNext, 48) { Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "Next $noun", tint = Color.White, modifier = Modifier.size(30.dp)) }
    }
}

@Composable
private fun RoundButton(onClick: () -> Unit, size: Int, content: @Composable () -> Unit) {
    Box(Modifier.size(size.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)).clickable(onClick = onClick), contentAlignment = Alignment.Center) { content() }
}

/** What's on: its title, channel and times, how far through it is, and what's next. */
@Composable
private fun NowText(ui: LivePlayerViewModel.Ui, now: Long, timeOf: (Long) -> String, modifier: Modifier = Modifier) {
    val p = ui.now
    Column(modifier) {
        Text(p?.title ?: ui.channel?.name ?: "", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            if (p != null) listOfNotNull(ui.channel?.name, "${timeOf(p.start)}–${timeOf(p.stop)}", p.subtitle).joinToString(" · ") else "No guide information",
            style = MaterialTheme.typography.bodySmall,
            color = Palette.TextDim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (p != null) ProgressBar(p, now, Modifier.fillMaxWidth().padding(vertical = 5.dp))
        ui.next?.let { Text("Next: ${timeOf(it.start)} ${it.title}", style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, maxLines = 1, overflow = TextOverflow.Ellipsis) }
    }
}

@Composable
private fun ProgressBar(p: Programme, now: Long, modifier: Modifier = Modifier) {
    LinearProgressIndicator(
        progress = { p.progress(now) },
        color = Palette.Accent,
        trackColor = Color.White.copy(alpha = 0.2f),
        drawStopIndicator = {},
        modifier = modifier.height(3.dp),
    )
}

/** "● Live"; behind (after pausing), how far, in the accent colour: tapping goes back to now. */
@Composable
private fun LiveButton(behindMs: Long, onClick: () -> Unit) {
    val behind = behindText(behindMs)
    Row(
        Modifier.clip(RoundedCornerShape(16.dp)).background(if (behind != null) Palette.Accent else Color.Black.copy(alpha = 0.45f))
            .clickable(onClickLabel = "Back to live", onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(if (behind != null) Palette.AccentText else Palette.Danger))
        Text(behind ?: "Live", style = MaterialTheme.typography.labelLarge, color = if (behind != null) Palette.AccentText else Color.White, modifier = Modifier.padding(start = 6.dp))
    }
}

@Composable
private fun QualityDialog(ui: LivePlayerViewModel.Ui, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Quality") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                ui.qualities.forEach { q ->
                    Row(
                        Modifier.fillMaxWidth().selectable(selected = q.id == ui.quality, onClick = { onPick(q.id) }, role = Role.RadioButton).padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = q.id == ui.quality, onClick = null)
                        Text(q.label, modifier = Modifier.padding(start = 12.dp))
                    }
                }
                Text(
                    "Live TV is always converted for the phone. Lower qualities suit slow connections; the one picked is kept for films too.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.TextDim,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
