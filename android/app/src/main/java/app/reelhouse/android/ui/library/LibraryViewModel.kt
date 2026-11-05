package app.reelhouse.android.ui.library

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.reelhouse.android.AppContainer
import app.reelhouse.android.data.events.ServerEvent
import app.reelhouse.android.data.model.Genre
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.ui.common.Loadable
import app.reelhouse.android.ui.common.errorText
import app.reelhouse.android.ui.common.refreshOnServerEvents
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The sorts the server offers, each with the direction it usually reads best in. */
enum class Sort(val key: String, val label: String, val descending: Boolean) {
    Title("title", "Title", false),
    Added("added", "Date added", true),
    Year("year", "Year", true),
    Released("released", "Release date", true),
    Rating("rating", "Rating", true),
    Duration("duration", "Duration", false),
}

enum class Filter(val key: String?, val label: String) {
    All(null, "All"),
    Unwatched("unwatched", "Unwatched"),
    InProgress("inprogress", "In progress"),
    Watched("watched", "Watched"),
}

class LibraryViewModel(private val c: AppContainer, val libraryId: Long) : ViewModel() {
    data class Options(val sort: Sort = Sort.Title, val descending: Boolean = false, val filter: Filter = Filter.All, val genre: String? = null)

    private val _items = MutableStateFlow(Loadable<List<Item>>())
    val items: StateFlow<Loadable<List<Item>>> = _items.asStateFlow()
    private val _options = MutableStateFlow(Options())
    val options: StateFlow<Options> = _options.asStateFlow()
    private val _genres = MutableStateFlow<List<Genre>>(emptyList())
    val genres: StateFlow<List<Genre>> = _genres.asStateFlow()
    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()
    private var loadJob: Job? = null

    init {
        load()
        viewModelScope.launch { runCatching { _genres.value = c.api.genres(libraryId) } }
        refreshOnServerEvents(c, { it is ServerEvent.StateChanged || (it is ServerEvent.LibraryChanged && (it.libraryId == null || it.libraryId == libraryId)) }) { fetch() }
    }

    fun setOptions(o: Options) {
        if (o == _options.value) return
        _options.value = o
        _items.update { it.copy(loading = true) }
        load()
    }

    fun refresh() {
        _refreshing.value = true
        load()
    }

    fun load() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch { fetch() }
    }

    private suspend fun fetch() {
        val o = _options.value
        try {
            val res = c.api.libraryItems(libraryId, o.sort.key, o.descending, o.filter.key, o.genre)
            _items.value = Loadable(res.items, loading = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _items.update { it.copy(loading = false, error = c.errorText(e)) }
        } finally {
            _refreshing.value = false
        }
    }
}
