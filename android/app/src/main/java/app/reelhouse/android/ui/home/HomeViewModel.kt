package app.reelhouse.android.ui.home

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.reelhouse.android.AppContainer
import app.reelhouse.android.data.api.ApiException
import app.reelhouse.android.data.model.Hub
import app.reelhouse.android.ui.common.refreshOnServerEvents
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

private const val TAG = "Reelhouse"

class HomeViewModel(private val c: AppContainer) : ViewModel() {
    data class Ui(
        val loaded: Boolean = false,
        val refreshing: Boolean = false,
        val hubs: List<Hub> = emptyList(),
        val error: String? = null,
    )

    private val _ui = MutableStateFlow(Ui())
    val ui: StateFlow<Ui> = _ui.asStateFlow()

    init {
        // Load when a route appears, and again when it changes (e.g. home → tunnel).
        viewModelScope.launch {
            c.connection.state.map { it.route?.baseUrl }.distinctUntilChanged().collect { base -> if (base != null) load() }
        }
        // New files, metadata, and watching on another device change what Home shows.
        refreshOnServerEvents(c) { if (c.connection.baseUrl != null) load() }
    }

    fun refresh() {
        if (c.connection.baseUrl == null) {
            c.connection.reconnect()
            return
        }
        viewModelScope.launch { load(refreshing = true) }
    }

    private suspend fun load(refreshing: Boolean = false) {
        _ui.update { it.copy(refreshing = refreshing) }
        try {
            val home = c.api.home()
            _ui.value = Ui(loaded = true, hubs = home.hubs)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            Log.w(TAG, "home: ${e.status} ${e.message}")
            _ui.update { it.copy(refreshing = false, error = e.message) }
        } catch (e: IOException) {
            Log.w(TAG, "home: can't reach Reelhouse", e)
            _ui.update { it.copy(refreshing = false, error = "Reelhouse couldn't be reached") }
            c.connection.reconnect() // the route may have gone away
        } catch (e: Exception) {
            Log.e(TAG, "home failed", e)
            _ui.update { it.copy(refreshing = false, error = e.message ?: e.javaClass.simpleName) }
        }
    }
}
