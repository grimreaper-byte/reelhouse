package app.reelhouse.android.ui

import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DownloadForOffline
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LiveTv
import androidx.compose.material.icons.filled.Radio
import androidx.compose.material.icons.filled.Menu
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import app.reelhouse.android.ui.common.LocalRemoteDevice
import app.reelhouse.android.ui.components.WebIcons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation3.runtime.NavKey
import app.reelhouse.android.AppContainer
import app.reelhouse.android.container
import app.reelhouse.android.data.events.ServerEvent
import app.reelhouse.android.data.model.Library
import app.reelhouse.android.data.model.LiveTvAccess
import app.reelhouse.android.data.model.RequestsAccess
import app.reelhouse.android.ui.common.refreshOnServerEvents
import app.reelhouse.android.ui.components.LocalSidebarStrip
import app.reelhouse.android.ui.components.Spot
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

// The sidebar, as in the web app: Home, the libraries (in their order from Settings → Libraries), then Live TV and
// Radio (when this account may watch), Manage Recordings (when it may record), Downloads and Settings; Search is in
// Home's top bar. On a wide screen (a tablet, or a phone on its side) it's a strip of icons beside every screen but the
// player: ☰ at its top (or pointing at it with a mouse) slides the full sidebar out over the page, and its pin keeps it
// open beside the page (☰ then shrinks it to icons again; remembered). A phone held upright has no room for the strip:
// ☰ on Home opens the full sidebar as a drawer over the page.

private val RailWidth = 72.dp
private val FullWidth = 256.dp

// With a remote: no fingers to make room for, and more of the screen for the page.
private val RemoteRailWidth = 56.dp
private val RemoteFullWidth = 232.dp
private val RemoteInset = 8.dp
private val TouchInset = 12.dp
private const val WIDE_DP = 600 // Material's compact width ends here
private const val HOVER_OPEN_MS = 120L // brushing past the edge with a mouse doesn't open it

/** The back stack after picking a sidebar destination: Home, then that page (Home alone for Home). */
fun stackFor(destination: NavKey): List<NavKey> = if (destination == HomeKey) listOf(HomeKey) else listOf(HomeKey, destination)

/** Changes [stack] to [target], keeping the entries they share at the bottom (and with them their state). */
fun goTo(stack: MutableList<NavKey>, target: List<NavKey>) {
    var keep = 0
    while (keep < stack.size && keep < target.size && stack[keep] == target[keep]) keep++
    while (stack.size > keep) stack.removeAt(stack.lastIndex)
    target.drop(keep).forEach { stack.add(it) }
}

/**
 * The sidebar destination the screen on top belongs to (e.g. a film opened from Movies: Movies), else Home (Search
 * too, opened from Home's top bar).
 */
fun selectedIn(stack: List<NavKey>): NavKey =
    stack.drop(1).firstOrNull { it is LibraryKey || it is GuideKey || it == RequestsKey || it == RecordingsKey || it == DownloadsKey || it == SettingsKey } ?: HomeKey

private fun same(a: NavKey, b: NavKey) = when {
    a is LibraryKey && b is LibraryKey -> a.id == b.id
    else -> a == b
}

/** The libraries for the sidebar, kept up to date as Reelhouse reports changes (new files, a new order). */
class SidebarViewModel(private val c: AppContainer) : ViewModel() {
    private val _libraries = MutableStateFlow<List<Library>>(emptyList())
    val libraries: StateFlow<List<Library>> = _libraries.asStateFlow()

    init {
        viewModelScope.launch {
            c.connection.state.map { it.route?.baseUrl }.distinctUntilChanged().collect { base -> if (base != null) load() }
        }
        refreshOnServerEvents(c, { it is ServerEvent.LibraryChanged }) { if (c.connection.baseUrl != null) load() }
    }

    private suspend fun load() {
        try {
            _libraries.value = c.api.libraries()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("Reelhouse", "sidebar libraries: ${e.message}") // kept as they were; Home says what's wrong
        }
    }
}

/**
 * Puts the sidebar beside [content] (the screens): a strip on a wide screen, a drawer on a phone held upright, where
 * [content] is given the drawer's opener for Home's ☰. No sidebar while [hidden]
 * (the player). The screens keep one place in the layout whatever the sidebar does, so turning the phone or opening the
 * player never rebuilds them.
 */
