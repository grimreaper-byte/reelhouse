package app.reelhouse.android.ui.settings

import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchColors
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.reelhouse.android.BuildConfig
import app.reelhouse.android.container
import app.reelhouse.android.data.connection.Route
import app.reelhouse.android.data.connection.RouteMode
import app.reelhouse.android.data.tunnel.TunnelStatus
import app.reelhouse.android.ui.common.formatSize
import app.reelhouse.android.ui.components.ConnectionChip
import app.reelhouse.android.ui.components.OutlinedButton
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.theme.Palette
import app.reelhouse.android.ui.theme.TextRing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit, onLicences: () -> Unit) {
    val context = LocalContext.current
    val c = context.container
    val profile by c.store.profile.collectAsState()
    val connection by c.connection.state.collectAsState()
    val scope = rememberCoroutineScope()
    var confirmSignOut by remember { mutableStateOf(false) }
    var signingOut by remember { mutableStateOf(false) }
    var tunnelOnly by remember { mutableStateOf(c.connection.mode == RouteMode.TunnelOnly) }
    var tunnel by remember { mutableStateOf<TunnelStatus?>(null) }
    val downloads by c.downloads.downloads.collectAsState()
    val downloadsOff by c.downloads.turnedOff.collectAsState(initial = false)
    var wifiOnly by remember { mutableStateOf(c.prefs.wifiOnlyDownloads) }
    var downloadBytes by remember { mutableLongStateOf(0L) }
    var confirmDeleteDownloads by remember { mutableStateOf(false) }
    LaunchedEffect(downloads.size, downloads.count { it.done }) {
        downloadBytes = withContext(Dispatchers.IO) { c.downloads.store.bytesUsed() }
    }
    LaunchedEffect(connection) {
        while (true) {
            tunnel = c.connection.tunnelStatus()
            delay(2000)
        }
    }

    val statusRow = statusRowBar()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                expandedHeight = statusRow.height,
                windowInsets = statusRow.insets,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.Background),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            val p = profile ?: return@Column
            Section("Reelhouse")
            AvatarSection(p.user)
            Row2("Server", p.serverName)
            Row2("Signed in as", p.user.username)
            Row2("This device", p.deviceName)

            Section("Connection")
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Route", color = Palette.TextDim)
                ConnectionChip(connection)
            }
            val route = connection.route
            Row2(
                "Address",
                when (route) {
                    is Route.Tunnel -> "Through the tunnel to ${p.tunnel?.url ?: "Reelhouse"}"
                    null -> connection.problem ?: "—"
                    else -> route.baseUrl
                },
            )
            Row2("App tunnel", if (p.tunnel == null) "Not set up (pair with the QR code to use it)" else "Endpoint ${p.tunnel.endpoint}")
            tunnel?.let { t ->
                Row2(
                    "Tunnel status",
                    buildString {
                        append(if (t.lastHandshake > 0) "Connected " + DateUtils.getRelativeTimeSpanString(t.lastHandshake * 1000) else "Waiting for Reelhouse")
                        append(" · ")
                        append(Formatter.formatShortFileSize(context, t.rxBytes))
                        append(" received")
                    },
                )
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = c.connection::reconnect) { Text("Check the connection again") }
            if (BuildConfig.DEBUG && p.tunnel != null) {
                Row(
                    Modifier.fillMaxWidth().toggleable(tunnelOnly, null, TextRing, role = Role.Switch) {
                        tunnelOnly = it
                        c.connection.mode = if (it) RouteMode.TunnelOnly else RouteMode.Auto
                    }.padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Always use the tunnel")
                        Text("For testing the tunnel at home (debug builds only)", style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
                    }
                    Switch(checked = tunnelOnly, onCheckedChange = null, colors = SettingSwitch())
                }
            }

            PlaybackSection()

            Section("Downloads")
            Row(
                Modifier.fillMaxWidth().toggleable(wifiOnly, null, TextRing, role = Role.Switch) {
                    wifiOnly = it
                    c.prefs.wifiOnlyDownloads = it
                    c.downloads.schedule(replace = true)
                }.padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Download on Wi-Fi only")
                    Text("Downloads wait for Wi-Fi instead of using mobile data", style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
                }
                Switch(checked = wifiOnly, onCheckedChange = null, colors = SettingSwitch())
            }
            if (downloadsOff) Row2("Reelhouse", "Downloads are turned off in Reelhouse. What's already downloaded still plays.")
            Row2(
                "On this device",
                if (downloads.isEmpty()) "Nothing downloaded"
                else "${downloads.size} " + (if (downloads.size == 1) "download" else "downloads") + " · " + formatSize(downloadBytes),
            )
            if (downloads.isNotEmpty()) {
                OutlinedButton(onClick = { confirmDeleteDownloads = true }) { Text("Delete all downloads") }
            }

            Section("About")
            Row2("App version", BuildConfig.VERSION_NAME)
            UpdateRow()
            Row(
                Modifier.fillMaxWidth().clickable(null, TextRing, onClick = onLicences).padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Open-source licences")
                    Text("Reelhouse's licence, and the projects this app is built with", style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
                }
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = Palette.TextDim)
            }

            Spacer(Modifier.height(24.dp))
            OutlinedButton(
                onClick = { confirmSignOut = true },
                enabled = !signingOut,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (signingOut) "Signing out…" else "Sign out") }
            Spacer(Modifier.height(32.dp))
        }
    }

    if (confirmDeleteDownloads) {
        AlertDialog(
            onDismissRequest = { confirmDeleteDownloads = false },
            title = { Text("Delete all downloads?") },
            text = { Text("Everything downloaded to this device is deleted, and downloads in progress are cancelled.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDeleteDownloads = false
                    c.downloads.removeAll()
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { confirmDeleteDownloads = false }) { Text("Cancel") } },
        )
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Sign out?") },
            text = {
                Text(
                    "This device is signed out of ${profile?.serverName ?: "Reelhouse"} and its tunnel key is removed. You can pair it again any time." +
                        if (downloads.isNotEmpty()) " Its downloads are deleted too." else "",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmSignOut = false
                    signingOut = true
                    scope.launch { c.connection.signOut() }
                }) { Text("Sign out") }
            },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
        )
    }
}

@Composable
internal fun Section(title: String) {
    Spacer(Modifier.height(20.dp))
    Text(title, style = MaterialTheme.typography.titleSmall, color = Palette.Accent)
    Spacer(Modifier.height(4.dp))
    HorizontalDivider(color = Palette.Border)
}

@Composable
internal fun Row2(label: String, value: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

/** Material's, but off shows too: its thumb and border are the outline colour, here nearly the background. */
@Composable
private fun SettingSwitch(): SwitchColors = SwitchDefaults.colors(uncheckedThumbColor = Palette.TextDim, uncheckedBorderColor = Palette.TextFaint)
