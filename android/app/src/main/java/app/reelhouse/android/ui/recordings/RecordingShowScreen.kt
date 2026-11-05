package app.reelhouse.android.ui.recordings

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
import app.reelhouse.android.data.model.Recording
import app.reelhouse.android.data.model.RecordingShow
import app.reelhouse.android.data.model.RecordingsResponse
import app.reelhouse.android.ui.common.Loadable
import app.reelhouse.android.ui.common.LoadableContent
import app.reelhouse.android.ui.common.errorText
import app.reelhouse.android.ui.common.refreshOnServerEvents
import app.reelhouse.android.ui.components.AvatarCircle
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.livetv.ChannelLogo
import app.reelhouse.android.ui.livetv.epochNow
import app.reelhouse.android.ui.livetv.rememberTimeOf
import app.reelhouse.android.ui.livetv.title
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

// A show's series (from the Recordings screen) as covers, like a TV library's seasons (TMDB's poster for each series,
// else the show's), and a series' episodes as pictures (TMDB's still for each episode, else the guide's); a show
// without series numbers shows its episodes straight away. The button in a cover's top left corner deletes the series
// or the recording (asked first), cancels (×) a scheduled one or stops (■) one recording now; Delete show / Delete
// series at the top take all their recorded episodes, and what's still to come keeps recording. An episode opens its
// details. In an admin's everyone's view, who set each. Read again every minute while it's shown.

class RecordingShowViewModel(private val c: AppContainer, val key: String, val everyone: Boolean) : ViewModel() {
    private val _list = MutableStateFlow(Loadable<RecordingsResponse>())
    val list: StateFlow<Loadable<RecordingsResponse>> = _list.asStateFlow()
    /** One-off notes for the snackbar. */
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    init {
        load()
        refreshOnServerEvents(c, { it is ServerEvent.LiveTvChanged }) { reload() }
    }

    fun load() {
        viewModelScope.launch {
            _list.value = Loadable()
            reload()
        }
    }