@Composable
fun SidebarFrame(stack: MutableList<NavKey>, hidden: Boolean, content: @Composable (menu: (() -> Unit)?) -> Unit) {
    val c = LocalContext.current.container
    val vm = viewModel { SidebarViewModel(c) }
    val libraries by vm.libraries.collectAsState()
    val downloads by c.downloads.downloads.collectAsState()
    val downloadsAllowed by c.downloads.allowed.collectAsState(initial = c.downloads.isAllowed())
    val update by c.updater.available.collectAsState(initial = null)
    val profile by c.store.profile.collectAsState()
    val liveTv by c.connection.liveTv.collectAsState()
    val requests by c.connection.requests.collectAsState()
    val wide = LocalConfiguration.current.screenWidthDp >= WIDE_DP
    val strip = wide && !hidden
    val selected = selectedIn(stack)
    val scope = rememberCoroutineScope()
    val column: @Composable (expanded: Boolean, onMenu: (() -> Unit)?, onPin: (() -> Unit)?, selectedFocus: FocusRequester?, onPicked: (samePage: Boolean) -> Unit) -> Unit =
        { expanded, onMenu, onPin, selectedFocus, onPicked ->
            SidebarColumn(
                expanded = expanded,
                serverName = profile?.serverName ?: "Reelhouse",
                selected = selected,
                libraries = libraries,
                liveTv = liveTv,
                requests = requests,
                // While Reelhouse allows downloads, or there are some on the phone (they still play, whatever it says).
                showDownloads = downloads.isNotEmpty() || downloadsAllowed,
                updateWaiting = update != null,
                onMenu = onMenu,
                onPin = onPin,
                selectedFocus = selectedFocus,
                onPick = {
                    val samePage = same(selected, it)
                    goTo(stack, stackFor(it))
                    onPicked(samePage)
                },
            )
        }

    // The strip (wide screens): icons, popped out over the page by ☰ or a mouse, or pinned open beside it.
    var pinned by remember { mutableStateOf(c.prefs.sidebarPinned) }
    var popped by remember { mutableStateOf(false) }
    val hover = remember { MutableInteractionSource() }
    val hovered by hover.collectIsHoveredAsState()
    var hoverOpen by remember { mutableStateOf(false) }
    LaunchedEffect(hovered) {
        if (hovered) delay(HOVER_OPEN_MS)
        hoverOpen = hovered
    }
    // With a remote it's open while the focus is in it: the icons alone say little from across a room.
    val remote = LocalRemoteDevice.current
    var hasFocus by remember { mutableStateOf(false) }
    val page = remember { FocusRequester() }
    val selectedEntry = remember { FocusRequester() }
    val expanded = pinned || popped || hoverOpen || (remote && hasFocus)
    val rail = if (remote) RemoteRailWidth else RailWidth
    val full = if (remote) RemoteFullWidth else FullWidth
    val width by animateDpAsState(if (expanded) full else rail, label = "sidebar width")
    val beside by animateDpAsState(if (!strip) 0.dp else if (pinned) full else rail, label = "page offset")
    // A camera cutout on the left (phone on its side): the sidebar's colour reaches under it, its icons don't.
    val start = WindowInsets.safeDrawing.only(WindowInsetsSides.Start).asPaddingValues().calculateStartPadding(LocalLayoutDirection.current)

    // The drawer (a phone held upright).
    val drawer = rememberDrawerState(DrawerValue.Closed)
    // Turning the phone puts away whichever was out: the drawer, or the strip popped out over the page.
    LaunchedEffect(wide) { if (wide) drawer.snapTo(DrawerValue.Closed) else popped = false }

    ModalNavigationDrawer(
        drawerState = drawer,
        gesturesEnabled = !wide && drawer.isOpen, // swipe it shut; opening from the edge would fight the system's back swipe
        // Always there (closed, and not opened, on a wide screen): a drawer with nothing in it works out its closed
        // place as 0 wide, and turning the phone upright then showed it open.
        drawerContent = {
            // Not on a remote: nothing turns a TV upright, and closed off the side of the screen its entries could still
            // take the focus.
            if (!remote) {
                ModalDrawerSheet(
                    drawerContainerColor = Palette.Background,
                    windowInsets = WindowInsets(0, 0, 0, 0), // the sidebar keeps clear of the bars itself
                    modifier = Modifier.width(FullWidth + 24.dp),
                ) {
                    column(true, null, null, null) { scope.launch { drawer.close() } }
                }
                BackHandler(enabled = drawer.isOpen) { scope.launch { drawer.close() } }
            }
        },
    ) {
        Box(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxSize()) {
                Spacer(Modifier.width(if (strip) start + beside else 0.dp))
                Box(
                    Modifier.weight(1f).fillMaxHeight()
                        .then(if (strip) Modifier.consumeWindowInsets(WindowInsets.safeDrawing.only(WindowInsetsSides.Start)) else Modifier)
                        .then(if (remote) Modifier.focusRequester(page).focusRestorer().focusGroup() else Modifier),
                ) {
                    CompositionLocalProvider(LocalSidebarStrip provides strip) {
                        content(if (!wide && !hidden) ({ scope.launch { drawer.open() } }) else null)
                    }
                }
            }
            if (strip) {
                // Popped out over the page: a tap beside it puts it away.
                if (popped && !pinned) {
                    Box(Modifier.fillMaxSize().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { popped = false })
                }
                Surface(
                    color = Palette.Background,
                    shadowElevation = if (expanded && !pinned) 16.dp else 0.dp,
                    modifier = Modifier.fillMaxHeight().width(start + width).hoverable(hover).then(
                        if (!remote) {
                            Modifier
                        } else {
                            Modifier
                                .onFocusChanged { hasFocus = it.hasFocus }
                                .focusProperties {
                                    // Into it at the page's own entry, and out to where the page had the focus.
                                    onEnter = { runCatching { selectedEntry.requestFocus() } }
                                    onExit = { if (requestedFocusDirection == FocusDirection.Right) runCatching { page.requestFocus() } }
                                }
                                .focusGroup()
                        },
                    ),
                ) {
                    Box(Modifier.padding(start = start)) {
                        column(
                            expanded,
                            {
                                if (pinned) {
                                    pinned = false
                                    c.prefs.sidebarPinned = false
                                }
                                popped = !popped && !expanded
                            },
                            if (pinned) null else ({
                                pinned = true
                                popped = false
                                c.prefs.sidebarPinned = true
                            }),
                            selectedEntry,
                        ) { samePage ->
                            popped = false
                            // Nothing new opens, so with a remote the focus would stay in here.
                            if (remote && samePage) runCatching { page.requestFocus() }
                        }
                    }
                }
                BackHandler(enabled = popped && !pinned) { popped = false }
                // Back from the sidebar: to the page, as in the Reelhouse screens in Kodi.
                BackHandler(enabled = remote && hasFocus) { runCatching { page.requestFocus() } }
            }
        }
    }
}

