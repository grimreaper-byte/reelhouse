package app.reelhouse.android.ui.requests

import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import app.reelhouse.android.AppContainer
import app.reelhouse.android.container
import app.reelhouse.android.data.events.ServerEvent
import app.reelhouse.android.data.model.FilmRequest
import app.reelhouse.android.data.model.FilmResult
import app.reelhouse.android.data.model.RequestsResponse
import app.reelhouse.android.ui.common.Loadable
import app.reelhouse.android.ui.common.LoadableContent
import app.reelhouse.android.ui.common.errorText
import app.reelhouse.android.ui.common.refreshOnServerEvents
import app.reelhouse.android.ui.components.AvatarCircle
import app.reelhouse.android.ui.components.RemoteImage
import app.reelhouse.android.ui.components.WebIcons
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

// Requests, as in the web app (web/js/views/requests.js): find a film on TMDB to ask for (one on the server opens
// instead; one someone asked for says who), and under it every request, newest first, with who asked and when. You
// can remove your own; an admin any (asked first), or all. The list follows other people's changes as they happen.

class RequestsViewModel(private val c: AppContainer) : ViewModel() {
    sealed interface Search {
        data object Idle : Search
        data object Searching : Search
        data class Done(val query: String, val films: List<FilmResult>) : Search
        data class Failed(val query: String, val message: String) : Search
    }

    private val _list = MutableStateFlow(Loadable<RequestsResponse>())
    val list: StateFlow<Loadable<RequestsResponse>> = _list.asStateFlow()
    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()
    private val _search = MutableStateFlow<Search>(Search.Idle)
    val search: StateFlow<Search> = _search.asStateFlow()
    /** Films being asked for (TMDB ids) and requests being removed (ids). */
    private val _asking = MutableStateFlow<Set<Long>>(emptySet())
    val asking: StateFlow<Set<Long>> = _asking.asStateFlow()
    private val _removing = MutableStateFlow<Set<Long>>(emptySet())
    val removing: StateFlow<Set<Long>> = _removing.asStateFlow()
    /** One-off notes for the snackbar. */
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    init {
        load()
        @OptIn(FlowPreview::class)
        viewModelScope.launch {
            _query.map { it.trim() }.distinctUntilChanged().debounce(400).collectLatest { runSearch(it, quiet = false) }
        }
        refreshOnServerEvents(c, { it is ServerEvent.RequestsChanged }) { reload() }
    }

    fun load() {
        viewModelScope.launch {
            _list.value = Loadable()
            reload()
        }
    }

    fun setQuery(q: String) {
        _query.value = q
    }

