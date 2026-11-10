package app.reelhouse.android.ui.common

import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.SystemClock
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.dp
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.launch

// The app on a TV box (a Fire TV Stick, Android TV), driven with a remote: where the focus starts on each screen, going
// back to what had it, and rows that keep it at their ends. On a phone none of this does anything. The highlight on what
// has the focus is the theme's (FocusRing.kt).

/** Whether this device is driven with a remote rather than a touch screen. */
val LocalRemoteDevice = staticCompositionLocalOf { false }

fun isRemoteDevice(context: Context): Boolean =
    context.getSystemService(UiModeManager::class.java)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
        !context.packageManager.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)

private const val ARROW_MOVED_FOCUS_MS = 400L
private const val KEEP_FROM_EDGE = 0.12f
private val ARROW_SCROLL = 160.dp

/**
 * How pages scroll for the focus on a remote: not until it nears their edge, keeping sight of what's next. Compose's own
 * on a TV holds the focus 30% of the way down, which on opening a film scrolled its poster and title away.
 */
@OptIn(ExperimentalFoundationApi::class)
internal object RemoteScroll : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        val margin = containerSize * KEEP_FROM_EDGE
        val end = offset + size
        return when {
            offset < margin || size > containerSize - 2 * margin -> offset - margin
            end > containerSize - margin -> end - (containerSize - margin)
            else -> 0f
        }
    }
}

private class FocusMemory(val key: () -> String?, val remember: (String) -> Unit) {
    var hadFocus = false
}

private val LocalFocusMemory = compositionLocalOf<FocusMemory?> { null }

/**
 * A screen on a remote: the first thing on it takes the focus unless a [remoteFocus] says otherwise, and coming back to
 * the screen it goes to what last had it.
 */
@Composable
fun RemoteScreen(content: @Composable () -> Unit) {
    if (!LocalRemoteDevice.current) {
        content()
        return
    }
    var remembered by rememberSaveable { mutableStateOf<String?>(null) }
    val memory = remember { FocusMemory({ remembered }, { remembered = it }) }
    val screen = remember { FocusRequester() }
    Box(Modifier.fillMaxSize().focusRequester(screen).focusGroup()) {
        CompositionLocalProvider(LocalFocusMemory provides memory, content)
    }
    LaunchedEffect(Unit) {
        repeat(3) { withFrameNanos { } } // the page's own choice first, if it has one yet
        if (!memory.hadFocus) runCatching { screen.requestFocus() }
    }
}

/**
 * Something the focus should come back to on this screen, known by [key]. With [first] it's where the focus starts
 * (asked for as soon as it appears, as a page's content may arrive after its top bar).
 */
@Composable
fun Modifier.remoteFocus(key: Any, first: Boolean = false): Modifier {
    val memory = LocalFocusMemory.current ?: return this
    val name = key.toString()
    val requester = remember { FocusRequester() }
    LaunchedEffect(name, first) {
        if (memory.key() == name || (first && memory.key() == null)) {
            withFrameNanos { }
            if (runCatching { requester.requestFocus() }.isSuccess) memory.hadFocus = true
        }
    }
    return focusRequester(requester).onFocusChanged {
        if (it.isFocused) {
            memory.hadFocus = true
            memory.remember(name)
        }
    }
}

/** Takes the focus as soon as it appears, on a remote: the first choice in a menu, or a dialog's main button. */
@Composable
fun Modifier.startFocus(): Modifier {
    if (!LocalRemoteDevice.current) return this
    val requester = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        withFrameNanos { }
        runCatching { requester.requestFocus() }
    }
    return focusRequester(requester)
}

/**
 * A row that scrolls sideways: the focus stays on its last card rather than jumping up to whatever is nearest, and coming
 * back to the row it returns to the card it left.
 */
fun Modifier.focusRow(): Modifier =
    focusProperties { onExit = { if (requestedFocusDirection == FocusDirection.Right) cancelFocusChange() } }.focusRestorer().focusGroup()

