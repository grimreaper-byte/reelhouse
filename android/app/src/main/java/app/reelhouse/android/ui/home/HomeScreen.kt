package app.reelhouse.android.ui.home

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import app.reelhouse.android.R
import app.reelhouse.android.container
import app.reelhouse.android.data.connection.ConnectionManager.Phase
import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.data.model.Hub
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.ui.common.CenteredMessage
import app.reelhouse.android.ui.common.Loading
import app.reelhouse.android.ui.common.LocalRemoteDevice
import app.reelhouse.android.ui.common.RefreshBox
import app.reelhouse.android.ui.common.focusRow
import app.reelhouse.android.ui.common.remoteFocus
import app.reelhouse.android.ui.components.AvatarCircle
import app.reelhouse.android.ui.components.ConnectionChip
import app.reelhouse.android.ui.components.LandscapeCard
import app.reelhouse.android.ui.components.PosterCard
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.livetv.ChannelCard
import app.reelhouse.android.ui.theme.Palette

/**
 * Where Home can lead. [menu] opens the sidebar's drawer (a phone held upright; on a wide screen its strip is beside
 * Home). Libraries and Downloads are in the sidebar, and [downloads] is what Home offers when Reelhouse can't be reached;
 * your picture in the top bar opens [settings].
 */
class HomeNav(
    val openItem: (Item) -> Unit,
    val watchChannel: (Channel) -> Unit,
    val search: () -> Unit,
    val settings: () -> Unit,
    val downloads: () -> Unit,
    val menu: (() -> Unit)? = null,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(nav: HomeNav) {
    val c = LocalContext.current.container
    val vm = viewModel { HomeViewModel(c) }
    val ui by vm.ui.collectAsState()
    val connection by c.connection.state.collectAsState()
    val profile by c.store.profile.collectAsState()
    val downloads by c.downloads.downloads.collectAsState()
    val update by c.updater.available.collectAsState(initial = null)
    val statusRow = statusRowBar()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Brand() },
                navigationIcon = { nav.menu?.let { IconButton(onClick = it) { Icon(Icons.Filled.Menu, contentDescription = "Menu") } } },
                actions = {
                    ConnectionChip(connection)
                    IconButton(onClick = nav.search) { Icon(Icons.Filled.Search, contentDescription = "Search") }
                    profile?.let { p ->
                        IconButton(onClick = nav.settings) {
                            // A dot while a newer version of the app is waiting on Reelhouse (Settings → About), ringed
                            // in the background's colour so it shows on a picture or a letter alike.
                            BadgedBox(
                                badge = {
                                    if (update != null) {
                                        Box(Modifier.size(12.dp).clip(CircleShape).background(Palette.Background).padding(2.dp).clip(CircleShape).background(Palette.Accent))
                                    }
                                },
                                modifier = Modifier.clearAndSetSemantics {
                                    contentDescription = "Your account and settings" + if (update != null) ", update available" else ""
                                },
                            ) {
                                AvatarCircle(p.user, 32)
                            }
                        }
                    }
                },
                expandedHeight = statusRow.height,
                windowInsets = statusRow.insets,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.Background),
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                ui.loaded -> RefreshBox(ui.refreshing, vm::refresh, Modifier.fillMaxSize()) {
                    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                        if (ui.hubs.isEmpty()) {
                            item { CenteredMessage(if (LocalRemoteDevice.current) "Nothing to show yet. Add libraries in Reelhouse." else "Nothing to show yet. Add libraries in Reelhouse, or pull down to refresh.") }
                        } else {
                            itemsIndexed(ui.hubs, key = { _, hub -> hub.id }) { n, hub -> HubRow(hub, first = n == 0, nav.openItem, nav.watchChannel) }
                        }
                    }
                }
                connection.phase == Phase.Offline -> CenteredMessage(
                    connection.problem ?: "Reelhouse can't be reached",
                    action = "Try again",
                    onAction = c.connection::reconnect,
                    secondAction = if (downloads.any { it.done }) "Watch downloads" else null,
                    onSecondAction = nav.downloads,
                )
                ui.error != null -> CenteredMessage(ui.error!!, action = "Try again", onAction = vm::refresh)
                else -> Loading(if (connection.phase == Phase.Connected) "Loading…" else "Connecting to Reelhouse…")
            }
        }
    }
}

/**
 * The logo and name, as at the top of the web app's sidebar (the server's name is in this app's sidebar). The name
 * shrinks a little rather than being cut short where the top bar is narrow.
 */
@Composable
private fun Brand() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Image(painterResource(R.drawable.logo), contentDescription = null, modifier = Modifier.height(24.dp).aspectRatio(51f / 38f))
        Text(
            "Reelhouse",
            fontWeight = FontWeight.Bold,
            letterSpacing = (-0.02).em,
            maxLines = 1,
            autoSize = TextAutoSize.StepBased(minFontSize = 15.sp, maxFontSize = 21.sp),
        )
    }
}

@Composable
private fun HubRow(hub: Hub, first: Boolean, onOpenItem: (Item) -> Unit, onWatchChannel: (Channel) -> Unit) {
    Text(
        hub.title,
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 10.dp),
    )
    LazyRow(Modifier.focusRow(), contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        itemsIndexed(hub.items, key = { _, item -> item.channel?.uuid ?: item.id }) { n, item ->
            val channel = item.channel
            val focus = Modifier.remoteFocus("${hub.id}/${channel?.uuid ?: item.id}", first = first && n == 0)
            when {
                channel != null -> ChannelCard(channel, onClick = { onWatchChannel(channel) }, modifier = focus)
                hub.style == "landscape" -> LandscapeCard(item, onClick = { onOpenItem(item) }, modifier = focus)
                else -> PosterCard(item, onClick = { onOpenItem(item) }, modifier = focus)
            }
        }
    }
}