    /** The list again, and the search's "Asked for by …" marks with it. */
    private suspend fun reload() {
        try {
            _list.value = Loadable(c.api.requests(), loading = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (_list.value.data == null) _list.value = Loadable(loading = false, error = c.errorText(e))
        }
        (_search.value as? Search.Done)?.let { runSearch(it.query, quiet = true) }
    }

    private suspend fun runSearch(q: String, quiet: Boolean) {
        if (q.isEmpty()) {
            _search.value = Search.Idle
            return
        }
        if (!quiet) _search.value = Search.Searching
        try {
            _search.value = Search.Done(q, c.api.searchFilms(q))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (!quiet) _search.value = Search.Failed(q, c.errorText(e))
        }
    }

    fun ask(film: FilmResult) {
        viewModelScope.launch {
            _asking.value += film.tmdbId
            try {
                c.api.addRequest(film.tmdbId)
                _messages.emit("Requested “${film.title}”")
                reload()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _messages.emit(c.errorText(e))
            } finally {
                _asking.value -= film.tmdbId
            }
        }
    }

    fun remove(request: FilmRequest) {
        viewModelScope.launch {
            _removing.value += request.id
            try {
                c.api.removeRequest(request.id)
                _messages.emit("Removed the request for “${request.title}”")
                reload()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _messages.emit(c.errorText(e))
            } finally {
                _removing.value -= request.id
            }
        }
    }

    fun removeAll() {
        viewModelScope.launch {
            try {
                c.api.removeAllRequests()
                _messages.emit("Removed all requests")
                reload()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _messages.emit(c.errorText(e))
            }
        }
    }
}

private sealed interface Confirm {
    data class One(val request: FilmRequest) : Confirm
    data object All : Confirm
}

private val PosterShape = RoundedCornerShape(6.dp)
private val PosterWidth = 170.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestsScreen(onOpenItem: (Long) -> Unit, onBack: () -> Unit) {
    val c = LocalContext.current.container
    val vm = viewModel { RequestsViewModel(c) }
    val list by vm.list.collectAsState()
    val query by vm.query.collectAsState()
    val search by vm.search.collectAsState()
    val asking by vm.asking.collectAsState()
    val removing by vm.removing.collectAsState()
    val profile by c.store.profile.collectAsState()
    val me = profile?.user
    val snackbar = remember { SnackbarHostState() }
    var confirm by remember { mutableStateOf<Confirm?>(null) }
    LaunchedEffect(vm) { vm.messages.collect { snackbar.showSnackbar(it) } }

    val statusRow = statusRowBar()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Requests") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                actions = {
                    if (me?.isAdmin == true && list.data?.requests?.isNotEmpty() == true) {
                        IconButton(onClick = { confirm = Confirm.All }) { Icon(Icons.Filled.DeleteSweep, contentDescription = "Remove all requests") }
                    }
                },
                expandedHeight = statusRow.height,
                windowInsets = statusRow.insets,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.Background),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        LoadableContent(list, onRetry = vm::load, modifier = Modifier.fillMaxSize().padding(padding)) { data ->
            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 104.dp),
                contentPadding = PaddingValues(16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                modifier = Modifier.fillMaxSize().padding(padding),
            ) {
                if (data.available) {
                    wide { SearchField(query, vm::setQuery) }
                    searchResults(search, asking, onAsk = vm::ask, onOpen = onOpenItem)
                } else {
                    wide {
                        Text(
                            if (me?.isAdmin == true) "Requests need a TMDB API key: add one in Reelhouse's Settings → Metadata (in a browser)."
                            else "Requests need a TMDB API key, which an admin can add in Reelhouse's Settings.",
                            color = Palette.TextDim,
                        )
                    }
                }
                wide { SectionTitle(if (data.requests.isEmpty()) "Requested" else "Requested (${data.requests.size})") }
                if (data.requests.isEmpty()) {
                    wide { Text(if (data.available) "Nothing requested yet. Search for a movie above to ask for it." else "Nothing requested yet.", color = Palette.TextDim) }
                } else {
                    items(data.requests, key = { "r${it.id}" }) { r ->
                        RequestCard(r, removing = r.id in removing) {
                            if (removalNeedsConfirming(r, me?.id)) confirm = Confirm.One(r) else vm.remove(r)
                        }
                    }
                }
            }
        }
    }

    when (val ask = confirm) {
        is Confirm.One -> AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("Remove this request?") },
            text = { Text("${ask.request.user.username} asked for “${ask.request.title}”.") },
            confirmButton = { TextButton(onClick = { confirm = null; vm.remove(ask.request) }) { Text("Remove", color = Palette.Danger) } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } },
        )
        Confirm.All -> {
            val requests = list.data?.requests.orEmpty()
            AlertDialog(
                onDismissRequest = { confirm = null },
                title = { Text("Remove all requests?") },
                text = {
                    Text(
                        if (requests.size == 1) "The request for “${requests[0].title}” will be removed."
                        else "All ${requests.size} requests, everyone’s, will be removed.",
                    )
                },
                confirmButton = { TextButton(onClick = { confirm = null; vm.removeAll() }) { Text("Remove all", color = Palette.Danger) } },
                dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } },
            )
        }
        null -> Unit
    }
}

/** An item as wide as the grid. */
private fun LazyGridScope.wide(content: @Composable () -> Unit) {
    item(span = { GridItemSpan(maxLineSpan) }) { content() }
}