/**
 * Text in a dialog that may not fit: scrolls as usual, and on a remote, nothing in it being able to take the focus, it can
 * take it itself when there's more than fits. The arrows then scroll it, until it ends and they move on, and a bar shows
 * where you are. With [start], the focus begins here: for a dialog that's there to be read.
 */
@Composable
fun Modifier.arrowScroll(state: ScrollState, start: Boolean = false): Modifier {
    if (!LocalRemoteDevice.current) return verticalScroll(state)
    val scope = rememberCoroutineScope()
    val requester = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    val step = with(LocalDensity.current) { ARROW_SCROLL.toPx() }
    val overflows = state.maxValue > 0
    LaunchedEffect(overflows) {
        if (start && overflows) {
            withFrameNanos { }
            runCatching { requester.requestFocus() }
        }
    }
    return focusRequester(requester)
        .focusProperties { canFocus = overflows }
        .onFocusChanged { focused = it.isFocused }
        .onPreviewKeyEvent { event ->
            val by = when (event.key) {
                Key.DirectionDown -> step
                Key.DirectionUp -> -step
                else -> return@onPreviewKeyEvent false
            }
            val more = if (by > 0) state.canScrollForward else state.canScrollBackward
            if (more && event.type == KeyEventType.KeyDown) scope.launch { state.animateScrollBy(by) }
            more
        }
        .focusable()
        .drawWithContent {
            drawContent()
            if (focused && overflows) {
                val barHeight = size.height * size.height / (size.height + state.maxValue)
                val top = (size.height - barHeight) * state.value / state.maxValue
                val width = 3.dp.toPx()
                drawRoundRect(Palette.Accent, Offset(size.width - width, top), Size(width, barHeight), CornerRadius(width / 2))
            }
        }
        .verticalScroll(state)
}

/**
 * The last card of a grid (or of a section of one), where its row may be cut short: Right stays on it, rather than jumping
 * to whatever is up or down and to the right.
 */
fun Modifier.endOfRow(last: Boolean): Modifier = if (last) focusProperties { right = FocusRequester.Cancel } else this

/**
 * A text box, which on a touch screen is just that. A text box brings up the keyboard as soon as it has the focus, and on
 * a remote the keyboard takes over the screen, so moving past a box would trap you in it. So there the focus lands on
 * this instead, around the box, and OK on it opens the box. [content] puts the modifier it's given on its text box.
 * [down] is where Down goes, for a box as wide as the screen: from that, the nearest thing below is whatever is closest to
 * the screen's middle. If it isn't on screen any more, the usual search decides. A button inside the box that empties it
 * (its ✕) gets [RemoteTextBoxScope.clearButton].
 */
