package app.reelhouse.android.ui.item

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.NavigateBefore
import androidx.compose.material.icons.automirrored.filled.NavigateNext
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
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
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import app.reelhouse.android.container
import app.reelhouse.android.data.model.CastMember
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.data.model.ItemDetails
import app.reelhouse.android.data.model.MediaInfo
import app.reelhouse.android.data.model.Related
import app.reelhouse.android.data.model.Version
import app.reelhouse.android.ui.common.LoadableContent
import app.reelhouse.android.ui.common.formatDuration
import app.reelhouse.android.ui.common.formatPosition
import app.reelhouse.android.ui.common.formatSize
import app.reelhouse.android.ui.player.channelsLabel
import app.reelhouse.android.ui.player.languageName
import app.reelhouse.android.ui.player.resumePoint
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import app.reelhouse.android.ui.components.LandscapeCard
import app.reelhouse.android.ui.components.PosterCard
import app.reelhouse.android.ui.components.RemoteImage
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.downloads.DownloadButton
import app.reelhouse.android.ui.downloads.SeasonDownloadButton
import androidx.compose.material.icons.filled.DownloadDone
import app.reelhouse.android.ui.theme.Palette

/** Where the item page can lead. */
class ItemNav(
    val open: (Long) -> Unit,
    /** Plays an item from a position in seconds; -1 resumes where it was left. */
    val play: (Long, Double) -> Unit,
    /** A cast member's page, with the movie or show they were picked from. */
    val person: (String, Long) -> Unit,
    val back: () -> Unit,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ItemScreen(id: Long, nav: ItemNav) {
    val c = LocalContext.current.container
    val vm = viewModel(key = "item-$id") { ItemViewModel(c, id) }
    val details by vm.details.collectAsState()
    val related by vm.related.collectAsState()
    val busy by vm.busy.collectAsState()
    val message by vm.message.collectAsState()
    val downloads by c.downloads.downloads.collectAsState()
    val downloaded = downloads.filter { it.done }.map { it.itemId }.toSet()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(message) {
        message?.let {
            snackbar.showSnackbar(it)
            vm.messageShown()
        }
    }

    // The artwork stays still behind the page, as in the web app, and the page scrolls over it, starting just under
    // the top bar: dimmed behind it, and darker all over as the page is scrolled, so what comes up stays readable.
    // The server offers a backdrop address even when it may have nothing to show; then there's none.
    val backdrop = details.data?.let { backdropOf(it) }
    var backdropFailed by remember(backdrop) { mutableStateOf(false) }
    val art = backdrop != null && !backdropFailed
    val window = LocalWindowInfo.current.containerSize
    // Fully darkened once the page has scrolled 40% of the window's height.
    val dimPx = window.height * 40 / 100
    val list = rememberLazyListState()
    val dim by remember(dimPx) {
        derivedStateOf {
            when {
                list.firstVisibleItemIndex > 0 -> 1f
                else -> (list.firstVisibleItemScrollOffset / dimPx.toFloat()).coerceIn(0f, 1f)
            }
        }
    }
    // The top bar is clear over the artwork and turns solid once the page has scrolled.
    val bar = TopAppBarDefaults.pinnedScrollBehavior()
    var menuOpen by remember { mutableStateOf(false) }
    var pickingVersion by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize().background(Palette.Background)) {
        if (art) Backdrop(backdrop!!, dim, onError = { backdropFailed = true })
        val statusRow = statusRowBar()
        Scaffold(
            modifier = Modifier.nestedScroll(bar.nestedScrollConnection),
            containerColor = Color.Transparent,
            topBar = {
                TopAppBar(
                    title = { Text(details.data?.let { titleFor(it) } ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    navigationIcon = { IconButton(onClick = nav.back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                    actions = {
                        // A film with more than one copy (SD and HD, say): pick which one to play.
                        if ((details.data?.item?.versions?.size ?: 0) > 1) {
                            Box {
                                IconButton(onClick = { menuOpen = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More") }
                                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                    DropdownMenuItem(
                                        text = { Text("Play version…") },
                                        leadingIcon = { Icon(Icons.Filled.PlayArrow, contentDescription = null) },
                                        onClick = {
                                            menuOpen = false
                                            pickingVersion = true
                                        },
                                    )
                                }
                            }
                        }
                    },
                    expandedHeight = statusRow.height,
                    windowInsets = statusRow.insets,
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent, scrolledContainerColor = Palette.Background),
                    scrollBehavior = bar,
                )
            },
            snackbarHost = { SnackbarHost(snackbar) },
        ) { padding ->
            LoadableContent(details, onRetry = vm::load, modifier = Modifier.padding(padding)) { d ->
                LazyColumn(Modifier.fillMaxSize().padding(padding), state = list, contentPadding = PaddingValues(bottom = 32.dp)) {
                    item(key = "header") {
                        Header(d, nav, watchedBusy = d.item.id in busy, onWatched = { vm.setWatched(d.item, it) })
                    }
                    when (d.item.type) {
                        "show" -> showSections(d, related, nav)
                        "season" -> seasonSections(d, busy, downloaded, nav, vm::setWatched)
                        "episode" -> episodeSections(d, nav)
                        else -> movieSections(d, related, nav)
                    }
                }
            }
        }
        if (pickingVersion) details.data?.let { VersionsDialog(it.item, nav, onDismiss = { pickingVersion = false }) }
    }
}

/** A film's copies (SD and HD, say), best first: play or resume any of them. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun VersionsDialog(item: Item, nav: ItemNav, onDismiss: () -> Unit) {
    val resume = resumePoint(item)
    val play = { id: Long, from: Double ->
        onDismiss()
        nav.play(id, from)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Play version") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                item.versions.forEachIndexed { i, v ->
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(v.label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                            if (i == 0) Text("Plays by default", style = MaterialTheme.typography.labelMedium, color = Palette.Accent)
                        }
                        Text(versionDetails(v), style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (resume > 0) {
                                Button(onClick = { play(v.id, resume) }) { Text("Resume from ${formatPosition(resume)}") }
                                OutlinedButton(onClick = { play(v.id, 0.0) }) { Text("From the start") }
                            } else {
                                Button(onClick = { play(v.id, 0.0) }) {
                                    Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Text("Play")
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

/** A copy's picture, sound, file type, size and bitrate on one line. */
internal fun versionDetails(v: Version): String = listOfNotNull(
    if (v.width != null && v.height != null) "${v.width}×${v.height}" else null,
    v.videoCodec?.uppercase(),
    v.audioCodec?.uppercase(),
    v.container?.uppercase(),
    v.fileSize?.let(::formatSize),
    v.bitrate?.let { "%.1f Mbps".format(it / 1e6) },
).joinToString(" · ")

/** The picture quality badges: one per copy of a film with more than one (SD and 1080p, say), best first. */
internal fun qualityLabels(item: Item): List<String> =
    if (item.versions.isNotEmpty()) item.versions.map { it.label }.distinct() else listOfNotNull(item.videoResolution)

/** The artwork behind an item's page: an episode's own picture, a season's show's, else the item's backdrop. */
private fun backdropOf(d: ItemDetails): String? = when (d.item.type) {
    "episode" -> d.item.images.thumb ?: d.item.images.backdrop
    "season" -> d.show?.images?.backdrop ?: d.item.images.backdrop
    else -> d.item.images.backdrop
}

/**
 * The artwork filling the page behind it, from its top (cropped to the screen's shape: on a phone held upright, the
 * middle of a wide picture). Shaded over half behind the poster and title, so they read over it, and darker towards
 * the bottom; [dim] (0 → 1, as the page scrolls) darkens it all.
 */
@Composable
private fun Backdrop(path: String, dim: Float, onError: () -> Unit) {
    val window = LocalWindowInfo.current.containerSize
    // Wide enough to cover the window's height at 16:9.
    val width = with(LocalDensity.current) { maxOf(window.width, window.height * 16 / 9).toDp() }
    val bg = Palette.Background
    Box(Modifier.fillMaxSize()) {
        RemoteImage(path, width, null, Modifier.fillMaxSize(), onError = onError, alignment = Alignment.TopCenter, placeholder = bg)
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    0f to bg.copy(alpha = 0.65f),
                    0.12f to bg.copy(alpha = 0.55f),
                    0.4f to bg.copy(alpha = 0.65f),
                    0.65f to bg.copy(alpha = 0.88f),
                    1f to bg,
                ),
            ),
        )
        Box(Modifier.fillMaxSize().background(bg.copy(alpha = 0.75f * dim)))
    }
}

private fun titleFor(d: ItemDetails) = when (d.item.type) {
    "season" -> d.show?.title ?: d.item.title
    "episode" -> d.show?.title ?: d.item.title
    else -> d.item.title
}

// ---------- header ----------

/** The poster, title, buttons and overview, at the top of the page. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Header(d: ItemDetails, nav: ItemNav, watchedBusy: Boolean, onWatched: (Boolean) -> Unit) {
    val item = d.item
    Column {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            if (item.type != "episode") {
                Box(Modifier.width(104.dp).aspectRatio(2f / 3f).clip(RoundedCornerShape(6.dp))) {
                    RemoteImage(item.images.poster, 104.dp, null, Modifier.fillMaxSize())
                }
            }
            Column(Modifier.weight(1f)) {
                if (item.type == "episode" || item.type == "season") {
                    d.show?.let { show ->
                        Text(
                            show.title,
                            style = MaterialTheme.typography.titleSmall,
                            color = Palette.Accent,
                            modifier = Modifier.clickable { nav.open(show.id) },
                        )
                    }
                }
                Text(item.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                val meta = metaLine(d)
                val qualities = qualityLabels(item)
                if (meta.isNotEmpty() || qualities.isNotEmpty()) {
                    Spacer(Modifier.height(4.dp))
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                        itemVerticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (meta.isNotEmpty()) Text(meta, style = MaterialTheme.typography.bodyMedium, color = Palette.TextDim)
                        qualities.forEach { QualityBadge(it) }
                    }
                }
                if (item.genres.isNotEmpty()) {
                    Text(item.genres.take(4).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = Palette.TextFaint)
                }
            }
        }
        FlowRow(
            Modifier.padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            PlayButtons(d, nav)
            val watched = item.isWatched
            FilledTonalButton(onClick = { onWatched(!watched) }, enabled = !watchedBusy) {
                Icon(if (watched) Icons.Filled.CheckCircle else Icons.Outlined.CheckCircle, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(if (watched) "Watched" else "Mark watched")
            }
            if (item.type == "season") SeasonDownloadButton(d.children, d.show?.title, d.show?.id)
            else DownloadButton(item, d.show?.title, d.show?.id)
            remaining(item)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim) }
        }
        item.tagline?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, fontStyle = FontStyle.Italic, color = Palette.TextDim, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp))
        }
        item.overview?.takeIf { it.isNotBlank() }?.let { Overview(it) }
    }
}

/** Play or resume a movie or episode; on a show or season, play the next episode to watch. */
@Composable
private fun PlayButtons(d: ItemDetails, nav: ItemNav) {
    val item = d.item
    if (item.type == "movie" || item.type == "episode") {
        val resume = resumePoint(item)
        if (resume > 0) {
            Button(onClick = { nav.play(item.id, resume) }) {
                Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Resume from ${formatPosition(resume)}")
            }
            OutlinedButton(onClick = { nav.play(item.id, 0.0) }) { Text("From the start") }
        } else {
            Button(onClick = { nav.play(item.id, 0.0) }) {
                Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Play")
            }
        }
    } else {
        d.onDeck?.let { next ->
            Button(onClick = { nav.play(next.id, -1.0) }) {
                Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Play ${next.episodeLabel ?: next.title}")
            }
        }
    }
}

private fun metaLine(d: ItemDetails): String {
    val i = d.item
    return buildList {
        when (i.type) {
            "episode" -> {
                i.episodeLabel?.let(::add)
                i.airDate?.let(::add)
            }
            "season" -> i.leafCount?.let { add(if (it == 1) "1 episode" else "$it episodes") }
            "show" -> {
                i.year?.let { add(it.toString()) }
                i.childCount?.let { add(if (it == 1) "1 season" else "$it seasons") }
            }
            else -> i.year?.let { add(it.toString()) }
        }
        if (i.type == "movie" || i.type == "episode") formatDuration(i.duration)?.let(::add)
        i.contentRating?.let(::add)
        i.rating?.takeIf { it > 0 }?.let { add("★ %.1f".format(it)) }
    }.joinToString(" · ")
}

/** A quality (SD, 1080p…) in a small box, as on the web app's pages. */
@Composable
private fun QualityBadge(label: String) {
    Text(
        label,
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Bold,
        color = Palette.TextDim,
        modifier = Modifier.border(1.dp, Palette.TextFaint, RoundedCornerShape(3.dp)).padding(horizontal = 5.dp, vertical = 1.dp),
    )
}

private fun remaining(i: Item): String? {
    val d = i.duration ?: return null
    if (i.progress <= 0f) return null
    return formatDuration(d - i.state.position)?.let { "$it left" }
}

@Composable
private fun Overview(text: String) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        maxLines = if (expanded) Int.MAX_VALUE else 4,
        overflow = TextOverflow.Ellipsis,
        // A readable line length on tablets.
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp).widthIn(max = 720.dp).animateContentSize().clickable { expanded = !expanded },
    )
}

