package app.reelhouse.android.ui.person

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import app.reelhouse.android.AppContainer
import app.reelhouse.android.container
import app.reelhouse.android.data.events.ServerEvent
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.data.model.OtherMovie
import app.reelhouse.android.data.model.PersonInfo
import app.reelhouse.android.data.model.PersonPage
import app.reelhouse.android.ui.common.Loadable
import app.reelhouse.android.ui.common.LoadableContent
import app.reelhouse.android.ui.common.endOfRow
import app.reelhouse.android.ui.common.errorText
import app.reelhouse.android.ui.common.refreshOnServerEvents
import app.reelhouse.android.ui.common.remoteFocus
import app.reelhouse.android.ui.components.PosterCard
import app.reelhouse.android.ui.components.RemoteImage
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.theme.Palette
import app.reelhouse.android.ui.theme.TextRing
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class PersonViewModel(private val c: AppContainer, private val name: String, private val fromItem: Long?) : ViewModel() {
    private val _page = MutableStateFlow(Loadable<PersonPage>())
    val page: StateFlow<Loadable<PersonPage>> = _page.asStateFlow()

    init {
        load()
        // Watched marks and new titles show up without leaving the page.
        refreshOnServerEvents(c, { it is ServerEvent.StateChanged || it is ServerEvent.LibraryChanged }) { fetch() }
    }

    fun load() {
        _page.update { it.copy(loading = true, error = null) }
        viewModelScope.launch { fetch() }
    }

    private suspend fun fetch() {
        try {
            _page.value = Loadable(c.api.person(name, fromItem), loading = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _page.update { it.copy(loading = false, error = c.errorText(e)) }
        }
    }
}

/** A cast member: their titles on the server, then the movies they've been in that aren't on it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PersonScreen(name: String, fromItem: Long?, onOpenItem: (Item) -> Unit, onBack: () -> Unit) {
    val c = LocalContext.current.container
    val vm = viewModel(key = "person-$name-$fromItem") { PersonViewModel(c, name, fromItem) }
    val page by vm.page.collectAsState()
    val grid = rememberLazyGridState()
    val scope = rememberCoroutineScope()

    val statusRow = statusRowBar()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                // With a remote, the picture and facts at the top can't take the focus: this is how to get back to them.
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.onFocusEvent { if (it.isFocused) scope.launch { grid.animateScrollToItem(0) } }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                expandedHeight = statusRow.height,
                windowInsets = statusRow.insets,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.Background),
            )
        },
    ) { padding ->
        LoadableContent(page, onRetry = vm::load, modifier = Modifier.padding(padding)) { p ->
            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 104.dp),
                state = grid,
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                modifier = Modifier.fillMaxSize().padding(padding),
            ) {
                wide("header") { Header(p) }
                wide("here-title") { SectionTitle("On this server") }
                if (p.items.isEmpty()) {
                    wide("here-none") { Note("Nothing with ${p.name} is on this server.") }
                } else {
                    itemsIndexed(p.items, key = { _, item -> item.id }) { n, item ->
                        PosterCard(item, modifier = Modifier.remoteFocus(item.id, first = n == 0).endOfRow(n == p.items.lastIndex), onClick = { onOpenItem(item) }, fill = true, subtitle = partLine(item.year, item.role, item.directed))
                    }
                }
                otherMovies(p)
            }
        }
    }
}

/** A grid entry as wide as the grid. */
private fun LazyGridScope.wide(key: String, content: @Composable () -> Unit) =
    item(key = key, span = { GridItemSpan(maxLineSpan) }) { content() }

private fun partLine(year: Int?, role: String?, directed: Boolean = false) =
    listOfNotNull(year?.toString(), role?.let { "as $it" } ?: if (directed) "Director" else null).joinToString(" · ")

private fun LazyGridScope.otherMovies(p: PersonPage) {
    val others = p.others.items
    val note = when (p.others.status) {
        "ok" -> if (others.isEmpty()) "Every movie TMDB lists for ${p.name} is on this server." else null
        "failed" -> "Their other movies couldn’t be loaded from TMDB just now."
        "unknown" -> "TMDB has no movies listed for ${p.name}."
        else -> "Their other movies are listed once the server has a TMDB API key (Settings → Metadata)."
    }
    wide("others-title") { SectionTitle(if (others.isEmpty()) "Not on this server" else "Not on this server · ${others.size}") }
    if (note != null) {
        wide("others-note") { Note(note) }
        return
    }
    // tmdbId is unique per movie: the server makes one entry of someone's parts in the same movie.
    items(others, key = { "tmdb-${it.tmdbId}" }, span = { GridItemSpan(maxLineSpan) }) { OtherMovieRow(it) }
}

/** The photo, with the name level with its top and what's known about them underneath; then the biography. */
@Composable
private fun Header(p: PersonPage) {
    Column(Modifier.padding(top = 8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Top) {
            var photoFailed by remember(p.profile) { mutableStateOf(false) }
            Box(
                Modifier.width(104.dp).aspectRatio(2f / 3f).clip(RoundedCornerShape(8.dp)).background(Palette.Elevated2),
                contentAlignment = Alignment.Center,
            ) {
                if (p.profile != null && !photoFailed) {
                    RemoteImage(p.profile, 104.dp, null, Modifier.fillMaxSize(), onError = { photoFailed = true })
                } else {
                    Text(initials(p.name), style = MaterialTheme.typography.headlineSmall, color = Palette.TextFaint)
                }
            }
            Column(Modifier.weight(1f)) {
                // No extra space above the name: the text starts where the photo does.
                Text(
                    p.name,
                    style = MaterialTheme.typography.headlineSmall.copy(lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Top, LineHeightStyle.Trim.FirstLineTop)),
                    fontWeight = FontWeight.SemiBold,
                )
                val others = p.others.items.size
                Text(
                    listOfNotNull(hereLine(p.items), if (others > 0) "$others more movie${if (others == 1) "" else "s"}" else null).joinToString(" · "),
                    style = MaterialTheme.typography.bodyMedium,
                    color = Palette.TextDim,
                    modifier = Modifier.padding(top = 4.dp),
                )
                p.info?.let(::factLines)?.takeIf { it.isNotEmpty() }?.let { lines ->
                    Text(lines.joinToString("\n"), style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, modifier = Modifier.padding(top = 10.dp))
                }
            }
        }
        p.info?.biography?.let { Biography(it) }
    }
}