@Composable
fun RemoteTextBox(modifier: Modifier = Modifier, opened: Boolean = false, down: FocusRequester? = null, content: @Composable RemoteTextBoxScope.(Modifier) -> Unit) {
    if (!LocalRemoteDevice.current) {
        Box(modifier) { TouchTextBox.content(Modifier) }
        return
    }
    var open by rememberSaveable { mutableStateOf(opened) } // coming back to the screen, the focus goes where it was
    var hadFocus by remember { mutableStateOf(false) }
    var comeBack by remember { mutableStateOf(false) }
    val state = remember {
        object {
            var lastArrowAt = 0L
            var onTheBox = false // rather than a button inside it (Clear)
            var onTheFrame = false // the box while it's shut: the focus on it, not on its ✕
        }
    }
    val inner = remember { FocusRequester() }
    val outer = remember { FocusRequester() }
    val clear = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val toDown = Modifier.onPreviewKeyEvent { event ->
        val moved = down != null && event.key == Key.DirectionDown && event.type == KeyEventType.KeyDown && runCatching { down.requestFocus() }.isSuccess
        if (moved) state.lastArrowAt = SystemClock.uptimeMillis()
        moved
    }
    // The ✕ is inside the box, where moving the focus never looks from the box itself: Right goes there by hand (when
    // there is one: not with the box empty), and Left back.
    val toClear = Modifier.onPreviewKeyEvent { event ->
        state.onTheFrame && event.key == Key.DirectionRight && event.type == KeyEventType.KeyDown && runCatching { clear.requestFocus() }.isSuccess
    }
    val scope = remember {
        object : RemoteTextBoxScope {
            override fun Modifier.clearButton(): Modifier = focusRequester(clear).onPreviewKeyEvent { event ->
                when (event.key) {
                    Key.DirectionLeft -> {
                        if (event.type == KeyEventType.KeyDown) runCatching { outer.requestFocus() }
                        true
                    }
                    Key.DirectionRight -> true
                    // It goes once the box is empty, taking the focus with it: back to the box after its click.
                    Key.DirectionCenter, Key.Enter, Key.NumPadEnter -> {
                        if (event.type == KeyEventType.KeyUp) comeBack = true
                        false
                    }
                    else -> false
                }
            }
        }
    }
    Box(
        modifier.focusRequester(outer).focusProperties { canFocus = !open }.then(toDown).then(toClear)
            .onFocusChanged { state.onTheFrame = it.isFocused }.clickable { open = true },
    ) {
        scope.content(
            Modifier
                .focusProperties { canFocus = open }
                .focusRequester(inner)
                .onFocusChanged {
                    state.onTheBox = it.isFocused
                    if (it.hasFocus) {
                        hadFocus = true
                    } else if (hadFocus) { // not when it's only just been opened and is yet to get the focus
                        hadFocus = false
                        open = false
                        // Android lets go of the focus when the keyboard goes away, and it lands on the sidebar: back
                        // here, unless it was an arrow key that moved it on.
                        comeBack = SystemClock.uptimeMillis() - state.lastArrowAt > ARROW_MOVED_FOCUS_MS
                    }
                }
                .onPreviewKeyEvent { event ->
                    when (event.key) {
                        Key.DirectionCenter, Key.Enter, Key.NumPadEnter -> {
                            if (state.onTheBox && event.type == KeyEventType.KeyUp) keyboard?.show()
                            state.onTheBox
                        }
                        // The arrows move on rather than along the text in it.
                        else -> {
                            val arrow = keepFocus(event, focus)
                            if (arrow) state.lastArrowAt = SystemClock.uptimeMillis()
                            arrow
                        }
                    }
                },
        )
    }
    LaunchedEffect(open) {
        if (open) {
            withFrameNanos { }
            runCatching { inner.requestFocus() }
        }
    }
    LaunchedEffect(comeBack) {
        if (comeBack) {
            withFrameNanos { }
            runCatching { outer.requestFocus() }
            comeBack = false
        }
    }
}

/** What a [RemoteTextBox]'s content has besides its text box's modifier. */
interface RemoteTextBoxScope {
    /** For the button inside the box that empties it (its ✕), so a remote can reach it: Right from the box. */
    fun Modifier.clearButton(): Modifier
}

private object TouchTextBox : RemoteTextBoxScope {
    override fun Modifier.clearButton(): Modifier = this
}

/**
 * Pull down to refresh, on a touch screen. Not on a remote: nothing can pull, and the focus scrolling a page looks like a
 * finger doing so, bringing the indicator down. These pages follow Reelhouse's changes by themselves anyway.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RefreshBox(refreshing: Boolean, onRefresh: () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    if (LocalRemoteDevice.current) {
        Box(modifier) { content() }
    } else {
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = modifier) { content() }
    }
}

/**
 * For the whole app on a remote: an arrow key that finds nowhere to go leaves the focus where it is. Left to itself
 * Android takes the focus away, and then OK does nothing.
 */
fun keepFocus(event: KeyEvent, focus: FocusManager): Boolean {
    val direction = when (event.key) {
        Key.DirectionUp -> FocusDirection.Up
        Key.DirectionDown -> FocusDirection.Down
        Key.DirectionLeft -> FocusDirection.Left
        Key.DirectionRight -> FocusDirection.Right
        else -> return false
    }
    if (event.type == KeyEventType.KeyDown) focus.moveFocus(direction)
    return true
}