// ---------- sections per type ----------

private fun LazyListScope.showSections(d: ItemDetails, related: Related?, nav: ItemNav) {
    d.onDeck?.let { next ->
        item(key = "ondeck") {
            SectionTitle("Up next")
            LandscapeCard(next, onClick = { nav.open(next.id) }, modifier = Modifier.padding(horizontal = 16.dp))
        }
    }
    if (d.children.isNotEmpty()) item(key = "seasons") { PosterRow("Seasons", d.children, nav) }
    castSection(d.item.cast, d.item.id, nav)
    relatedSections(related, nav)
}

private fun LazyListScope.seasonSections(d: ItemDetails, busy: Set<Long>, downloaded: Set<Long>, nav: ItemNav, onWatched: (Item, Boolean) -> Unit) {
    if (d.seasons.size > 1) {
        item(key = "season-picker") {
            LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(d.seasons, key = { it.id }) { s ->
                    FilterChip(selected = s.id == d.item.id, onClick = { if (s.id != d.item.id) nav.open(s.id) }, label = { Text(s.title) })
                }
            }
        }
    }
    item(key = "episodes-title") { SectionTitle("Episodes") }
    items(d.children, key = { "ep-${it.id}" }) { ep ->
        EpisodeRow(ep, busy = ep.id in busy, downloaded = ep.id in downloaded, onClick = { nav.open(ep.id) }, onWatched = { onWatched(ep, it) })
    }
}

