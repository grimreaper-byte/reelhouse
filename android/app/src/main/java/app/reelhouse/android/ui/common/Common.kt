package app.reelhouse.android.ui.common

import android.util.Log
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.reelhouse.android.AppContainer
import app.reelhouse.android.data.api.ApiException
import app.reelhouse.android.data.events.ServerEvent
import app.reelhouse.android.ui.components.Button
import app.reelhouse.android.ui.components.OutlinedButton
import app.reelhouse.android.ui.theme.Palette
import java.io.IOException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch

/** What a screen shows while it loads data: the data once there, and why not if it failed. */
data class Loadable<T>(val data: T? = null, val loading: Boolean = true, val error: String? = null)

/** A message for people from a failed request. A network failure also makes the app look for a route again. */
fun AppContainer.errorText(e: Throwable): String = when (e) {
    is ApiException -> e.message ?: "Reelhouse answered ${e.status}"
    is IOException -> {
        Log.w("Reelhouse", "request failed", e)
        connection.reconnect()
        "Reelhouse couldn't be reached"
    }
    else -> {
        Log.e("Reelhouse", "request failed", e)
        e.message ?: e.javaClass.simpleName
    }
}

/** Calls [refresh] when the server reports a change that [matters] (a few events in a row make one refresh). */
@OptIn(FlowPreview::class)
fun ViewModel.refreshOnServerEvents(c: AppContainer, matters: (ServerEvent) -> Boolean = { true }, refresh: suspend () -> Unit) {
    viewModelScope.launch {
        c.live.events.filter { it is ServerEvent.Resync || matters(it) }.debounce(700).collect { refresh() }
    }
}

@Composable
fun CenteredMessage(
    text: String,
    modifier: Modifier = Modifier,
    action: String? = null,
    onAction: () -> Unit = {},
    secondAction: String? = null,
    onSecondAction: () -> Unit = {},
) {
    Column(modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(text, textAlign = TextAlign.Center, color = Palette.TextDim, modifier = Modifier.fillMaxWidth())
        if (action != null) {
            Spacer(Modifier.height(16.dp))
            Button(onClick = onAction) { Text(action) }
        }
        if (secondAction != null) {
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onSecondAction) { Text(secondAction) }
        }
    }
}

@Composable
fun Loading(text: String? = null, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        CircularProgressIndicator()
        if (text != null) {
            Spacer(Modifier.height(12.dp))
            Text(text, color = Palette.TextDim)
        }
    }
}

/** Shows [content] once there's data, a spinner before, and the error with a retry button if loading failed. */
@Composable
fun <T> LoadableContent(state: Loadable<T>, onRetry: () -> Unit, modifier: Modifier = Modifier, content: @Composable (T) -> Unit) {
    val data = state.data
    when {
        data != null -> content(data)
        state.error != null -> CenteredMessage(state.error, modifier, action = "Try again", onAction = onRetry)
        else -> Loading(modifier = modifier)
    }
}

/** "1 h 52 min", "45 min"; never "0 min" for something that isn't over. */
fun formatDuration(seconds: Double?): String? {
    val s = seconds ?: return null
    if (s <= 0) return null
    val minutes = maxOf(1, Math.round(s / 60.0).toInt())
    return if (minutes >= 60) "${minutes / 60} h ${minutes % 60} min" else "$minutes min"
}

/** "just now", "12 min ago", "3 hr ago", "yesterday", "5 days ago" (as the web app says it). */
fun timeAgo(ms: Long, now: Long = System.currentTimeMillis()): String {
    val s = (now - ms) / 1000
    return when {
        s < 60 -> "just now"
        s < 3600 -> "${s / 60} min ago"
        s < 86400 -> "${s / 3600} hr ago"
        s < 2 * 86400 -> "yesterday"
        else -> "${s / 86400} days ago"
    }
}

/** "4.2 GB", "350 MB". */
fun formatSize(bytes: Long): String = if (bytes >= 1_000_000_000) "%.1f GB".format(bytes / 1e9) else "${maxOf(1, Math.round(bytes / 1e6))} MB"

/** "Resume from 12:34" style position. */
fun formatPosition(seconds: Double): String {
    val total = seconds.toLong()
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}
