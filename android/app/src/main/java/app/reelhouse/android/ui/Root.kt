package app.reelhouse.android.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import android.widget.Toast
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavEntryDecorator
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import app.reelhouse.android.container
import app.reelhouse.android.ui.common.LocalRemoteDevice
import app.reelhouse.android.ui.common.RemoteScreen
import app.reelhouse.android.ui.common.RemoteScroll
import app.reelhouse.android.ui.common.isRemoteDevice
import app.reelhouse.android.ui.common.keepFocus
import app.reelhouse.android.ui.downloads.DownloadsScreen
import app.reelhouse.android.ui.home.HomeNav
import app.reelhouse.android.ui.home.HomeScreen
import app.reelhouse.android.ui.item.ItemNav
import app.reelhouse.android.ui.item.ItemScreen
import app.reelhouse.android.ui.library.LibraryScreen
import app.reelhouse.android.ui.livetv.GuideScreen
import app.reelhouse.android.ui.livetv.LivePlayerScreen
import app.reelhouse.android.ui.pair.PairScreen
import app.reelhouse.android.ui.pair.PairTvScreen
import app.reelhouse.android.ui.person.PersonScreen
import app.reelhouse.android.ui.player.PlayerScreen
import app.reelhouse.android.ui.player.resumePoint
import app.reelhouse.android.ui.remote.MiniController
import app.reelhouse.android.ui.remote.RemoteControlScreen
import app.reelhouse.android.ui.recordings.RecordingSeriesScreen
import app.reelhouse.android.ui.recordings.RecordingShowScreen
import app.reelhouse.android.ui.recordings.RecordingsScreen
import app.reelhouse.android.ui.requests.RequestsScreen
import app.reelhouse.android.ui.search.SearchScreen
import app.reelhouse.android.ui.settings.LicencesScreen
import app.reelhouse.android.ui.settings.SettingsScreen
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable data object HomeKey : NavKey
@Serializable data object SettingsKey : NavKey
@Serializable data object LicencesKey : NavKey

/** Settings → Pair a TV; [link]: a TV's reelhouse://pair-tv code already scanned with the camera app. */
@Serializable data class PairTvKey(val link: String? = null) : NavKey
@Serializable data object DownloadsKey : NavKey
@Serializable data object RequestsKey : NavKey
@Serializable data object RecordingsKey : NavKey
/** A show's recordings; [everyone]: from an admin's everyone's view. */
@Serializable data class RecordingShowKey(val key: String, val title: String, val everyone: Boolean = false) : NavKey
/** One series of a show's recordings ([season] null: those without a series number). */
@Serializable data class RecordingSeriesKey(val key: String, val title: String, val season: Int?, val everyone: Boolean = false) : NavKey
@Serializable data class LibraryKey(val id: Long, val name: String) : NavKey
@Serializable data class ItemKey(val id: Long) : NavKey
@Serializable data class SearchKey(val query: String = "") : NavKey

/** Live TV's guide, or Radio's. */
@Serializable data class GuideKey(val radio: Boolean = false) : NavKey

/** Watching a channel (or listening to a station) from the guide. */
@Serializable data class LiveKey(val channel: String, val radio: Boolean = false) : NavKey

/** A cast member's page; [fromItem] is the movie or show they were picked from. */
@Serializable data class PersonKey(val name: String, val fromItem: Long? = null) : NavKey

/** [startAt] in seconds; -1 resumes where the item was left. */
@Serializable data class PlayerKey(val itemId: Long, val startAt: Double = -1.0) : NavKey

/** The phone remote: what plays on another device, and its buttons. */
@Serializable data object RemoteControlKey : NavKey

/** Pairing until there's a server, then the app. */
@Composable
fun ReelhouseRoot() {
    val c = LocalContext.current.container
    val profile by c.store.profile.collectAsState()
    val context = LocalContext.current
    val remote = remember { isRemoteDevice(context) }
    val focus = LocalFocusManager.current
    @OptIn(ExperimentalFoundationApi::class)
    val scrolling = if (remote) RemoteScroll else LocalBringIntoViewSpec.current
    @OptIn(ExperimentalFoundationApi::class)
    CompositionLocalProvider(LocalRemoteDevice provides remote, LocalBringIntoViewSpec provides scrolling) {
        Box(if (remote) Modifier.fillMaxSize().onKeyEvent { keepFocus(it, focus) } else Modifier.fillMaxSize()) {
            if (profile == null) RemoteScreen { PairScreen() } else SignedIn()
        }
    }
}

