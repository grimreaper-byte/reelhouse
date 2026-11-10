package app.reelhouse.android.ui.search

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import app.reelhouse.android.AppContainer
import app.reelhouse.android.container
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.data.model.SearchResults
import app.reelhouse.android.ui.common.CenteredMessage
import app.reelhouse.android.ui.common.Loading
import app.reelhouse.android.ui.common.LocalRemoteDevice
import app.reelhouse.android.ui.common.RemoteTextBox
import app.reelhouse.android.ui.common.errorText
import app.reelhouse.android.ui.common.focusRow
import app.reelhouse.android.ui.common.remoteFocus
import app.reelhouse.android.ui.components.LandscapeCard
import app.reelhouse.android.ui.components.PosterCard
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

class SearchViewModel(private val c: AppContainer, initial: String) : ViewModel() {
    sealed interface Results {
        data object Idle : Results
        data object Searching : Results
        data class Done(val query: String, val results: SearchResults) : Results
        data class Failed(val message: String) : Results
    }

    private val _query = MutableStateFlow(initial)
    val query: StateFlow<String> = _query.asStateFlow()
    private val _results = MutableStateFlow<Results>(Results.Idle)
    val results: StateFlow<Results> = _results.asStateFlow()

    init {
        @OptIn(FlowPreview::class)
        viewModelScope.launch {
            _query.map { it.trim() }.distinctUntilChanged().debounce(300).collectLatest { q ->
                if (q.isEmpty()) {
                    _results.value = Results.Idle
                    return@collectLatest
                }
                _results.value = Results.Searching
                _results.value = try {
                    Results.Done(q, c.api.search(q))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Results.Failed(c.errorText(e))
                }
            }
        }
    }

    fun setQuery(q: String) {
        _query.value = q
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(initial: String, onOpenItem: (Item) -> Unit, onBack: () -> Unit) {
    val c = LocalContext.current.container
    val vm = viewModel { SearchViewModel(c, initial) }
    val query by vm.query.collectAsState()
    val results by vm.results.collectAsState()
    val focus = remember { FocusRequester() }
    val firstResult = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val remote = LocalRemoteDevice.current
    LaunchedEffect(Unit) { if (initial.isEmpty() && !remote) focus.requestFocus() }

    val statusRow = statusRowBar()
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    // Opened straight away, on a remote too: typing is what this screen is for.
                    RemoteTextBox(Modifier.fillMaxWidth(), opened = initial.isEmpty(), down = firstResult.takeIf { (results as? SearchViewModel.Results.Done)?.results?.isEmpty == false }) { box ->
                    TextField(
                        value = query,
                        onValueChange = vm::setQuery,
                        placeholder = { Text("Search movies, shows, people") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
                        trailingIcon = {
                            if (query.isNotEmpty()) IconButton(onClick = { vm.setQuery("") }, modifier = Modifier.clearButton()) { Icon(Icons.Filled.Close, contentDescription = "Clear") }
                        },
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent,
                            unfocusedContainerColor = Color.Transparent,
                            focusedIndicatorColor = Color.Transparent,
                            unfocusedIndicatorColor = Color.Transparent,
                        ),
                        modifier = Modifier.fillMaxWidth().focusRequester(focus).then(box),
                    )
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                expandedHeight = statusRow.height,
                windowInsets = statusRow.insets,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.Background),
            )
        },
    ) { padding ->
        val modifier = Modifier.fillMaxSize().padding(padding)
        when (val r = results) {
            SearchViewModel.Results.Idle -> CenteredMessage("Search your libraries by title, actor or director.", modifier)
            SearchViewModel.Results.Searching -> Loading(modifier = modifier)
            is SearchViewModel.Results.Failed -> CenteredMessage(r.message, modifier)
            is SearchViewModel.Results.Done ->
                if (r.results.isEmpty) {
                    CenteredMessage("Nothing found for “${r.query}”.", modifier)
                } else {
                    LazyColumn(modifier, contentPadding = PaddingValues(bottom = 24.dp)) {
                        val found = r.results
                        section("Movies", found.movies, onOpenItem, first = firstResult)
                        section("Shows", found.shows, onOpenItem, first = firstResult.takeIf { found.movies.isEmpty() })
                        section("Episodes", found.episodes, onOpenItem, landscape = true, first = firstResult.takeIf { found.movies.isEmpty() && found.shows.isEmpty() })
                        section("With “${r.query}” in the cast or crew", found.people, onOpenItem, first = firstResult.takeIf { found.movies.isEmpty() && found.shows.isEmpty() && found.episodes.isEmpty() })
                    }
                }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.section(title: String, list: List<Item>, onOpen: (Item) -> Unit, landscape: Boolean = false, first: FocusRequester? = null) {
    if (list.isEmpty()) return
    item(key = title) {
        Column {
            Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 10.dp))
            LazyRow(Modifier.focusRow(), contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                items(list, key = { it.id }) { item ->
                    val focus = Modifier.remoteFocus("$title/${item.id}").then(if (first != null && item == list.first()) Modifier.focusRequester(first) else Modifier)
                    if (landscape) LandscapeCard(item, onClick = { onOpen(item) }, modifier = focus) else PosterCard(item, onClick = { onOpen(item) }, modifier = focus)
                }
            }
        }
    }
}
