package app.reelhouse.android.ui.settings

import android.content.ActivityNotFoundException
import android.text.format.Formatter
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.reelhouse.android.container
import app.reelhouse.android.data.model.User
import app.reelhouse.android.ui.common.errorText
import app.reelhouse.android.ui.common.remoteFocus
import app.reelhouse.android.ui.components.AvatarCircle
import app.reelhouse.android.ui.components.OutlinedButton
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Your picture: shown here, on Home's top bar, on the web app's top bar and in its Users list. [user] is the stored
 * sign-in's, which a new picture updates. A picture chosen with the photo picker is checked and shown as it will look
 * before anything is uploaded.
 */
@Composable
fun AvatarSection(user: User) {
    val context = LocalContext.current
    val c = context.container
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var prepared by remember { mutableStateOf<PreparedAvatar?>(null) }
    // The picture can change elsewhere (the web app): ask Reelhouse, which updates the stored sign-in.
    LaunchedEffect(Unit) { c.connection.refreshServerDefaults() }

    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        problem = null
        busy = true
        scope.launch {
            try {
                prepared = prepareAvatar(context, uri, Palette.Elevated2.toArgb())
            } catch (e: AvatarProblem) {
                problem = e.message
            } finally {
                busy = false
            }
        }
    }
    val choose = {
        try {
            pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        } catch (_: ActivityNotFoundException) {
            problem = "This device has nothing to choose a picture with. Choose it in Reelhouse's web app."
        }
    }

    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        AvatarCircle(user, 64)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedButton(onClick = choose, enabled = !busy, modifier = Modifier.remoteFocus("picture", first = true)) { Text(if (user.avatar == null) "Choose a picture" else "Change picture") }
            if (user.avatar != null) {
                TextButton(onClick = {
                    problem = null
                    busy = true
                    scope.launch {
                        try {
                            c.store.updateUser(c.api.removeAvatar())
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            problem = c.errorText(e)
                        } finally {
                            busy = false
                        }
                    }
                }, enabled = !busy) { Text("Remove picture") }
            }
        }
    }
    problem?.let { Text(it, color = Palette.Danger, style = MaterialTheme.typography.bodySmall) }

    prepared?.let { p ->
        AlertDialog(
            onDismissRequest = { if (!busy) prepared = null },
            title = { Text("Use this picture?") },
            text = {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Image(p.preview.asImageBitmap(), contentDescription = "Your new picture", contentScale = ContentScale.Crop, modifier = Modifier.size(160.dp).clip(CircleShape))
                    Text(
                        listOfNotNull("${p.width}×${p.height}", p.bytes?.let { Formatter.formatShortFileSize(context, it) }).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = Palette.TextDim,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                    Text(
                        "The middle of the picture, cut square. Reelhouse checks it again when it arrives and keeps a small copy without the photo’s details (such as where it was taken).",
                        style = MaterialTheme.typography.bodySmall,
                        color = Palette.TextDim,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            },
            confirmButton = {
                TextButton(enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        try {
                            c.store.updateUser(c.api.uploadAvatar(p.jpeg))
                            prepared = null
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            problem = c.errorText(e)
                            prepared = null
                        } finally {
                            busy = false
                        }
                    }
                }) { Text(if (busy) "Uploading…" else "Use this picture") }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { prepared = null }) { Text("Cancel") } },
        )
    }
}