@Composable
private fun SidebarColumn(
    expanded: Boolean,
    serverName: String,
    selected: NavKey,
    libraries: List<Library>,
    liveTv: LiveTvAccess,
    requests: RequestsAccess,
    showDownloads: Boolean,
    updateWaiting: Boolean,
    onMenu: (() -> Unit)?,
    onPin: (() -> Unit)?,
    selectedFocus: FocusRequester?,
    onPick: (NavKey) -> Unit,
) {
    // The entry for the page showing: where a remote comes in.
    val entry: (Boolean) -> Modifier = { lit -> if (lit && selectedFocus != null) Modifier.focusRequester(selectedFocus) else Modifier }
    // One column that scrolls when the screen is short (a phone on its side), with Live TV, Downloads and Settings at
    // its bottom whenever there's room: at least the screen's height, the space between them taken up by a spacer.
    BoxWithConstraints(Modifier.fillMaxHeight().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Vertical))) {
        Column(Modifier.verticalScroll(rememberScrollState()).heightIn(min = maxHeight).padding(horizontal = if (LocalRemoteDevice.current) RemoteInset else TouchInset, vertical = 12.dp)) {
            Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
                if (onMenu != null) {
                    IconButton(onClick = onMenu) {
                        Icon(Icons.Filled.Menu, contentDescription = if (expanded) "Shrink the sidebar to icons" else "Open the sidebar")
                    }
                } else {
                    Spacer(Modifier.width(12.dp))
                }
                Text(
                    serverName,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    softWrap = false,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).padding(start = 8.dp).alpha(if (expanded) 1f else 0f),
                )
                if (expanded && onPin != null) {
                    IconButton(onClick = onPin) { Icon(Icons.Outlined.PushPin, contentDescription = "Keep the sidebar open", tint = Palette.TextDim) }
                }
            }
            Column(Modifier.padding(top = 8.dp)) {
                NavRow(Icons.Filled.Home, "Home", same(selected, HomeKey), expanded, entry = entry(same(selected, HomeKey))) { onPick(HomeKey) }
                if (libraries.isNotEmpty()) {
                    // Kept in place when narrow, so the icons don't move as it slides out.
                    Text(
                        "LIBRARIES",
                        style = MaterialTheme.typography.labelSmall,
                        color = Palette.TextFaint,
                        letterSpacing = 1.sp,
                        maxLines = 1,
                        softWrap = false,
                        modifier = Modifier.padding(start = 12.dp, top = 16.dp, bottom = 6.dp).alpha(if (expanded) 1f else 0f),
                    )
                }
                libraries.forEach { lib ->
                    val key = LibraryKey(lib.id, lib.name)
                    val libIcon = WebIcons.library(lib)
                    NavRow(libIcon.vector, lib.name, same(selected, key), expanded, lib.count, spot = libIcon.spot, entry = entry(same(selected, key))) { onPick(key) }
                }
                // Films people asked for (when TMDB is set up to find them, or some are still listed).
                if (requests.available || requests.count > 0) {
                    NavRow(WebIcons.Request, "Requests", same(selected, RequestsKey), expanded, requests.count.takeIf { it > 0 }, entry = entry(same(selected, RequestsKey))) { onPick(RequestsKey) }
                }
            }
            Spacer(Modifier.height(16.dp))
            Spacer(Modifier.weight(1f))
            if (liveTv.available) {
                NavRow(Icons.Filled.LiveTv, "Live TV", same(selected, GuideKey(radio = false)), expanded, entry = entry(same(selected, GuideKey(radio = false)))) { onPick(GuideKey(radio = false)) }
                if (liveTv.radio) NavRow(Icons.Filled.Radio, "Radio", same(selected, GuideKey(radio = true)), expanded, entry = entry(same(selected, GuideKey(radio = true)))) { onPick(GuideKey(radio = true)) }
                // The recordings you set from the guide (accounts allowed to record).
                if (liveTv.canRecord) NavRow(Icons.Filled.FiberManualRecord, "Manage Recordings", same(selected, RecordingsKey), expanded, entry = entry(same(selected, RecordingsKey))) { onPick(RecordingsKey) }
            }
            if (showDownloads) NavRow(Icons.Filled.DownloadForOffline, "Downloads", same(selected, DownloadsKey), expanded, entry = entry(same(selected, DownloadsKey))) { onPick(DownloadsKey) }
            NavRow(Icons.Filled.Settings, if (updateWaiting) "Settings, update available" else "Settings", same(selected, SettingsKey), expanded, dot = updateWaiting, entry = entry(same(selected, SettingsKey))) {
                onPick(SettingsKey)
            }
        }
    }
}

