package app.reelhouse.android.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Settings → Open-source licences: Reelhouse's own licence, then every project built into the app. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LicencesScreen(onBack: () -> Unit) {
    var open by remember { mutableStateOf<OpenSourceLibrary?>(null) }
    val statusRow = statusRowBar()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Open-source licences") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                expandedHeight = statusRow.height,
                windowInsets = statusRow.insets,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.Background),
            )
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp)) {
            item {
                LibraryRow(ReelhouseLicence) { open = it }
                Spacer(Modifier.height(12.dp))
                Text(
                    "Reelhouse for Android is built with these open-source projects. Tap one to read its licence.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.TextDim,
                )
                Spacer(Modifier.height(8.dp))
                HorizontalDivider(color = Palette.Border)
            }
            items(OpenSourceLibraries, key = { it.name }) { LibraryRow(it) { lib -> open = lib } }
        }
    }
    open?.let { LicenceDialog(it, onDismiss = { open = null }) }
}

@Composable
private fun LibraryRow(lib: OpenSourceLibrary, onClick: (OpenSourceLibrary) -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClickLabel = "Read the licence") { onClick(lib) }.padding(vertical = 10.dp)) {
        Text(lib.name, style = MaterialTheme.typography.bodyLarge)
        Text(lib.copyright, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
        Text(lib.licence.name, style = MaterialTheme.typography.bodySmall, color = Palette.Accent)
    }
}

/** The licence's full text (from assets/licences), with the project's notes and a link to its website. */
@Composable
private fun LicenceDialog(lib: OpenSourceLibrary, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val uriHandler = LocalUriHandler.current
    val text by produceState<String?>(null, lib) {
        value = withContext(Dispatchers.IO) {
            runCatching { context.assets.open("licences/${lib.licence.file}").bufferedReader().use { reflowLicence(it.readText()) } }
                .getOrDefault("The licence text couldn't be read.")
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(lib.name) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(lib.copyright, style = MaterialTheme.typography.bodyMedium)
                lib.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim, modifier = Modifier.padding(top = 4.dp)) }
                Spacer(Modifier.height(12.dp))
                Text(lib.licence.name, style = MaterialTheme.typography.labelMedium, color = Palette.Accent)
                Spacer(Modifier.height(4.dp))
                Text(text.orEmpty(), style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        dismissButton = lib.url?.let { url -> { TextButton(onClick = { runCatching { uriHandler.openUri(url) } }) { Text("Website") } } },
    )
}
