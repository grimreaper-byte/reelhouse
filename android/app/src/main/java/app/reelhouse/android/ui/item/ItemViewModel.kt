package app.reelhouse.android.ui.item

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.reelhouse.android.AppContainer
import app.reelhouse.android.data.events.ServerEvent
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.data.model.ItemDetails
import app.reelhouse.android.data.model.Related
import app.reelhouse.android.ui.common.Loadable
import app.reelhouse.android.ui.common.errorText
import app.reelhouse.android.ui.common.refreshOnServerEvents
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class ItemViewModel(private val c: AppContainer, val id: Long) : ViewModel() {
    private val _details = MutableStateFlow(Loadable<ItemDetails>())
    val details: StateFlow<Loadable<ItemDetails>> = _details.asStateFlow()
    private val _related = MutableStateFlow<Related?>(null)
    val related: StateFlow<Related?> = _related.asStateFlow()
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    /** Items whose watched mark is being changed right now. */
    private val _busy = MutableStateFlow<Set<Long>>(emptySet())
    val busy: StateFlow<Set<Long>> = _busy.asStateFlow()

    init {
        load()
        refreshOnServerEvents(c, { e ->
            e is ServerEvent.StateChanged ||
                (e is ServerEvent.LibraryChanged && (e.libraryId == null || e.libraryId == _details.value.data?.item?.libraryId))
        }) { fetch(withRelated = false) }
    }

    fun load() {
        _details.update { it.copy(loading = true, error = null) }
        viewModelScope.launch { fetch(withRelated = true) }
    }

    private suspend fun fetch(withRelated: Boolean) {
        try {
            var d = c.api.item(id)
            // One of a film's other copies (e.g. a download from before an HD copy arrived): the film's page.
            d.item.versionOf?.let { d = c.api.item(it) }
            _details.value = Loadable(d, loading = false)
            if (withRelated && (d.item.type == "movie" || d.item.type == "show")) {
                runCatching { _related.value = c.api.related(d.item.id) }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _details.update { it.copy(loading = false, error = c.errorText(e)) }
        }
    }

    /** Marks [target] (this item, or an episode or season on its page) watched or unwatched. */
    fun setWatched(target: Item, watched: Boolean) {
        if (target.id in _busy.value) return
        _busy.update { it + target.id }
        viewModelScope.launch {
            try {
                c.api.setWatched(target.id, watched)
                fetch(withRelated = false)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _message.value = c.errorText(e)
            } finally {
                _busy.update { it - target.id }
            }
        }
    }

    fun messageShown() {
        _message.value = null
    }
}

/** Watched for a movie or episode; everything watched for a show or season. */
val Item.isWatched: Boolean
    get() = if (type == "show" || type == "season") (leafCount ?: 0) > 0 && (viewedLeafCount ?: 0) >= (leafCount ?: 0) else state.watched
