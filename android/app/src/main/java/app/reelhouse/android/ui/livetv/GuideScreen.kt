package app.reelhouse.android.ui.livetv

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.rememberScrollableState
import androidx.compose.foundation.gestures.scrollable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.reelhouse.android.container
import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.data.model.Programme
import app.reelhouse.android.ui.common.CenteredMessage
import app.reelhouse.android.ui.common.Loading
import app.reelhouse.android.ui.common.arrowScroll
import app.reelhouse.android.ui.common.focusRow
import app.reelhouse.android.ui.common.remoteFocus
import app.reelhouse.android.ui.common.startFocus
import app.reelhouse.android.ui.components.FilterChip
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.theme.Palette
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

// Live TV's guide (Tvheadend's EPG), as the web app's: on a phone held upright a list of channels with what's on now
// and next; on a wide screen (a phone on its side, a tablet) a grid of channels against time with a line at "now",
// loading more hours as it's scrolled on, and on a tall one the last programme tapped underneath. A programme opens its
// details, with Watch and, for accounts allowed to, Record / Cancel recording / Stop recording (their own recordings;
// an admin's, anyone's: see the Recordings screen). Radio is the same guide with its stations, and Listen instead of
// Watch.

private const val REFRESH_MS = 60_000L
private const val WIDE_DP = 600
private const val SUMMARY_DP = 520 // tall enough for the highlighted programme under the grid
private val DpPerMin = 4.dp // 30 minutes = 120 dp
private val RowHeight = 60.dp
private val RulerHeight = 30.dp
private val ChannelWidth = 132.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GuideScreen(radio: Boolean, onPlay: (Channel) -> Unit, onBack: () -> Unit) {
    val c = LocalContext.current.container
    val vm = viewModel(key = if (radio) "radio-guide" else "tv-guide") { GuideViewModel(c, radio) }
    val ui by vm.ui.collectAsState()
    val timeOf = rememberTimeOf()
    val snackbar = remember { SnackbarHostState() }
    var open by remember { mutableStateOf<Programme?>(null) }
    var cancelling by remember { mutableStateOf<Programme?>(null) }
    var highlighted by remember { mutableStateOf<Long?>(null) }
    val config = LocalConfiguration.current
    val wide = config.screenWidthDp >= WIDE_DP
    val statusRow = statusRowBar()

    // The now-line moves and programmes change: the hours on screen are read again every minute while it's shown
    // (and as soon as it's back on screen).
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(vm) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            if (vm.ui.value.loaded) vm.reload()
            while (true) {
                delay(REFRESH_MS)
                vm.reload()
            }
        }
    }
    LaunchedEffect(ui.message) {
        ui.message?.let {
            snackbar.showSnackbar(it)
            vm.messageShown()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (radio) "Radio" else "Live TV") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                expandedHeight = statusRow.height,
                windowInsets = statusRow.insets,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.Background),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when {
                !ui.loaded && ui.error != null -> CenteredMessage(ui.error!!, action = "Try again", onAction = vm::reload)
                !ui.loaded -> Loading()
                ui.channels.isEmpty() -> CenteredMessage(
                    if (radio) "No radio stations. Tvheadend gives radio stations a channel tag such as “Radio channels” when it maps them; stations without one show here once they’ve been played."
                    else "No channels. Tvheadend has no channels this server’s account may watch.",
                )
                else -> {
                    DayChips(ui.day, ui.now, vm::pickDay)
                    val verb = if (radio) "Listen" else "Watch"
                    val rows = ui.rows
                    val pick: (Programme) -> Unit = { highlighted = it.id; open = it }
                    if (wide) {
                        val shown = ui.events.firstOrNull { it.id == highlighted && it.stop > ui.from } ?: firstHighlight(rows, ui.now, ui.from)
                        GuideGrid(ui, rows, shown?.id, verb, timeOf, onPlay, pick, { highlighted = it.id }, vm::loadMore, Modifier.weight(1f))
                        if (config.screenHeightDp >= SUMMARY_DP && shown != null) {
                            HorizontalDivider(color = Palette.Border)
                            Summary(shown, ui.channels.firstOrNull { it.uuid == shown.channel }, ui.now, timeOf)
                        }
                    } else {
                        GuideList(rows, ui.now, verb, timeOf, onPlay, pick)
                    }
                }
            }
        }
    }

    open?.let { p ->
        val channel = ui.channels.firstOrNull { it.uuid == p.channel }
        // Shown as the guide has it now (e.g. scheduled since), or as it was if it's gone from the hours on screen.
        val current = ui.events.firstOrNull { it.id == p.id } ?: p
        ProgrammeDialog(
            current, channel, epochNow(), ui.canRecord, ui.canRecordSeries, radio, timeOf,
            onPlay = { channel?.let(onPlay); open = null },
            onRecord = { action -> vm.record(current, action); open = null },
            onSeries = { action ->
                open = null
                if (action == SeriesAction.Cancel) cancelling = current else vm.series(current, action, channel?.name)
            },
            onDismiss = { open = null },
        )
    }
    cancelling?.let { p ->
        AlertDialog(
            onDismissRequest = { cancelling = null },
            title = { Text("Cancel this series recording?") },
            text = { Text(cancelSeriesText(showName(p.title))) },
            confirmButton = {
                TextButton(onClick = { cancelling = null; vm.series(p, SeriesAction.Cancel, null) }) { Text("Cancel series recording", color = Palette.Danger) }
            },
            dismissButton = { TextButton(onClick = { cancelling = null }) { Text("Keep it") } },
        )
    }
}