    suspend fun reload() {
        try {
            _list.value = Loadable(c.api.recordings(everyone), loading = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (_list.value.data == null) _list.value = Loadable(loading = false, error = c.errorText(e))
        }
    }

    fun change(r: Recording, action: RecordingAction) = act { c.api.changeRecording(r.uuid, action.action); action.done }

    /** Delete series / Delete show: their recorded episodes this account may delete. */
    fun deleteAll(recs: List<Recording>) = act { c.deleteAll(recs) }

    private fun act(work: suspend () -> String) {
        viewModelScope.launch {
            try {
                _messages.emit(work())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _messages.emit(c.errorText(e))
            }
            reload()
        }
    }
}

private sealed interface Confirm {
    data class One(val recording: Recording, val action: RecordingAction) : Confirm
    data class All(val what: String, val recordings: List<Recording>) : Confirm
}

/** What a page's covers can do: ask before something, open an episode's details, or act on one at once. */
private class PageActions(val ask: (Confirm) -> Unit, val open: (Recording) -> Unit, val change: (Recording, RecordingAction) -> Unit) {
    /** A corner button: asks first when it must (Delete, someone else's), else does it. */
    fun corner(r: Recording, action: RecordingAction) = if (actionNeedsConfirming(r, action)) ask(Confirm.One(r, action)) else change(r, action)
}

private fun RecordingAction.icon(): ImageVector = when (this) {
    RecordingAction.Stop -> Icons.Filled.Stop
    RecordingAction.Cancel, RecordingAction.Skip -> Icons.Filled.Close
    RecordingAction.Delete -> Icons.Filled.Delete
}

/** A show's series as covers (or its episodes, when the guide gave no series numbers). */
@Composable
fun RecordingShowScreen(key: String, title: String, everyone: Boolean, onOpenSeries: (season: Int?) -> Unit, onBack: () -> Unit) {
    ShowPage(key, title, everyone, onBack, episodesOnly = { show -> show.seasons.none { it.season != null } }) { show, page ->
        val ask = page.ask
        val all = show.seasons.flatMap { it.recordings }
        head(show.poster, show, null, show.title, listOfNotNull(show.channel?.name, countsLine(show.counts).ifEmpty { null }).joinToString(" · "),
            deletable(all).size.takeIf { it > 0 }?.let { "Delete show ($it)" to { ask(Confirm.All("“${show.title}”", all)) } })
        if (show.seasons.any { it.season != null }) {
            items(show.seasons, key = { "s${it.season}" }) { season ->
                val gone = deletable(season.recordings).size
                CoverCard(
                    title = seriesName(season, show),
                    line = countsLine(season.counts),
                    poster = season.poster,
                    channel = show.channel,
                    counts = season.counts,
                    corner = if (gone > 0) CornerAction(Icons.Filled.Delete, "Delete ${seriesName(season, show)} ($gone)", true) {
                        ask(Confirm.All(seriesWhat(season, show), season.recordings))
                    } else null,
                    owners = if (everyone) season.recordings else null,
                ) { onOpenSeries(season.season) }
            }
        } else {
            episodes(all, everyone, page)
        }
    }
}

/** A series' recorded and scheduled episodes, as pictures. */
@Composable
fun RecordingSeriesScreen(key: String, title: String, season: Int?, everyone: Boolean, onBack: () -> Unit) {
    ShowPage(key, title, everyone, onBack, episodesOnly = { true }) { show, page ->
        val ask = page.ask
        val series = show.seasons.firstOrNull { it.season == season }
        if (series == null) {
            wide { Text("Nothing recorded in this series any more.", color = Palette.TextDim, modifier = Modifier.padding(top = 24.dp)) }
            return@ShowPage
        }
        head(series.poster, show, show.title, seriesName(series, show), countsLine(series.counts),
            deletable(series.recordings).size.takeIf { it > 0 }?.let { "Delete series ($it)" to { ask(Confirm.All(seriesWhat(series, show), series.recordings)) } })
        episodes(series.recordings, everyone, page)
    }
}

/** What a show's and a series' pages share: the data, the top bar, the grid, the questions and the details. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ShowPage(
    key: String,
    title: String,
    everyone: Boolean,
    onBack: () -> Unit,
    episodesOnly: (RecordingShow) -> Boolean,
    content: LazyGridScope.(show: RecordingShow, page: PageActions) -> Unit,
) {
    val c = LocalContext.current.container
    val vm = viewModel(key = "recordings-$key-$everyone") { RecordingShowViewModel(c, key, everyone) }
    val list by vm.list.collectAsState()
    val timeOf = rememberTimeOf()
    val snackbar = remember { SnackbarHostState() }
    var confirm by remember { mutableStateOf<Confirm?>(null) }
    var details by remember { mutableStateOf<Recording?>(null) }
    LaunchedEffect(vm) { vm.messages.collect { snackbar.showSnackbar(it) } }

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
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                expandedHeight = statusRow.height,
                windowInsets = statusRow.insets,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.Background),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        LoadableContent(list, onRetry = vm::load, modifier = Modifier.fillMaxSize().padding(padding)) { data ->
            val show = data.shows.firstOrNull { it.key == key }
            LazyVerticalGrid(
                // Posters as in a library; episodes' pictures wider (two to a row on a phone held upright).
                columns = GridCells.Adaptive(minSize = if (show != null && episodesOnly(show)) 150.dp else 104.dp),
                contentPadding = PaddingValues(16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                modifier = Modifier.fillMaxSize().padding(padding),
            ) {
                if (show == null) {
                    wide { Text("Nothing recorded under this name any more.", color = Palette.TextDim, modifier = Modifier.padding(top = 24.dp)) }
                } else {
                    content(show, PageActions({ confirm = it }, { details = it }, vm::change))
                }
            }
        }
    }

    details?.let { r ->
        EpisodeDialog(r, timeOf, onDismiss = { details = null }) { action ->
            details = null
            if (actionNeedsConfirming(r, action)) confirm = Confirm.One(r, action) else vm.change(r, action)
        }
    }
    when (val ask = confirm) {
        is Confirm.One -> {
            val r = ask.recording
            // Someone else's (an admin's view): says whose.
            val whose = when {
                r.mine -> null
                r.owner != null -> "${r.owner.username} set “${r.title}”."
                else -> "“${r.title}” wasn’t set through Reelhouse."
            }
            val deleting = ask.action == RecordingAction.Delete
            AlertDialog(
                onDismissRequest = { confirm = null },
                title = { Text(if (deleting) "Delete this recording?" else if (ask.action == RecordingAction.Stop) "Stop this recording?" else if (ask.action == RecordingAction.Skip) "Skip this episode?" else "Cancel this recording?") },
                text = {
                    Text(
                        if (deleting) listOfNotNull("“${r.title}” (${episodeLine(r)}) will be deleted from Tvheadend’s recordings drive. This can’t be undone.", whose).joinToString(" ")
                        else whose.orEmpty(),
                    )
                },
                confirmButton = {
                    TextButton(onClick = { confirm = null; vm.change(r, ask.action) }) {
                        Text(if (deleting) "Delete" else ask.action.dialogLabel(), color = Palette.Danger)
                    }
                },
                dismissButton = { TextButton(onClick = { confirm = null }) { Text("Keep it") } },
            )
        }
        is Confirm.All -> DeleteAllDialog(ask.what, ask.recordings, onDismiss = { confirm = null }) { confirm = null; vm.deleteAll(ask.recordings) }
        null -> Unit
    }
}

/** The page's head: its cover, what it belongs to ([over]), its name, what it has, and a Delete button for all of it. */
private fun LazyGridScope.head(poster: String?, show: RecordingShow, over: String?, name: String, meta: String, delete: Pair<String, () -> Unit>?) {
    wide {
        Row(verticalAlignment = Alignment.Bottom) {
            ShowPoster(poster, name, show.channel, Modifier.width(110.dp))
            Column(Modifier.weight(1f).padding(start = 16.dp)) {
                over?.let { Text(it, style = MaterialTheme.typography.labelLarge, color = Palette.TextDim) }
                Text(name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                if (meta.isNotEmpty()) Text(meta, style = MaterialTheme.typography.bodyMedium, color = Palette.TextDim, modifier = Modifier.padding(top = 4.dp))
                delete?.let { (label, onClick) ->
                    OutlinedButton(
                        onClick = onClick,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.Danger),
                        modifier = Modifier.padding(top = 10.dp),
                    ) {
                        Icon(Icons.Filled.Delete, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(label)
                    }
                }
            }
        }
    }
}

/** Episodes as pictures. */
private fun LazyGridScope.episodes(recs: List<Recording>, everyone: Boolean, page: PageActions) {
    items(recs, key = { it.uuid }) { r -> EpisodeCard(r, everyone, onCorner = { action -> page.corner(r, action) }) { page.open(r) } }
}

@Composable
private fun EpisodeCard(r: Recording, everyone: Boolean, onCorner: (RecordingAction) -> Unit, onClick: () -> Unit) {
    val timeOf = rememberTimeOf()
    val now = epochNow()
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Box {
            CoverPicture(r.still, 320.dp, episodeLine(r), r.channel, Modifier.fillMaxWidth().aspectRatio(16f / 9f))
            when {
                recordingTrouble(r) != null -> StateTag(recordingTrouble(r)!!, Palette.Danger)
                r.state == "recording" -> StateTag("REC", Palette.Danger, dot = true)
                r.state == "scheduled" -> StateTag("Scheduled", Palette.Warn, Palette.AccentText)
            }
            recordingAction(r)?.let { action ->
                CornerButton(CornerAction(action.icon(), "${action.label}: ${episodeLine(r)}", action != RecordingAction.Cancel && action != RecordingAction.Skip) { onCorner(action) })
            }
        }
        Text(episodeLine(r), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        Text(episodeCardLine(r, now, timeOf), style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (everyone) OwnerLine(listOf(r))
    }
}

/** An episode's details: channel, times, size, its state, who set it, the description, and what it offers. */
@Composable
private fun EpisodeDialog(r: Recording, timeOf: (Long) -> String, onDismiss: () -> Unit, onAction: (RecordingAction) -> Unit) {
    val action = recordingAction(r)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("${r.title}: ${episodeLine(r)}") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    r.channel?.let { ChannelLogo(it, 44.dp) }
                    Column(Modifier.padding(start = if (r.channel != null) 12.dp else 0.dp)) {
                        r.channel?.let { Text(it.title(), style = MaterialTheme.typography.bodyMedium) }
                        Text(recordingMeta(r, epochNow(), timeOf).substringAfter("${r.channel?.title()} · "), style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
                    }
                }
                val state = when (r.state) { "recording" -> "Recording now"; "scheduled" -> "Scheduled"; "failed" -> "Failed"; else -> "Recorded" }
                Text(
                    recordingTrouble(r)?.let { "$state: $it" } ?: state,
                    style = MaterialTheme.typography.labelLarge,
                    color = if (r.state == "failed" || recordingTrouble(r) != null || r.state == "recording") Palette.Danger else if (r.state == "scheduled") Palette.Warn else Palette.TextDim,
                    modifier = Modifier.padding(top = 10.dp),
                )
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
                    r.owner?.let { AvatarCircle(it, 18); Spacer(Modifier.width(6.dp)) }
                    Text(r.owner?.let { "Set by ${it.username}" } ?: "Not set through Reelhouse",
                        style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
                }
                if (r.series != null) Text("From a series recording.", style = MaterialTheme.typography.bodySmall, color = Palette.TextFaint, modifier = Modifier.padding(top = 8.dp))
                Text(r.description ?: "No description.", style = MaterialTheme.typography.bodyMedium, color = Palette.TextDim, modifier = Modifier.padding(top = 12.dp))
            }
        },
        confirmButton = {
            action?.let { a -> TextButton(onClick = { onAction(a) }) { Text(a.dialogLabel(), color = Palette.Danger) } }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

private fun RecordingAction.dialogLabel(): String = when (this) {
    RecordingAction.Stop -> "Stop recording"
    RecordingAction.Cancel -> "Cancel recording"
    RecordingAction.Delete -> "Delete recording"
    RecordingAction.Skip -> "Skip this episode"
}
