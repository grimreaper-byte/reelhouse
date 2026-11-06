package app.reelhouse.android.ui

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import app.reelhouse.android.container
import app.reelhouse.android.ui.downloads.DownloadsScreen
import app.reelhouse.android.ui.home.HomeNav
import app.reelhouse.android.ui.home.HomeScreen
import app.reelhouse.android.ui.item.ItemNav
import app.reelhouse.android.ui.item.ItemScreen
import app.reelhouse.android.ui.library.LibraryScreen
import app.reelhouse.android.ui.livetv.GuideScreen
import app.reelhouse.android.ui.livetv.LivePlayerScreen
import app.reelhouse.android.ui.pair.PairScreen
import app.reelhouse.android.ui.person.PersonScreen
import app.reelhouse.android.ui.player.PlayerScreen
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

/** Pairing until there's a server, then the app. */
@Composable
fun ReelhouseRoot() {
    val c = LocalContext.current.container
    val profile by c.store.profile.collectAsState()
    if (profile == null) PairScreen() else SignedIn()
}

@Composable
private fun SignedIn() {
    val c = LocalContext.current.container
    val backStack = rememberNavBackStack(HomeKey)
    val back: () -> Unit = { backStack.removeLastOrNull() }
    val itemNav = ItemNav(
        open = { id -> backStack.add(ItemKey(id)) },
        play = { id, at -> backStack.add(PlayerKey(id, at)) },
        person = { name, fromItem -> backStack.add(PersonKey(name, fromItem)) },
        back = back,
    )
    // The sidebar (Sidebar.kt) beside every screen but the player.
    SidebarFrame(backStack, hidden = backStack.lastOrNull().let { it is PlayerKey || it is LiveKey }) { menu ->
        NavDisplay(
            backStack = backStack,
            onBack = back,
            entryDecorators = listOf(
                rememberSaveableStateHolderNavEntryDecorator(),
                rememberViewModelStoreNavEntryDecorator(),
            ),
            entryProvider = entryProvider {
                entry<HomeKey> {
                    HomeScreen(
                        HomeNav(
                            openItem = { backStack.add(ItemKey(it.id)) },
                            watchChannel = { backStack.add(LiveKey(it.uuid, it.radio)) },
                            search = { backStack.add(SearchKey()) },
                            settings = { backStack.add(SettingsKey) },
                            downloads = { backStack.add(DownloadsKey) },
                            menu = menu,
                        ),
                    )
                }
                entry<LibraryKey> { key -> LibraryScreen(key.id, key.name, onOpenItem = { backStack.add(ItemKey(it.id)) }, onBack = back) }
                entry<ItemKey> { key -> ItemScreen(key.id, itemNav) }
                entry<SearchKey> { key -> SearchScreen(key.query, onOpenItem = { backStack.add(ItemKey(it.id)) }, onBack = back) }
                entry<PersonKey> { key -> PersonScreen(key.name, key.fromItem, onOpenItem = { backStack.add(ItemKey(it.id)) }, onBack = back) }
                entry<GuideKey> { key -> GuideScreen(key.radio, onPlay = { backStack.add(LiveKey(it.uuid, it.radio)) }, onBack = back) }
                entry<LiveKey> { key -> LivePlayerScreen(key.channel, key.radio, onBack = back) }
                entry<SettingsKey> { SettingsScreen(onBack = back, onLicences = { backStack.add(LicencesKey) }) }
                entry<LicencesKey> { LicencesScreen(onBack = back) }
                entry<DownloadsKey> { DownloadsScreen(onPlay = { id -> backStack.add(PlayerKey(id)) }, onBack = back) }
                entry<RequestsKey> { RequestsScreen(onOpenItem = { id -> backStack.add(ItemKey(id)) }, onBack = back) }
                entry<RecordingsKey> { RecordingsScreen(onOpenShow = { key, title, everyone -> backStack.add(RecordingShowKey(key, title, everyone)) }, onBack = back) }
                entry<RecordingShowKey> { key ->
                    RecordingShowScreen(key.key, key.title, key.everyone, onOpenSeries = { season -> backStack.add(RecordingSeriesKey(key.key, key.title, season, key.everyone)) }, onBack = back)
                }
                entry<RecordingSeriesKey> { key -> RecordingSeriesScreen(key.key, key.title, key.season, key.everyone, onBack = back) }
                entry<PlayerKey> { key -> PlayerScreen(key.itemId, key.startAt, onBack = back) }
            },
        )
    }

    // A pairing link opened while already paired: offer to switch.
    val pending by c.pendingPairLink.collectAsState()
    val scope = rememberCoroutineScope()
    pending?.let { link ->
        val profile by c.store.profile.collectAsState()
        AlertDialog(
            onDismissRequest = { c.pendingPairLink.value = null },
            title = { Text("Pair with another Reelhouse?") },
            text = {
                Text(
                    "This phone is paired with ${profile?.serverName ?: "a Reelhouse"}. Pairing with " +
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