/** "2 movies on this server", "1 movie and 1 show on this server", "No movies on this server". */
internal fun hereLine(items: List<Item>): String {
    val movies = items.count { it.type == "movie" }
    val shows = items.size - movies
    val parts = listOfNotNull(
        movies.takeIf { it > 0 }?.let { "$it movie${if (it == 1) "" else "s"}" },
        shows.takeIf { it > 0 }?.let { "$it show${if (it == 1) "" else "s"}" },
    )
    return if (parts.isEmpty()) "No movies on this server" else parts.joinToString(" and ") + " on this server"
}

/** "Born 30 May 1971 (age 55)", "in Queens, New York, USA", "Died …" — whatever TMDB knows. */
internal fun factLines(info: PersonInfo, locale: Locale = Locale.getDefault()): List<String> = buildList {
    val age = info.age
    info.birthday?.let { add("Born ${day(it, locale)}" + if (age != null && info.deathday == null) " (age $age)" else "") }
    info.birthplace?.let { add(if (info.birthday != null) "in $it" else "Born in $it") }
    info.deathday?.let { add("Died ${day(it, locale)}" + if (age != null) " (aged $age)" else "") }
}

private fun day(iso: String, locale: Locale): String =
    runCatching { LocalDate.parse(iso).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale)) }.getOrDefault(iso)

@Composable
private fun Biography(text: String) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    var cut by remember { mutableStateOf(false) }
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        maxLines = if (expanded) Int.MAX_VALUE else 5,
        overflow = TextOverflow.Ellipsis,
        onTextLayout = { if (!expanded) cut = it.hasVisualOverflow },
        // A readable line length on tablets; a tap shows the rest, if there's any.
        modifier = Modifier.padding(top = 16.dp).widthIn(max = 720.dp).animateContentSize()
            .then(if (cut || expanded) Modifier.clickable(null, TextRing) { expanded = !expanded } else Modifier),
    )
}

@Composable
private fun OtherMovieRow(m: OtherMovie) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        var posterFailed by remember(m.poster) { mutableStateOf(false) }
        Box(
            Modifier.width(46.dp).aspectRatio(2f / 3f).clip(RoundedCornerShape(4.dp)).background(Palette.Elevated2),
            contentAlignment = Alignment.Center,
        ) {
            if (m.poster != null && !posterFailed) {
                RemoteImage(m.poster, 46.dp, null, Modifier.fillMaxSize(), onError = { posterFailed = true })
            } else {
                Icon(Icons.Outlined.Movie, contentDescription = null, tint = Palette.TextFaint, modifier = Modifier.size(18.dp))
            }
        }
        Column(Modifier.weight(1f)) {
            Text(m.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            partLine(m.year, m.role).takeIf { it.isNotEmpty() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 14.dp))
}

@Composable
private fun Note(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = Palette.TextDim)
}

private fun initials(name: String) = name.split(' ').filter { it.isNotEmpty() }.take(2).joinToString("") { it.take(1).uppercase() }
