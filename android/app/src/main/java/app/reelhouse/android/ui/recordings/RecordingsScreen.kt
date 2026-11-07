package app.reelhouse.android.ui.recordings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import app.reelhouse.android.AppContainer
import app.reelhouse.android.container
import app.reelhouse.android.data.events.ServerEvent
import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.data.model.Recording
import app.reelhouse.android.data.model.RecordingCounts
import app.reelhouse.android.data.model.RecordingsDrive
import app.reelhouse.android.data.model.RecordingsResponse
import app.reelhouse.android.data.model.SeriesRecording
import app.reelhouse.android.data.model.User
import app.reelhouse.android.ui.common.Loadable
import app.reelhouse.android.ui.common.LoadableContent
import app.reelhouse.android.ui.common.endOfRow
import app.reelhouse.android.ui.common.errorText
import app.reelhouse.android.ui.common.refreshOnServerEvents
import app.reelhouse.android.ui.common.remoteFocus
import app.reelhouse.android.ui.components.AvatarCircle
import app.reelhouse.android.ui.components.FilterChip
import app.reelhouse.android.ui.components.RemoteImage
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.livetv.ChannelLogo
import app.reelhouse.android.ui.livetv.cancelSeriesText
import app.reelhouse.android.ui.livetv.epochNow
import app.reelhouse.android.ui.livetv.rememberTimeOf
import app.reelhouse.android.ui.livetv.title
import app.reelhouse.android.ui.theme.Palette
import app.reelhouse.android.ui.theme.pictureHighlight
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

// Manage Recordings, as a library (web/js/views/recordings.js), like a TV library: shows, then their series, then the
// episodes. The Live TV recordings you set from the guide, grouped into shows with their cover art (TMDB's poster for
// the show's name, else the guide's picture, else the channel's logo), under the headings Recording now (a red mark),
// Recorded (newest first, the count of recorded episodes in the corner) and Scheduled (soonest first, when the next
// one records), each a grid like a library's. A show opens its series (RecordingShowScreen), a series its
// episodes (RecordingSeriesScreen). The button in a cover's top left corner (always there, as a phone can't point at
// it) deletes the show, the series or the recording, after asking; what's still to come keeps recording. Under them, Series
// recordings: what's been set to record every episode of a show on a channel (from the guide), × cancelling one. Admins can
// switch to everyone's, with who set each. How full Tvheadend's recordings drive is sits on the first line, across from
// those (the top bar has no room for it on a phone). Read again every minute while it's shown.

internal const val REFRESH_MS = 60_000L
private const val MAX_FACES = 3 // pictures on a cover's line of who set it (their names all follow)
private val PosterShape = RoundedCornerShape(6.dp)
private val PosterWidth = 240.dp

/** Deletes recordings' recorded episodes at once (a series, a show); what's said once it's done. */
internal suspend fun AppContainer.deleteAll(recs: List<Recording>): String {
    val r = api.deleteRecordings(deletable(recs).map { it.uuid })
    return (if (r.deleted == 1) "Deleted 1 recording" else "Deleted ${r.deleted} recordings") +
        if (r.skipped.isNotEmpty()) " (${r.skipped.size} couldn’t be)" else ""
}

class RecordingsViewModel(private val c: AppContainer) : ViewModel() {
    private val _list = MutableStateFlow(Loadable<RecordingsResponse>())
    val list: StateFlow<Loadable<RecordingsResponse>> = _list.asStateFlow()
    /** Admins: everyone's recordings rather than their own. */
    private val _everyone = MutableStateFlow(false)
    val everyone: StateFlow<Boolean> = _everyone.asStateFlow()
    /** One-off notes for the snackbar. */
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    init {
        load()
        // Live TV turned off, or this account's switches changed.
        refreshOnServerEvents(c, { it is ServerEvent.LiveTvChanged }) { reload() }
    }

    fun load() {
        viewModelScope.launch {
            _list.value = Loadable()
            reload()
        }
    }

    fun showEveryone(all: Boolean) {
        if (all == _everyone.value) return
        _everyone.value = all
        load()
    }