@Composable
private fun DayChips(day: Int, now: Long, onPick: (Int) -> Unit) {
    Row(Modifier.focusRow().fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (i in 0 until 7) {
            FilterChip(
                selected = i == day,
                onClick = { onPick(i) },
                label = { Text(dayChip(i, now)) },
                colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Palette.Accent, selectedLabelColor = Palette.AccentText),
            )
        }
    }
}

// ---------- a phone held upright: what's on now and next on each channel ----------

@Composable
private fun GuideList(rows: List<GuideRow>, now: Long, verb: String, timeOf: (Long) -> String, onPlay: (Channel) -> Unit, onOpen: (Programme) -> Unit) {
    LazyColumn(Modifier.fillMaxSize()) {
        items(rows, key = { it.channel.uuid }) { row ->
            val (current, next) = row.nowAndNext(now)
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
                // The channel itself plays it.
                Column(
                    Modifier.width(64.dp).clip(RoundedCornerShape(8.dp)).clickable(onClickLabel = verb) { onPlay(row.channel) }.padding(4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    ChannelLogo(row.channel, 52.dp)
                    row.channel.numberLabel?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Palette.TextFaint) }
                }
                Column(Modifier.weight(1f).padding(start = 10.dp)) {
                    Text(
                        row.channel.name,
                        style = MaterialTheme.typography.labelMedium,
                        color = Palette.TextDim,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.clickable(onClickLabel = verb) { onPlay(row.channel) }.padding(vertical = 2.dp),
                    )
                    if (current != null) {
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).clickable { onOpen(current) }.padding(vertical = 2.dp)) {
                            TitleLine(current)
                            LinearProgressIndicator(
                                progress = { current.progress(now) },
                                color = Palette.Accent,
                                trackColor = Palette.Elevated3,
                                drawStopIndicator = {},
                                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).height(3.dp),
                            )
                            Text(
                                "${timeOf(current.start)}–${timeOf(current.stop)} · ${current.minutesLeft(now)} min left",
                                style = MaterialTheme.typography.bodySmall,
                                color = Palette.TextDim,
                            )
                        }
                    } else {
                        Text("No guide information", style = MaterialTheme.typography.bodySmall, color = Palette.TextFaint)
                    }
                    if (next != null) {
                        Text(
                            "${timeOf(next.start)} ${next.title}",
                            style = MaterialTheme.typography.bodySmall,
                            color = Palette.TextDim,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).clickable { onOpen(next) }.padding(vertical = 4.dp),
                        )
                    }
                }
            }
            HorizontalDivider(color = Palette.Border)
        }
    }
}

