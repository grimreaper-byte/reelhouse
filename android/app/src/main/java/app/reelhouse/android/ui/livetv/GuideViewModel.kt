package app.reelhouse.android.ui.livetv

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.reelhouse.android.AppContainer
import app.reelhouse.android.data.events.ServerEvent
import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.data.model.GuideResponse
import app.reelhouse.android.data.model.Programme
import app.reelhouse.android.ui.common.errorText
import app.reelhouse.android.ui.common.refreshOnServerEvents
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

fun epochNow() = System.currentTimeMillis() / 1000

/**
 * Live TV's guide, or Radio's ([radio]): the hours on screen (a day's, from [Ui.from]), more as the grid is scrolled
 * on, read again every minute while it's shown and after recording something.
 */
class GuideViewModel(private val c: AppContainer, val radio: Boolean) : ViewModel() {
    data class Ui(
        val loaded: Boolean = false,
        val error: String? = null,
        /** 0 = today (from just before now), 1 = tomorrow… */
        val day: Int = 0,
        val from: Long = 0,
        val to: Long = 0,
        val now: Long = epochNow(),
        val channels: List<Channel> = emptyList(),
        val events: List<Programme> = emptyList(),
        val canRecord: Boolean = false,
        val canRecordSeries: Boolean = false,
        /** A day's guide was just loaded: the grid goes back to its start. */
        val generation: Int = 0,
        /** Something to say briefly ("“News” will be recorded"), or a failure. */
        val message: String? = null,
    ) {
        val rows: List<GuideRow> get() = guideRows(channels, events)
    }

    private val _ui = MutableStateFlow(Ui())
    val ui: StateFlow<Ui> = _ui.asStateFlow()
    private var loadJob: Job? = null
    private var moreJob: Job? = null

    init {
        viewModelScope.launch {
            c.connection.state.map { it.route?.baseUrl }.distinctUntilChanged().collect { base -> if (base != null) reload() }
        }
        // Live TV turned off, or this account's switches changed.
        refreshOnServerEvents(c, { it is ServerEvent.LiveTvChanged }) { reload() }
    }

    /** TV channels, or radio stations. */
    private fun keep(g: GuideResponse) = g.copy(channels = g.channels.filter { it.radio == radio })

    fun pickDay(day: Int) {
        val now = epochNow()
        val from = if (day == 0) todayStart(now) else startOfDay(day, now)
        load(day, from, from + CHUNK, fresh = true)
    }

    /**
     * The same hours again (every minute, after recording, when the connection changes). Today's guide moves on with
     * the time ([followNow]); past midnight, the day picked keeps its date ([dayNow]).
     */
    fun reload() {
        val u = _ui.value
        if (!u.loaded) return pickDay(0)
        val now = epochNow()
        val day = dayNow(u.day, u.now, now)
        val moved = if (day == 0) followNow(u.from, u.to, now) else null
        load(day, moved?.first ?: u.from, moved?.second ?: u.to, fresh = false)
    }

    private fun load(day: Int, from: Long, to: Long, fresh: Boolean) {
        if (c.connection.baseUrl == null) return
        moreJob?.cancel()
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            try {
                val g = keep(c.api.guide(from, to))
                _ui.update {
                    it.copy(
                        loaded = true, error = null, day = day, from = g.from, to = maxOf(g.to, to), now = g.now,
                        channels = g.channels, events = g.events, canRecord = g.canRecord, canRecordSeries = g.canRecordSeries,
                        generation = if (fresh) it.generation + 1 else it.generation,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val text = c.errorText(e)
                // A guide on screen stays (the next minute tries again; another day says it couldn't); with nothing
                // yet, say why.
                _ui.update { if (!it.loaded) it.copy(error = text) else if (fresh) it.copy(message = text) else it }
            }
        }
    }

    /** The next hours, once the grid is scrolled near its end (up to a day and an hour from the day's start). */
    fun loadMore() {
        val u = _ui.value
        val dayStart = if (u.day == 0) todayStart(u.now) else startOfDay(u.day, u.now)
        if (!u.loaded || moreJob?.isActive == true || loadJob?.isActive == true || !canLoadMore(u.to, dayStart)) return
        moreJob = viewModelScope.launch {
            try {
                val more = keep(c.api.guide(u.to, u.to + CHUNK))
                _ui.update { if (it.to != u.to) it else it.copy(to = u.to + CHUNK, events = mergeEvents(it.events, more.events)) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The grid just ends there for now; scrolling again tries again.
            }
        }
    }

    fun record(p: Programme, action: RecordAction) {
        viewModelScope.launch {
            try {
                val dvr = p.dvr
                when (action) {
                    RecordAction.Record -> c.api.record(p.id)
                    RecordAction.Cancel, RecordAction.Skip -> c.api.changeRecording(dvr!!.uuid, "cancel")
                    RecordAction.Restore -> c.api.changeRecording(dvr!!.uuid, "record")
                    RecordAction.Stop -> c.api.changeRecording(dvr!!.uuid, "stop")
                }
                say(
                    when (action) {
                        RecordAction.Record, RecordAction.Restore -> "“${p.title}” will be recorded"
                        RecordAction.Cancel -> "Recording cancelled"
                        RecordAction.Skip -> "Episode skipped"
                        RecordAction.Stop -> "Recording stopped"
                    },
                )
                reload()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(c.errorText(e))
            }
        }
    }

    /** Record series, or (after asking) Cancel series recording, for a programme. */
    fun series(p: Programme, action: SeriesAction, channelName: String?) {
        viewModelScope.launch {
            try {
                when (action) {
                    SeriesAction.Record -> {
                        val on = channelName ?: "this channel"
                        say(
                            if (c.api.recordSeries(p.id).already) "You already have a series recording of “${showName(p.title)}” on $on"
                            else "Every episode of “${showName(p.title)}” on $on will be recorded",
                        )
                    }
                    SeriesAction.Cancel -> {
                        c.api.cancelSeries(p.dvr!!.series!!)
                        say("Series recording cancelled")
                    }
                }
                reload()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(c.errorText(e))
            }
        }
    }

    private fun say(text: String) = _ui.update { it.copy(message = text) }

    fun messageShown() = _ui.update { it.copy(message = null) }
}