@Composable
private fun NavRow(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    expanded: Boolean,
    count: Int? = null,
    dot: Boolean = false,
    spot: Spot? = null,
    entry: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Row(
        entry
            .fillMaxWidth()
            .height(if (LocalRemoteDevice.current) 36.dp else 44.dp) // a remote needs less room than a finger
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) Palette.Elevated2 else Palette.Background)
            .clickable(onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = label
                this.selected = selected
                role = Role.Tab
            }
            .padding(horizontal = if (LocalRemoteDevice.current) RemoteInset else TouchInset),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            Icon(icon, contentDescription = null, tint = if (selected) Palette.Accent else Palette.TextDim, modifier = Modifier.size(24.dp))
            // The recording TV's red, which stays red when the row is lit.
            if (spot != null) {
                Canvas(Modifier.size(24.dp)) {
                    val k = size.width / 24f
                    drawCircle(Palette.Danger, radius = spot.radius * k, center = Offset(spot.x * k, spot.y * k))
                }
            }
            if (dot) Box(Modifier.align(Alignment.TopEnd).size(8.dp).clip(CircleShape).background(Palette.Accent))
        }
        Text(
            label.removeSuffix(", update available"),
            color = if (selected) Palette.Text else Palette.TextDim,
            style = MaterialTheme.typography.bodyLarge,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).padding(start = 16.dp).alpha(if (expanded) 1f else 0f),
        )
        if (count != null && count > 0 && expanded) Text("$count", color = Palette.TextFaint, style = MaterialTheme.typography.labelMedium)
    }
}