    suspend fun reload() {
        try {
            _list.value = Loadable(c.api.recordings(_everyone.value), loading = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (_list.value.data == null) _list.value = Loadable(loading = false, error = c.errorText(e))
        }
    }

    /** Ends a series recording: what it had scheduled goes; what's recording or recorded stays. */
    fun cancelSeries(s: SeriesRecording) {
        viewModelScope.launch {
            try {
                c.api.cancelSeries(s.uuid)
                _messages.emit("Series recording cancelled")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _messages.emit(c.errorText(e))
            }
            reload()
        }
    }

    /** Delete show: its recorded episodes this account may delete. */
    fun deleteAll(recs: List<Recording>) {
        viewModelScope.launch {
            try {
                _messages.emit(c.deleteAll(recs))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _messages.emit(c.errorText(e))
            }
            reload()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordingsScreen(onOpenShow: (key: String, title: String, everyone: Boolean) -> Unit, onBack: () -> Unit) {
    val c = LocalContext.current.container
    val vm = viewModel { RecordingsViewModel(c) }
    val list by vm.list.collectAsState()
    val everyone by vm.everyone.collectAsState()
    val profile by c.store.profile.collectAsState()
    val isAdmin = profile?.user?.isAdmin == true
    val timeOf = rememberTimeOf()
    val snackbar = remember { SnackbarHostState() }
    var confirm by remember { mutableStateOf<Pair<String, List<Recording>>?>(null) }
    var seriesDetails by remember { mutableStateOf<SeriesRecording?>(null) }
    var cancellingSeries by remember { mutableStateOf<SeriesRecording?>(null) }
    LaunchedEffect(vm) { vm.messages.collect { snackbar.showSnackbar(it) } }

    // Read again every minute while it's shown (and as soon as it's back on screen, e.g. from a show's page).
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(vm) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            if (vm.list.value.data != null) vm.reload()
            while (true) {
                delay(REFRESH_MS)
                vm.reload()
            }
        }
    }

    val statusRow = statusRowBar()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Manage Recordings") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                expandedHeight = statusRow.height,
                windowInsets = statusRow.insets,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.Background),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        LoadableContent(list, onRetry = vm::load, modifier = Modifier.fillMaxSize().padding(padding)) { data ->
            val now = epochNow()
            val sections = showSections(data.shows)
            // With a remote, the first cover; with nothing to show, the switch between Mine and Everyone's.
            val startsAt = sections.firstOrNull()?.let { (section, shows) -> "${section.name}-${shows.first().key}" }
                ?: data.series.firstOrNull()?.let { "series-${it.uuid}" }
            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 104.dp),
                contentPadding = PaddingValues(16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                modifier = Modifier.fillMaxSize().padding(padding),
            ) {
                if (isAdmin || data.drive != null) {
                    wide {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (isAdmin) {
                                WhoseChip("Mine", !everyone, Modifier.remoteFocus("mine", first = startsAt == null)) { vm.showEveryone(false) }
                                WhoseChip("Everyone’s", everyone) { vm.showEveryone(true) }
                            }
                            Spacer(Modifier.weight(1f))
                            data.drive?.let { DriveBar(it) }
                        }
                    }
                }
                wide {
                    Text(
                        if (everyone) "Everyone’s recordings by show, with who set each." else "What you’ve set to record from the Live TV guide, by show.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Palette.TextDim,
                    )
                }
                if (data.shows.isEmpty() && data.series.isEmpty()) {
                    wide {
                        Text(
                            if (everyone) "Tvheadend has no recordings Reelhouse can see."
                            else "Nothing recorded or scheduled. Open a programme in the Live TV guide and choose Record.",
                            color = Palette.TextDim,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                }
                // Under their headings, each a grid like a library's: Recording now, Recorded (newest first), Scheduled (soonest first).
                sections.forEach { (section, shows) ->
                    wide { Text(section.title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp)) }
                    items(shows, key = { "${section.name}-${it.key}" }) { show ->
                        val all = show.seasons.flatMap { it.recordings }
                        val gone = deletable(all).size
                        CoverCard(
                            title = show.title,
                            line = showSectionLine(section, show, now, timeOf),
                            poster = show.poster,
                            channel = show.channel,
                            // Each section's own mark: REC while recording, the recorded count on Recorded.
                            counts = when (section) {
                                ShowSection.Now -> RecordingCounts(recording = show.counts.recording)
                                ShowSection.Recorded -> RecordingCounts(recorded = show.counts.recorded)
                                ShowSection.Scheduled -> RecordingCounts()
                            },
                            corner = if (section == ShowSection.Recorded && gone > 0) {
                                CornerAction(Icons.Filled.Delete, "Delete ${show.title} ($gone)", true) { confirm = "“${show.title}”" to all }
                            } else null,
                            owners = if (everyone) sectionRecordings(section, show) else null,
                            first = startsAt == "${section.name}-${show.key}",
                            last = show == shows.last(),
                        ) { onOpenShow(show.key, show.title, everyone) }
                    }
                }
                if (data.series.isNotEmpty()) {
                    wide { Text("Series recordings", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp)) }
                    items(data.series, key = { "series-${it.uuid}" }) { s ->
                        CoverCard(
                            title = s.title,
                            line = seriesLine(s, now, timeOf, word = ""),
                            line2 = s.channel?.name,
                            poster = s.poster,
                            channel = s.channel,
                            counts = RecordingCounts(recording = s.counts.recording),
                            corner = if (s.canChange) CornerAction(Icons.Filled.Close, "Cancel series recording: ${s.title}", false) { cancellingSeries = s } else null,
                            people = if (everyone) listOfNotNull(s.owner) else null,
                            first = startsAt == "series-${s.uuid}",
                            last = s == data.series.last(),
                        ) { seriesDetails = s }
                    }
                }
            }
        }
    }

    confirm?.let { (what, recs) -> DeleteAllDialog(what, recs, onDismiss = { confirm = null }) { confirm = null; vm.deleteAll(recs) } }
    seriesDetails?.let { s ->
        val hasShow = list.data?.shows?.any { it.key == s.key } == true
        SeriesDialog(
            s, timeOf,
            onOpenShow = if (hasShow) ({ seriesDetails = null; onOpenShow(s.key, s.title, everyone) }) else null,
            onCancel = { seriesDetails = null; cancellingSeries = s },
            onDismiss = { seriesDetails = null },
        )
    }
    cancellingSeries?.let { s ->
        AlertDialog(
            onDismissRequest = { cancellingSeries = null },
            title = { Text("Cancel this series recording?") },
            text = { Text(cancelSeriesText(s.title, !s.mine, s.owner?.username)) },
            confirmButton = {
                TextButton(onClick = { cancellingSeries = null; vm.cancelSeries(s) }) { Text("Cancel series recording", color = Palette.Danger) }
            },
            dismissButton = { TextButton(onClick = { cancellingSeries = null }) { Text("Keep it") } },
        )
    }
}