private fun LazyListScope.episodeSections(d: ItemDetails, nav: ItemNav) {
    if (d.prev != null || d.next != null) {
        item(key = "prevnext") {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 16.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                d.prev?.let { p ->
                    OutlinedButton(onClick = { nav.open(p.id) }) {
                        Icon(Icons.AutoMirrored.Filled.NavigateBefore, contentDescription = null)
                        Text(p.episodeLabel ?: "Previous")
                    }
                } ?: Spacer(Modifier.width(1.dp))
                d.next?.let { n ->
                    OutlinedButton(onClick = { nav.open(n.id) }) {
                        Text(n.episodeLabel ?: "Next")
                        Icon(Icons.AutoMirrored.Filled.NavigateNext, contentDescription = null)
                    }
                }
            }
        }
    }
    d.season?.let { season ->
        item(key = "season-link") {
            Text(
                "All episodes of ${season.title}",
                color = Palette.Accent,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 16.dp).clickable { nav.open(season.id) },
            )
        }
    }
    mediaSection(d.item.media)
}

private fun LazyListScope.movieSections(d: ItemDetails, related: Related?, nav: ItemNav) {
    val i = d.item
    if (i.directors.isNotEmpty() || i.studio != null) {
        item(key = "credits") {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                if (i.directors.isNotEmpty()) Labelled("Directed by", i.directors.joinToString(", "))
                i.studio?.let { Labelled("Studio", it) }
            }
        }
    }
    castSection(i.cast, i.id, nav)
    mediaSection(i.media, i.versions)
    relatedSections(related, nav)
}

