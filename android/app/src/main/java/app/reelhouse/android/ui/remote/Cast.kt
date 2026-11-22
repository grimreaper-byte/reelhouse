package app.reelhouse.android.ui.remote

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cast
import androidx.compose.material.icons.filled.CastConnected
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.TabletAndroid
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.reelhouse.android.container
import app.reelhouse.android.data.remote.RemoteState
import app.reelhouse.android.data.remote.RemoteTarget
import app.reelhouse.android.ui.common.LocalRemoteDevice
import app.reelhouse.android.ui.theme.Palette

/** What a device looks like in the phone remote's list. */
enum class DeviceIcon { Phone, Tablet, Tv, FireTv, Computer }

/** A device's icon: by what it says it is ([RemoteTarget.form], from app 0.16.2), else by its kind. */
fun deviceIcon(kind: String, form: String?): DeviceIcon = when {
    form == "firetv" -> DeviceIcon.FireTv
    form == "tablet" -> DeviceIcon.Tablet
    kind == "web" -> DeviceIcon.Computer
    kind == "phone" -> DeviceIcon.Phone // the app before 0.16.2, on a tablet (or before 0.16.1, on a phone)
    else -> DeviceIcon.Tv // a TV box other than a Fire TV, Kodi
}

val DeviceIcon.vector: ImageVector
    get() = when (this) {
        DeviceIcon.Phone -> Icons.Filled.PhoneAndroid
        DeviceIcon.Tablet -> Icons.Filled.TabletAndroid
        DeviceIcon.Tv -> Icons.Filled.Tv
        DeviceIcon.FireTv -> FireTvIcon
        DeviceIcon.Computer -> Icons.Filled.Computer
    }

fun targetIcon(t: RemoteTarget): ImageVector = deviceIcon(t.kind, t.form).vector

/**
 * "Playing · A Show · S1 · E3", "Paused · A Film" or "Playing · One · The News", for a device's line in the list; just
 * "Playing" for someone else's device playing what this account can't see (the server leaves out what).
 */
fun stateLine(state: RemoteState?): String? {
    state ?: return null
    val what = (if (state.live) listOfNotNull(state.title, state.programme).joinToString(" · ").ifEmpty { null } else null)
        ?: state.showLine ?: state.title
    return (if (state.paused) "Paused" else "Playing") + (what?.let { " · $it" } ?: "")
}

/** A device's line in the Play on list: what it plays, and whose account it plays as when it's someone else's. */
fun targetLine(t: RemoteTarget): String? =
    listOfNotNull(stateLine(t.state), t.owner?.let { "plays as $it" }).joinToString(" · ").ifEmpty { null }

/**
 * The Cast button for the top bars (phones and tablets): there while one of the person's devices is on this network,
 * or one is connected (then in the accent colour). Opens the Play on list; [onRemote] opens the remote screen.
 */
@Composable
fun CastButton(onRemote: () -> Unit) {
    if (LocalRemoteDevice.current) return
    val c = LocalContext.current.container
    val targets by c.remote.targets.collectAsState()
    val active by c.remote.active.collectAsState()
    var picking by remember { mutableStateOf(false) }
    if (targets.isEmpty() && active == null) return
    IconButton(onClick = { picking = true }) {
        if (active != null) {
            Icon(Icons.Filled.CastConnected, contentDescription = "Playing on ${active?.name}", tint = Palette.Accent)
        } else {
            Icon(Icons.Filled.Cast, contentDescription = "Play on another device")
        }
    }
    if (picking) PlayOnSheet(onDismiss = { picking = false }, onRemote = onRemote)
}

/**
 * Where Play goes: this phone, or one of the person's devices on the same network. [onPicked]: a device was picked
 * (from the player: what plays here carries on there), instead of opening the remote screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlayOnSheet(onDismiss: () -> Unit, onRemote: () -> Unit, onPicked: ((RemoteTarget) -> Unit)? = null) {
    val c = LocalContext.current.container
    val targets by c.remote.targets.collectAsState()
    val active by c.remote.active.collectAsState()
    LaunchedEffect(Unit) { c.remote.refresh() }
    // The Cast button is on phones and tablets (not TV boxes).
    val self = if (c.phone) "phone" else "tablet"
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Palette.Elevated) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Text("Play on", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            val selfIcon = if (c.phone) DeviceIcon.Phone else DeviceIcon.Tablet
            TargetRow(selfIcon.vector, "This $self", null, selected = active == null) {
                c.remote.disconnect()
                onDismiss()
            }
            for (t in targets) {
                TargetRow(targetIcon(t), t.label, targetLine(t), selected = active?.id == t.id) {
                    c.remote.connect(t)
                    onDismiss()
                    when {
                        onPicked != null -> onPicked(t)
                        t.state != null -> onRemote()
                    }
                }
            }
            if (targets.isEmpty()) {
                Text(
                    "None of your devices are on this network. Open Reelhouse on a TV, in a browser or in Kodi on the same Wi-Fi.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.TextDim,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
                )
            }
            if (active != null && onPicked == null) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "Open the remote",
                    color = Palette.Accent,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.fillMaxWidth().clickable {
                        onDismiss()
                        onRemote()
                    }.padding(horizontal = 24.dp, vertical = 14.dp),
                )
            }
            Text(
                "Lists your devices with Reelhouse open on the same network as this $self, and others' that they share " +
                    "with anyone at home (what plays there counts on their account).",
                style = MaterialTheme.typography.bodySmall,
                color = Palette.TextFaint,
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
            )
        }
    }
}

@Composable
private fun TargetRow(icon: ImageVector, name: String, line: String?, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 24.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = if (selected) Palette.Accent else Palette.TextDim)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(name, color = if (selected) Palette.Accent else Palette.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            line?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = Palette.Accent)
    }
}

/**
 * A bar along the bottom while the phone plays on another device and something's playing there: what, on which
 * device, and play/pause. Touching it opens the remote screen.
 */
@Composable
fun MiniController(onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val c = LocalContext.current.container
    val active by c.remote.active.collectAsState()
    val playback by c.remote.playback.collectAsState()
    val target = active ?: return
    val state = playback?.state ?: return
    Box(modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp)) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Palette.Elevated2).clickable(onClick = onOpen)
                .padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(Icons.Filled.CastConnected, contentDescription = null, tint = Palette.Accent, modifier = Modifier.size(20.dp))
            Column(Modifier.weight(1f)) {
                Text(state.title ?: "Playing", maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
                Text(
                    listOfNotNull(state.secondLine, "on ${target.name}").joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.TextDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = { if (state.paused) c.remote.resume() else c.remote.pause() }) {
                Icon(if (state.paused) Icons.Filled.PlayArrow else Icons.Filled.Pause, contentDescription = if (state.paused) "Play" else "Pause")
            }
        }
    }
}

/** A device's name for "Plays on …" lines, or null while Play stays on this phone. */
@Composable
fun castingTo(): RemoteTarget? {
    val c = LocalContext.current.container
    val active by c.remote.active.collectAsState()
    return active
}