@Composable
private fun SignedIn() {
    val c = LocalContext.current.container
    val backStack = rememberNavBackStack(HomeKey)
    val back: () -> Unit = { backStack.removeLastOrNull() }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val openRemote: () -> Unit = { if (backStack.lastOrNull() != RemoteControlKey) backStack.add(RemoteControlKey) }
    // Play on this phone, or on the device the phone remote plays on (from where it was left: -1).
    val play: (Long, Double) -> Unit = { id, at ->
        if (c.remote.active.value != null) {
            scope.launch {
                val start = if (at >= 0) at else runCatching { resumePoint(c.api.item(id).item) }.getOrDefault(0.0)
                c.remote.play(id, start)
            }
            openRemote()
        } else {
            backStack.add(PlayerKey(id, at))
        }
    }
    // A channel or station: here, or on the device the phone remote plays on.
    val watch: (String, Boolean) -> Unit = { uuid, radio ->
        if (c.remote.active.value != null) {
            c.remote.playChannel(uuid)
            openRemote()
        } else {
            backStack.add(LiveKey(uuid, radio))
        }
    }
    val itemNav = ItemNav(
        open = { id -> backStack.add(ItemKey(id)) },
        play = play,
        person = { name, fromItem -> backStack.add(PersonKey(name, fromItem)) },
        back = back,
        remote = openRemote,
    )

    // A phone's commands for this device (the phone remote, when it may be controlled): a play opens the player
    // (instead of one that's open); Stop leaves it; the rest go to the player on screen.
    LaunchedEffect(Unit) {
        c.remoteReceiver.commands.collect { cmd ->
            val top = backStack.lastOrNull()
            when {
                cmd.type == "play" && cmd.itemId != null -> {
                    if (top is PlayerKey || top is LiveKey) backStack.removeAt(backStack.lastIndex)
                    backStack.add(PlayerKey(cmd.itemId, cmd.start ?: 0.0))
                    cmd.from?.let { Toast.makeText(context, "Playing from $it", Toast.LENGTH_SHORT).show() }
                    c.remoteReceiver.done(cmd)
                }
                cmd.type == "play" && cmd.channel != null -> {
                    // Channel up/down (zap) in the channel player open; else this channel's player, in place of one open.
                    val live = c.remoteReceiver.player.takeIf { top is LiveKey }
                    if (cmd.zap && live != null) {
                        c.remoteReceiver.done(cmd, live(cmd))
                    } else {
                        if (top is PlayerKey || top is LiveKey) backStack.removeAt(backStack.lastIndex)
                        backStack.add(LiveKey(cmd.channel, cmd.radio))
                        if (!cmd.zap) cmd.from?.let { Toast.makeText(context, "Playing from $it", Toast.LENGTH_SHORT).show() }
                        c.remoteReceiver.done(cmd)
                    }
                }
                cmd.type == "stop" && (top is PlayerKey || top is LiveKey) -> {
                    backStack.removeAt(backStack.lastIndex)
                    c.remoteReceiver.done(cmd)
                }
                else -> {
                    val player = c.remoteReceiver.player.takeIf { top is PlayerKey || top is LiveKey }
                    c.remoteReceiver.done(cmd, if (player == null) "Nothing is playing on ${c.deviceName}" else player(cmd))
                }
            }
        }
    }
    // The sidebar (Sidebar.kt) beside every screen but the player.
    SidebarFrame(backStack, hidden = backStack.lastOrNull().let { it is PlayerKey || it is LiveKey }) { menu ->
        NavDisplay(
            backStack = backStack,
            onBack = back,
            entryDecorators = listOf(
                rememberSaveableStateHolderNavEntryDecorator(),
                rememberViewModelStoreNavEntryDecorator(),
                remember { NavEntryDecorator<NavKey>(decorate = { entry -> RemoteScreen { entry.Content() } }) },
            ),
            entryProvider = entryProvider {
                entry<HomeKey> {
                    HomeScreen(
                        HomeNav(
                            openItem = { backStack.add(ItemKey(it.id)) },
                            watchChannel = { watch(it.uuid, it.radio) },
                            search = { backStack.add(SearchKey()) },
                            settings = { backStack.add(SettingsKey) },
                            downloads = { backStack.add(DownloadsKey) },
                            menu = menu,
                            remote = openRemote,
                        ),
                    )
                }
                entry<LibraryKey> { key -> LibraryScreen(key.id, key.name, onOpenItem = { backStack.add(ItemKey(it.id)) }, onBack = back) }
                entry<ItemKey> { key -> ItemScreen(key.id, itemNav) }
                entry<SearchKey> { key -> SearchScreen(key.query, onOpenItem = { backStack.add(ItemKey(it.id)) }, onBack = back) }
                entry<PersonKey> { key -> PersonScreen(key.name, key.fromItem, onOpenItem = { backStack.add(ItemKey(it.id)) }, onBack = back) }
                entry<GuideKey> { key -> GuideScreen(key.radio, onPlay = { watch(it.uuid, it.radio) }, onBack = back) }
                entry<LiveKey> { key -> LivePlayerScreen(key.channel, key.radio, onBack = back) }
                entry<SettingsKey> { SettingsScreen(onBack = back, onLicences = { backStack.add(LicencesKey) }, onPairTv = { backStack.add(PairTvKey()) }) }
                entry<PairTvKey> { key -> PairTvScreen(key.link, onBack = back) }
                entry<LicencesKey> { LicencesScreen(onBack = back) }
                entry<DownloadsKey> { DownloadsScreen(onPlay = { id -> backStack.add(PlayerKey(id)) }, onBack = back) }
                entry<RequestsKey> { RequestsScreen(onOpenItem = { id -> backStack.add(ItemKey(id)) }, onBack = back) }
                entry<RecordingsKey> { RecordingsScreen(onOpenShow = { key, title, everyone -> backStack.add(RecordingShowKey(key, title, everyone)) }, onBack = back) }
                entry<RecordingShowKey> { key ->
                    RecordingShowScreen(key.key, key.title, key.everyone, onOpenSeries = { season -> backStack.add(RecordingSeriesKey(key.key, key.title, season, key.everyone)) }, onBack = back)
                }
                entry<RecordingSeriesKey> { key -> RecordingSeriesScreen(key.key, key.title, key.season, key.everyone, onBack = back) }
                entry<PlayerKey> { key ->
                    PlayerScreen(key.itemId, key.startAt, onBack = back, onCast = { id, at ->
                        // Handed over to another device: it carries on there from here.
                        backStack.removeAt(backStack.lastIndex)
                        c.remote.play(id, at)
                        openRemote()
                    })
                }
                entry<RemoteControlKey> { RemoteControlScreen(onBack = back) }
            },
        )
        // While the phone plays on another device: what's playing there, along the bottom (not over a player).
        val top = backStack.lastOrNull()
        if (top !is PlayerKey && top !is LiveKey && top != RemoteControlKey) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) { MiniController(onOpen = openRemote) }
        }
    }

    // A TV's code scanned with the camera app: Pair a TV takes it from there.
    val pendingTv by c.pendingPairTv.collectAsState()
    LaunchedEffect(pendingTv) {
        pendingTv?.let {
            c.pendingPairTv.value = null
            backStack.add(PairTvKey(it))
        }
    }

    // A pairing link opened while already paired: offer to switch.
    val pending by c.pendingPairLink.collectAsState()
    pending?.let { link ->
        val profile by c.store.profile.collectAsState()
        AlertDialog(
            onDismissRequest = { c.pendingPairLink.value = null },
            title = { Text("Pair with another Reelhouse?") },
            text = {
                Text(
                    "This device is paired with ${profile?.serverName ?: "a Reelhouse"}. Pairing with " +
                        (link.serverName?.let { "“$it”" } ?: "the new code") + " signs it out of that one first.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    // Said yes here, so the pairing screen doesn't ask again.
                    c.pendingPairLink.value = link.copy(confirmed = true)
                    scope.launch { c.connection.signOut() }
                }) { Text("Sign out and pair") }
            },
            dismissButton = { TextButton(onClick = { c.pendingPairLink.value = null }) { Text("Cancel") } },
        )
    }
}