@Composable
private fun TitleLine(p: Programme) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (p.markedRecording()) RecDot()
        Text(p.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun RecDot() {
    Icon(Icons.Filled.FiberManualRecord, contentDescription = "Recording", tint = Palette.Danger, modifier = Modifier.padding(end = 4.dp).size(10.dp))
}

// ---------- a wide screen: the grid ----------

@Composable
private fun GuideGrid(
    ui: GuideViewModel.Ui,
    rows: List<GuideRow>,
    highlighted: Long?,
    verb: String,
    timeOf: (Long) -> String,
    onPlay: (Channel) -> Unit,
    onOpen: (Programme) -> Unit,
    onFocused: (Programme) -> Unit,
    onNearEnd: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val pxPerMin = with(density) { DpPerMin.toPx() }
    val channelPx = with(density) { ChannelWidth.toPx() }
    // How far along the hours the grid is scrolled (px); a new day starts from its beginning.
    var scrollX by remember(ui.generation) { mutableFloatStateOf(0f) }
    // Today's guide moves on with the time (followNow): the scroll moves back as much, so the hours on screen stay (at
    // the start, what's on now stays near the left as the programmes move along).
    var scrolledFrom by remember(ui.generation) { mutableLongStateOf(ui.from) }
    LaunchedEffect(ui.from) {
        if (ui.from > scrolledFrom) scrollX = max(0f, scrollX - (ui.from - scrolledFrom) / 60f * pxPerMin)
        scrolledFrom = ui.from
    }
    var viewport by remember { mutableFloatStateOf(0f) }
    val totalPx = (ui.to - ui.from) / 60f * pxPerMin
    val maxScroll = max(0f, totalPx - viewport)
    val scrollState = rememberScrollableState { delta ->
        val before = scrollX
        scrollX = (scrollX - delta).coerceIn(0f, maxScroll)
        before - scrollX
    }
    // More hours as the end comes near.
    LaunchedEffect(ui.to, viewport) {
        snapshotFlow { scrollX + viewport > totalPx - with(density) { 600.dp.toPx() } }.collect { near -> if (near && viewport > 0) onNearEnd() }
    }
    val x: () -> Float = { scrollX }
    // The day of the hours on screen, along the top (only told again when it changes).
    val shownDay by remember(ui.from, ui.now) { derivedStateOf { dayLabel(ui.from + (scrollX / pxPerMin * 60).toLong(), ui.now) } }
    val titleRoom = with(density) { 56.dp.toPx() }

    Box(modifier.fillMaxWidth().onSizeChanged { viewport = it.width - channelPx }.scrollable(scrollState, Orientation.Horizontal)) {
        Column(Modifier.fillMaxSize()) {
            // The times along the top.
            Row(Modifier.fillMaxWidth().height(RulerHeight)) {
                Box(Modifier.width(ChannelWidth).fillMaxHeight().padding(start = 12.dp), contentAlignment = Alignment.CenterStart) {
                    Text(shownDay, style = MaterialTheme.typography.labelMedium, color = Palette.TextDim, maxLines = 1)
                }
                val times = halfHours(ui.from, ui.to)
                Timeline(times.map { Span((it - ui.from) / 60f, (it - ui.from) / 60f + 30) }, x, pxPerMin, gapPx = 0, Modifier.weight(1f).fillMaxHeight()) {
                    times.forEach { t ->
                        Box(contentAlignment = Alignment.CenterStart) {
                            Text(timeOf(t), style = MaterialTheme.typography.labelMedium, color = Palette.TextDim, modifier = Modifier.padding(start = 6.dp))
                        }
                    }
                }
            }
            HorizontalDivider(color = Palette.Border)
            LazyColumn(Modifier.fillMaxSize()) {
                items(rows, key = { it.channel.uuid }) { row ->
                    Row(Modifier.fillMaxWidth().height(RowHeight).padding(vertical = 2.dp)) {
                        ChannelCell(row.channel, verb) { onPlay(row.channel) }
                        if (row.programmes.isEmpty()) {
                            Box(Modifier.weight(1f).fillMaxHeight().padding(start = 8.dp), contentAlignment = Alignment.CenterStart) {
                                Text("No guide information", style = MaterialTheme.typography.bodySmall, color = Palette.TextFaint)
                            }
                        } else {
                            val spans = row.programmes.map { it.span(ui.from, ui.to) }
                            Timeline(spans, x, pxPerMin, gapPx = with(density) { 3.dp.roundToPx() }, Modifier.weight(1f).fillMaxHeight()) {
                                row.programmes.forEachIndexed { i, p ->
                                    val start = spans[i].startMin * pxPerMin
                                    val room = max(0f, spans[i].lengthMin * pxPerMin - titleRoom)
                                    // Partly scrolled off: its title stays in sight.
                                    // With a remote: the one with the focus is the one described, and is brought into sight.
                                    val end = start + spans[i].lengthMin * pxPerMin
                                    val focus = Modifier.remoteFocus("programme-${p.id}", first = p.id == highlighted).onFocusChanged {
                                        if (it.isFocused) {
                                            onFocused(p)
                                            if (start < scrollX) {
                                                scrollX = start
                                            } else if (end > scrollX + viewport) {
                                                scrollX = min(start, end - viewport).coerceIn(0f, maxScroll)
                                            }
                                        }
                                    }
                                    key(p.id) { ProgrammeBlock(p, ui.now, p.id == highlighted, timeOf, focus, shift = { (scrollX - start).coerceIn(0f, room).roundToInt() }) { onOpen(p) } }
                                }
                            }
                        }
                    }
                }
            }
        }
        // The line at "now", over the programmes.
        if (ui.now >= ui.from && ui.now < ui.to) {
            val nowPx = (ui.now - ui.from) / 60f * pxPerMin
            Box(
                Modifier
                    .padding(top = RulerHeight)
                    .offset { IntOffset((channelPx + nowPx - scrollX).roundToInt(), 0) }
                    .graphicsLayer { alpha = if (nowPx < scrollX) 0f else 1f } // scrolled past: not over the channels
                    .width(2.dp)
                    .fillMaxHeight()
                    .background(Palette.Accent),
            )
        }
    }
}

/**
 * Children placed along a time axis: each at its [spans] entry (minutes from the guide's start), [pxPerMin] wide per
 * minute less [gapPx], moved left by [scrollX] (read while placing, so scrolling only moves them).
 */
@Composable
private fun Timeline(spans: List<Span>, scrollX: () -> Float, pxPerMin: Float, gapPx: Int, modifier: Modifier, content: @Composable () -> Unit) {
    Layout(content, modifier.clipToBounds()) { measurables, constraints ->
        val placeables = measurables.mapIndexed { i, m ->
            val w = max((spans[i].lengthMin * pxPerMin).roundToInt() - gapPx, 4)
            m.measure(Constraints.fixed(w, constraints.maxHeight))
        }
        layout(constraints.maxWidth, constraints.maxHeight) {
            val sx = scrollX()
            placeables.forEachIndexed { i, p -> p.place((spans[i].startMin * pxPerMin - sx).roundToInt(), 0) }
        }
    }
}

@Composable
private fun ChannelCell(channel: Channel, verb: String, onPlay: () -> Unit) {
    Row(
        Modifier.remoteFocus("channel-${channel.uuid}").width(ChannelWidth).fillMaxHeight().padding(horizontal = 6.dp).clip(RoundedCornerShape(6.dp)).background(Palette.Elevated)
            .clickable(onClickLabel = verb, onClick = onPlay).padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ChannelLogo(channel, 40.dp)
        Column(Modifier.padding(start = 8.dp)) {
            channel.numberLabel?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Palette.TextFaint) }
            Text(channel.name, style = MaterialTheme.typography.labelMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun ProgrammeBlock(p: Programme, now: Long, selected: Boolean, timeOf: (Long) -> String, focus: Modifier, shift: () -> Int, onClick: () -> Unit) {
    val base = if (p.airing(now)) Palette.Elevated3 else Palette.Elevated2
    val fill = genreColour(p.genreGroup())?.let { lerp(base, it, 0.3f) } ?: base
    val border = when {
        selected -> Palette.Accent
        p.markedRecording() -> Palette.Danger
        else -> Color.Transparent
    }
    Box(
        focus.fillMaxSize().alpha(if (p.past(now)) 0.55f else 1f).clip(RoundedCornerShape(6.dp)).background(fill)
            .border(if (selected) 2.dp else 1.dp, border, RoundedCornerShape(6.dp)).clickable(onClick = onClick),
    ) {
        if (p.dvr?.state == "recording") Box(Modifier.width(3.dp).fillMaxHeight().background(Palette.Danger))
        Column(Modifier.offset { IntOffset(shift(), 0) }.padding(horizontal = 8.dp, vertical = 6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (p.markedRecording()) RecDot()
                Text(p.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text("${timeOf(p.start)}–${timeOf(p.stop)}", style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, maxLines = 1, overflow = TextOverflow.Clip)
        }
    }
}

/** The highlighted programme under the grid (a tall screen): when, what, and its description. */
@Composable
private fun Summary(p: Programme, channel: Channel?, now: Long, timeOf: (Long) -> String) {
    val day = dayLabel(p.start, now)
    Column(Modifier.fillMaxWidth().heightIn(max = 160.dp).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                (if (day == "Today") "" else "$day, ") + "${timeOf(p.start)}–${timeOf(p.stop)}",
                style = MaterialTheme.typography.titleSmall,
                color = Palette.Accent,
            )
            Text(p.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp).weight(1f, fill = false))
            p.dvr?.let { Text(recordingLabel(it), style = MaterialTheme.typography.labelMedium, color = Palette.Warn, modifier = Modifier.padding(start = 10.dp)) }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
            Text(listOfNotNull(channel?.name, p.episodeText(), p.subtitle, p.lengthText(now)).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
            p.genreName?.let { GenreLabel(p, it, Modifier.padding(start = 10.dp)) }
        }
        Text(p.description ?: p.summary ?: "No description.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextDim, modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable
private fun GenreLabel(p: Programme, name: String, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(genreColour(p.genreGroup()) ?: Palette.TextFaint))
        Text(name, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, modifier = Modifier.padding(start = 6.dp))
    }
}

// ---------- a programme's details ----------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProgrammeDialog(
    p: Programme,
    channel: Channel?,
    now: Long,
    canRecord: Boolean,
    canRecordSeries: Boolean,
    radio: Boolean,
    timeOf: (Long) -> String,
    onPlay: () -> Unit,
    onRecord: (RecordAction) -> Unit,
    onSeries: (SeriesAction) -> Unit,
    onDismiss: () -> Unit,
) {
    val action = recordAction(p, now, canRecord)
    val series = seriesAction(p, now, canRecordSeries)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(p.title) },
        text = {
            Column(Modifier.arrowScroll(rememberScrollState())) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    channel?.let { ChannelLogo(it, 44.dp) }
                    Column(Modifier.padding(start = if (channel != null) 12.dp else 0.dp)) {
                        channel?.let { Text(it.title(), style = MaterialTheme.typography.bodyMedium) }
                        Text(
                            "${dayLabel(p.start, now)}, ${timeOf(p.start)}–${timeOf(p.stop)} · ${p.minutes()} min",
                            style = MaterialTheme.typography.bodySmall,
                            color = Palette.TextDim,
                        )
                    }
                }
                val sub = listOfNotNull(p.episodeText(), p.subtitle).joinToString(" · ")
                if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 12.dp))
                p.genreName?.let { GenreLabel(p, it, Modifier.padding(top = 8.dp)) }
                p.dvr?.let { Text(recordingLabel(it), style = MaterialTheme.typography.labelLarge, color = Palette.Warn, modifier = Modifier.padding(top = 8.dp)) }
                Text(p.description ?: p.summary ?: "No description.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextDim, modifier = Modifier.padding(top = 12.dp))
                if (!canRecord && !p.past(now)) {
                    Spacer(Modifier.height(10.dp))
                    Text("Your account can’t schedule recordings.", style = MaterialTheme.typography.bodySmall, color = Palette.TextFaint)
                } else if (p.dvr?.canChange == false && !p.past(now)) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        if (p.dvr.series != null) "Someone else has a series recording of this; only they or an admin can change it."
                        else "Someone else set this recording; only they or an admin can cancel it.",
                        style = MaterialTheme.typography.bodySmall,
                        color = Palette.TextFaint,
                    )
                }
            }
        },
        confirmButton = {
            // Up to three, with Close: on a narrow phone they go on to more lines rather than off the side.
            FlowRow(horizontalArrangement = Arrangement.End) {
                val airing = p.airing(now) && channel != null
                action?.let { a ->
                    TextButton(
                        onClick = { onRecord(a) },
                        modifier = if (airing) Modifier else Modifier.startFocus(),
                        colors = if (a == RecordAction.Record || a == RecordAction.Restore) ButtonDefaults.textButtonColors() else ButtonDefaults.textButtonColors(contentColor = Palette.Danger),
                    ) { Text(a.label) }
                }
                series?.let { s ->
                    TextButton(
                        onClick = { onSeries(s) },
                        colors = if (s == SeriesAction.Record) ButtonDefaults.textButtonColors() else ButtonDefaults.textButtonColors(contentColor = Palette.Danger),
                    ) { Text(s.label) }
                }
                if (airing) TextButton(onClick = onPlay, modifier = Modifier.startFocus()) { Text(if (radio) "Listen" else "Watch") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, modifier = if (p.airing(now) && channel != null || action != null) Modifier else Modifier.startFocus()) { Text("Close") } },
    )
}