private fun LazyGridScope.searchResults(search: RequestsViewModel.Search, asking: Set<Long>, onAsk: (FilmResult) -> Unit, onOpen: (Long) -> Unit) {
    when (search) {
        RequestsViewModel.Search.Idle -> Unit
        RequestsViewModel.Search.Searching -> wide {
            Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        }
        is RequestsViewModel.Search.Failed -> wide { Text(search.message, color = Palette.TextDim) }
        is RequestsViewModel.Search.Done -> {
            wide { SectionTitle("Results for “${search.query}”") }
            if (search.films.isEmpty()) {
                wide { Text("TMDB has no film by that name. Try another spelling, or add the year (e.g. “Heat 1995”).", color = Palette.TextDim) }
            } else {
                items(search.films, key = { "f${it.tmdbId}" }) { film -> FilmCard(film, film.tmdbId in asking, onAsk, onOpen) }
            }
            wide { Spacer(Modifier.height(8.dp)) }
        }
    }
}

@Composable
private fun SearchField(query: String, onChange: (String) -> Unit) {
    val keyboard = LocalSoftwareKeyboardController.current
    Column {
        Text("Ask for a movie that isn’t on the server. When it turns up in a library you can open, its request goes by itself.", color = Palette.TextDim)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = query,
            onValueChange = onChange,
            placeholder = { Text("Find a movie to request") },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { onChange("") }) { Icon(Icons.Filled.Close, contentDescription = "Clear") } },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
}

/** A film's poster, or a film strip and its title when it has none. */
@Composable
private fun Poster(path: String?, title: String) {
    Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).clip(PosterShape).background(Palette.Elevated2), contentAlignment = Alignment.Center) {
        if (path != null) {
            RemoteImage(path, PosterWidth, null, Modifier.fillMaxSize())
        } else {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(8.dp)) {
                Icon(WebIcons.Film, contentDescription = null, tint = Palette.TextFaint, modifier = Modifier.size(28.dp))
                Spacer(Modifier.height(6.dp))
                Text(title, style = MaterialTheme.typography.bodySmall, color = Palette.TextFaint, textAlign = TextAlign.Center, maxLines = 3)
            }
        }
    }
}

@Composable
private fun TitleAndYear(title: String, year: Int?) {
    Text(title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
    Text(year?.toString() ?: "", style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, maxLines = 1)
}

@Composable
private fun FilmCard(film: FilmResult, asking: Boolean, onAsk: (FilmResult) -> Unit, onOpen: (Long) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Poster(film.poster, film.title)
        TitleAndYear(film.title, film.year)
        Spacer(Modifier.height(6.dp))
        val small = PaddingValues(horizontal = 10.dp, vertical = 0.dp)
        when (val action = filmAction(film)) {
            is FilmAction.Open -> OutlinedButton(onClick = { onOpen(action.itemId) }, contentPadding = small, modifier = Modifier.height(32.dp)) {
                Text("On the server", style = MaterialTheme.typography.labelMedium, maxLines = 1)
            }
            is FilmAction.AskedFor -> Text(action.label, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, color = Palette.Accent)
            FilmAction.Ask -> Button(
                onClick = { onAsk(film) },
                enabled = !asking,
                contentPadding = small,
                colors = ButtonDefaults.buttonColors(containerColor = Palette.Accent, contentColor = Palette.AccentText),
                modifier = Modifier.height(32.dp),
            ) {
                Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("Request", style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

@Composable
private fun RequestCard(request: FilmRequest, removing: Boolean, onRemove: () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Box {
            Poster(request.poster, request.title)
            if (request.canRemove) {
                // A small dark circle in the corner; the button around it keeps a full-size touch target.
                IconButton(onClick = onRemove, enabled = !removing, modifier = Modifier.align(Alignment.TopEnd)) {
                    Box(Modifier.size(30.dp).background(Color.Black.copy(alpha = 0.65f), CircleShape), contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Close, contentDescription = "Remove the request for ${request.title}", tint = Color.White, modifier = Modifier.size(18.dp))
                    }
                }
            }
        }
        TitleAndYear(request.title, request.year)
        // Who asked (a long name can't push the day out of sight: it has its own line).
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
            AvatarCircle(request.user, 18)
            Spacer(Modifier.width(6.dp))
            Text(request.user.username, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(requestedDay(request), style = MaterialTheme.typography.bodySmall, color = Palette.TextFaint, maxLines = 1, modifier = Modifier.padding(top = 2.dp))
    }
}