/** What a series recording does and what it has made so far, with its show's page and Cancel series recording. */
@Composable
private fun SeriesDialog(s: SeriesRecording, timeOf: (Long) -> String, onOpenShow: (() -> Unit)?, onCancel: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(s.title) },
        text = {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    s.channel?.let { ChannelLogo(it, 44.dp) }
                    Column(Modifier.padding(start = if (s.channel != null) 12.dp else 0.dp)) {
                        s.channel?.let { Text(it.title(), style = MaterialTheme.typography.bodyMedium) }
                        Text(seriesLine(s, epochNow(), timeOf), style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
                    }
                }
                Text("Records every episode of this show on this channel. Repeats are left out when the guide can tell.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 12.dp))
                countsLine(s.counts).takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextFaint, modifier = Modifier.padding(top = 8.dp)) }
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
                    s.owner?.let { AvatarCircle(it, 18); Spacer(Modifier.width(6.dp)) }
                    Text(s.owner?.let { "Set by ${it.username}" } ?: "Not set through Reelhouse", style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
                }
            }
        },
        confirmButton = {
            Row {
                onOpenShow?.let { TextButton(onClick = it) { Text("Episodes") } }
                if (s.canChange) TextButton(onClick = onCancel) { Text("Cancel series", color = Palette.Danger) }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

/** How full Tvheadend's recordings drive is, as in the web app's Settings → Live TV. */
@Composable
private fun DriveBar(drive: RecordingsDrive) {
    val low = driveLow(drive)
    // As wide as there's room for beside the chips, up to a point; a narrow phone wraps its lines rather than cut them off.
    Column(Modifier.widthIn(max = 200.dp)) {
        Text("Recordings drive", style = MaterialTheme.typography.labelSmall, color = Palette.TextFaint)
        Text(driveLine(drive), style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
        if (low) Text("Low on space", style = MaterialTheme.typography.labelSmall, color = Palette.Danger)
        Box(Modifier.padding(vertical = 4.dp).fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(Palette.Elevated3)) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(driveUsed(drive)).background(if (low) Palette.Danger else Palette.Accent))
        }
        driveHint(drive)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Palette.TextFaint) }
    }
}

/** An item as wide as the grid. */
internal fun LazyGridScope.wide(content: @Composable () -> Unit) {
    item(span = { GridItemSpan(maxLineSpan) }) { content() }
}

@Composable
internal fun WhoseChip(label: String, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        modifier = modifier,
        label = { Text(label) },
        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Palette.Accent, selectedLabelColor = Palette.AccentText),
    )
}

/** Asks before deleting a series' or a show's recorded episodes (deleteManyText says how many, whose, what stays). */
@Composable
internal fun DeleteAllDialog(what: String, recs: List<Recording>, onDismiss: () -> Unit, onDelete: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Delete $what?") },
        text = { Text(deleteManyText(recs)) },
        confirmButton = { TextButton(onClick = onDelete) { Text("Delete", color = Palette.Danger) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Keep them") } },
    )
}

/** The button in a cover's top left corner: [danger] ones (Delete, Stop) turn red. */
internal class CornerAction(val icon: ImageVector, val label: String, val danger: Boolean, val onClick: () -> Unit)

/** A picture, or a channel's logo and a name when there's none (or it can't be had). */
@Composable
internal fun CoverPicture(path: String?, width: Dp, title: String, channel: Channel?, modifier: Modifier) {
    var failed by remember(path) { mutableStateOf(path == null) }
    Box(modifier.clip(PosterShape).background(Palette.Elevated2), contentAlignment = Alignment.Center) {
        if (!failed) {
            RemoteImage(path, width, null, Modifier.fillMaxSize(), onError = { failed = true })
        } else {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(8.dp)) {
                channel?.let { ChannelLogo(it, 48.dp) }
                Spacer(Modifier.size(6.dp))
                Text(title, style = MaterialTheme.typography.bodySmall, color = Palette.TextFaint, textAlign = TextAlign.Center, maxLines = 3)
            }
        }
    }
}