private fun LazyListScope.castSection(cast: List<CastMember>, fromItem: Long, nav: ItemNav) {
    if (cast.isEmpty()) return
    item(key = "cast") {
        SectionTitle("Cast")
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            items(cast.take(30)) { person -> CastCard(person, onClick = { nav.person(person.name, fromItem) }) }
        }
    }
}

private fun LazyListScope.relatedSections(related: Related?, nav: ItemNav) {
    if (related == null) return
    if (related.similar.isNotEmpty()) item(key = "similar") { PosterRow("More like this", related.similar, nav) }
    related.byCast.forEach { row -> item(key = "with-${row.name}") { PosterRow("More with ${row.name}", row.items, nav) } }
}

/** The file's details; a film with more than one copy lists each (best first: the one Play plays). */
private fun LazyListScope.mediaSection(media: MediaInfo?, versions: List<Version> = emptyList()) {
    if (versions.size > 1) {
        item(key = "media") {
            SectionTitle("Files")
            versions.forEachIndexed { i, v ->
                Text(
                    if (i == 0) "${v.label} · plays by default" else v.label,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = if (i == 0) 0.dp else 14.dp, bottom = 4.dp),
                )
                v.media?.let { FileDetails(it) }
            }
        }
        return
    }
    if (media == null) return
    item(key = "media") {
        SectionTitle("File")
        FileDetails(media)
    }
}

