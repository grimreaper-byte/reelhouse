package app.reelhouse.android.ui.player

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.reelhouse.android.data.playback.AvSync
import app.reelhouse.android.ui.theme.Palette

/** What the manual fine-tune does, in the viewer's terms. */
const val SYNC_HINT = "Only if it still looks off. Sound before the mouths move? Make it later (+). After them? Earlier (−). It's kept for every video on this phone."

/** What the automatic picture timing is doing, from the delay it makes up for (ms). */
fun pictureTimingText(delayMs: Int): String =
    if (delayMs > 0) "Automatic: this phone shows the picture $delayMs ms late, and the app makes up for it."
    else "Automatic: measured while you watch. This phone shows the picture on time so far."

/** The current setting and buttons to move it in 10 and 50 ms steps. */
@Composable
fun SyncAdjuster(ms: Int, onChange: (Int) -> Unit, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(AvSync.label(ms), style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (step in listOf(-50, -10, 10, 50)) {
                OutlinedButton(
                    onClick = { onChange(ms + step) },
                    contentPadding = PaddingValues(horizontal = 8.dp),
                    modifier = Modifier.widthIn(min = 52.dp),
                ) { Text(if (step > 0) "+$step" else "−${-step}") }
            }
        }
    }
}

/** A small panel over the video, so the picture can be watched while the sync is changed. */
@Composable
fun SyncPanel(ms: Int, pictureDelayMs: Int, onChange: (Int) -> Unit, onDone: () -> Unit, modifier: Modifier = Modifier) {
    Surface(color = Palette.Elevated.copy(alpha = 0.95f), shape = RoundedCornerShape(12.dp), modifier = modifier.widthIn(max = 460.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Picture and sound", style = MaterialTheme.typography.labelMedium, color = Palette.Accent)
            Text(pictureTimingText(pictureDelayMs), style = MaterialTheme.typography.bodySmall)
            Text("Fine-tune", style = MaterialTheme.typography.labelMedium, color = Palette.TextDim)
            Row(verticalAlignment = Alignment.Bottom) {
                SyncAdjuster(ms, onChange, Modifier.weight(1f))
                Column {
                    TextButton(onClick = { onChange(0) }, enabled = ms != 0) { Text("Reset") }
                    TextButton(onClick = onDone) { Text("Done") }
                }
            }
            Text(SYNC_HINT, style = MaterialTheme.typography.bodySmall, color = Palette.TextDim)
        }
    }
}