/** A show's poster in a page's head. */
@Composable
internal fun ShowPoster(poster: String?, title: String, channel: Channel?, modifier: Modifier = Modifier) {
    CoverPicture(poster, PosterWidth, title, channel, modifier.fillMaxWidth().aspectRatio(2f / 3f))
}

@Composable
internal fun BoxScope.CornerButton(action: CornerAction) {
    // A small dark circle in the corner; the button around it keeps a full-size touch target.
    IconButton(onClick = action.onClick, modifier = Modifier.align(Alignment.TopStart)) {
        Box(
            Modifier.size(32.dp).background(if (action.danger) Color(0xCC3A0F0C) else Color.Black.copy(alpha = 0.7f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(action.icon, contentDescription = action.label, tint = Color.White, modifier = Modifier.size(18.dp))
        }
    }
}

/** A red REC (recording now) or a coloured word (Scheduled, a failure) in the picture's bottom left corner. */
@Composable
internal fun BoxScope.StateTag(text: String, background: Color, textColour: Color = Color.White, dot: Boolean = false) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.align(Alignment.BottomStart).padding(6.dp).clip(RoundedCornerShape(11.dp)).background(background)
            .padding(horizontal = 7.dp, vertical = 2.dp),
    ) {
        if (dot) {
            Icon(Icons.Filled.FiberManualRecord, contentDescription = null, tint = textColour, modifier = Modifier.size(8.dp))
            Spacer(Modifier.width(3.dp))
        }
        Text(text, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = textColour, maxLines = 1)
    }
}

/** Who set these recordings, as under a request's poster: their pictures and names; says so when nobody here did. */
@Composable
internal fun OwnerLine(recs: List<Recording>) = PeopleLine(recordingOwners(recs))

/** The pictures and names of who set something; says so when nobody here did. */
@Composable
internal fun PeopleLine(people: List<User>) {
    if (people.isEmpty()) {
        Text("Not set through Reelhouse", style = MaterialTheme.typography.bodySmall, color = Palette.TextFaint, modifier = Modifier.padding(top = 4.dp))
        return
    }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
        // Overlapping when there are several, each ringed in the page's colour.
        Row(horizontalArrangement = Arrangement.spacedBy((-6).dp)) {
            people.take(MAX_FACES).forEach { AvatarCircle(it, 18, Modifier.border(1.dp, Palette.Background, CircleShape)) }
        }
        Spacer(Modifier.width(6.dp))
        Text(people.joinToString(", ") { it.username }, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A show's or a series' cover: its poster, REC while recording, the count of recorded ones, the corner button, who set what's in it. */
@Composable
internal fun CoverCard(
    title: String,
    line: String,
    poster: String?,
    channel: Channel?,
    counts: RecordingCounts,
    corner: CornerAction?,
    owners: List<Recording>? = null,
    people: List<User>? = null,
    line2: String? = null,
    first: Boolean = false,
    last: Boolean = false,
    onClick: () -> Unit,
) {
    val press = remember { MutableInteractionSource() }
    Column(Modifier.remoteFocus("show-$title", first).endOfRow(last).fillMaxWidth().clickable(press, null, onClick = onClick)) {
        Box(Modifier.pictureHighlight(press, RoundedCornerShape(6.dp))) {
            ShowPoster(poster, title, channel)
            if (counts.recording > 0) StateTag("REC", Palette.Danger, dot = true)
            if (counts.recorded > 0) {
                Box(
                    Modifier.align(Alignment.TopEnd).padding(6.dp).clip(RoundedCornerShape(11.dp)).background(Palette.Accent)
                        .padding(horizontal = 7.dp, vertical = 2.dp)
                        .clearAndSetSemantics { contentDescription = if (counts.recorded == 1) "1 recording" else "${counts.recorded} recordings" },
                ) {
                    Text("${counts.recorded}", style = MaterialTheme.typography.labelSmall, color = Palette.AccentText)
                }
            }
            corner?.let { CornerButton(it) }
        }
        Text(title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        Text(line, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        line2?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        owners?.let { OwnerLine(it) }
        people?.let { PeopleLine(it) }
    }
}