@Composable
private fun FileDetails(media: MediaInfo) {
    Column(Modifier.padding(horizontal = 16.dp)) {
        media.video?.let { v ->
            Labelled(
                "Video",
                listOfNotNull(
                    v.codec?.uppercase(),
                    if (v.width != null && v.height != null) "${v.width}×${v.height}" else null,
                    v.bitDepth?.takeIf { it > 8 }?.let { "$it-bit" },
                    v.hdr?.uppercase(),
                ).joinToString(" · "),
            )
        }
        if (media.audio.isNotEmpty()) {
            Labelled("Audio", media.audio.joinToString("\n") { a ->
                listOfNotNull(languageName(a.language), a.codec?.uppercase(), a.channels?.let(::channelsLabel), a.title).joinToString(" · ")
            })
        }
        val subs = media.subtitles + media.external
        if (subs.isNotEmpty()) {
            Labelled("Subtitles", subs.joinToString(", ") { s -> listOfNotNull(languageName(s.language) ?: "Unknown", s.title).joinToString(" ") })
        }
        Labelled(
            "Container",
            listOfNotNull(
                media.container?.uppercase(),
                media.fileSize?.let(::formatSize),
                media.bitrate?.let { "%.1f Mbps".format(it / 1e6) },
            ).joinToString(" · "),
        )
    }
}


// ---------- pieces ----------

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 22.dp, bottom = 10.dp))
}

@Composable
private fun Labelled(label: String, value: String) {
    if (value.isBlank()) return
    Row(Modifier.padding(vertical = 3.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, modifier = Modifier.width(96.dp))
        Text(value, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun PosterRow(title: String, items: List<Item>, nav: ItemNav) {
    Column {
        SectionTitle(title)
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            items(items, key = { it.id }) { item -> PosterCard(item, onClick = { nav.open(item.id) }) }
        }
    }
}

@Composable
private fun CastCard(person: CastMember, onClick: () -> Unit) {
    Column(Modifier.width(92.dp).clickable(onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).clip(RoundedCornerShape(6.dp)).background(Palette.Elevated2), contentAlignment = Alignment.Center) {
            if (person.profile != null) {
                RemoteImage(person.profile, 92.dp, null, Modifier.fillMaxSize())
            } else {
                Text(initials(person.name), style = MaterialTheme.typography.titleLarge, color = Palette.TextFaint)
            }
        }
        Text(person.name, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
        person.role?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Palette.TextDim, maxLines = 2, overflow = TextOverflow.Ellipsis) }
    }
}

private fun initials(name: String) = name.split(' ').filter { it.isNotEmpty() }.take(2).joinToString("") { it.take(1).uppercase() }

@Composable
private fun EpisodeRow(ep: Item, busy: Boolean, downloaded: Boolean, onClick: () -> Unit, onWatched: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.width(132.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(6.dp))) {
            RemoteImage(ep.images.thumb ?: ep.images.poster, 132.dp, null, Modifier.fillMaxSize())
            if (ep.progress > 0f) {
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Palette.Background.copy(alpha = 0.7f))) {
                    Box(Modifier.fillMaxWidth(ep.progress).height(3.dp).background(Palette.Accent))
                }
            }
        }
        Column(Modifier.weight(1f)) {
            Text(
                listOfNotNull(ep.episodeNumber?.let { "$it." }, ep.title).joinToString(" "),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (downloaded) {
                    Icon(Icons.Filled.DownloadDone, contentDescription = "Downloaded", tint = Palette.Accent, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(4.dp))
                }
                Text(listOfNotNull(formatDuration(ep.duration), ep.airDate).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
            }
            ep.overview?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextFaint, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        IconButton(onClick = { onWatched(!ep.state.watched) }, enabled = !busy, modifier = Modifier.size(36.dp)) {
            if (ep.state.watched) {
                Box(Modifier.size(22.dp).clip(CircleShape).background(Palette.Accent), contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Check, contentDescription = "Watched — mark unwatched", tint = Palette.AccentText, modifier = Modifier.size(16.dp))
                }
            } else {
                Icon(Icons.Outlined.CheckCircle, contentDescription = "Mark watched", tint = Palette.TextFaint)
            }
        }
    }
}
