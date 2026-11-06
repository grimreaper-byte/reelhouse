package app.reelhouse.android.ui.livetv

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.ui.components.POSTER_WIDTH
import app.reelhouse.android.ui.components.RemoteImage
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.delay
import java.util.Date

// Pieces the guide and the live player share.

/** The guide's genre colours (the web app's, from Kodi's Estuary), for genre groups 1–11 ([genreGroup]). */
private val GenreColours = listOf(
    Color(219, 120, 23), Color(100, 154, 100), Color(219, 217, 23), Color(237, 14, 40), Color(23, 219, 194),
    Color(65, 234, 77), Color(0, 67, 236), Color(198, 200, 203), Color(158, 32, 158), Color(147, 147, 207),
    Color(29, 161, 177),
)

fun genreColour(group: Int?): Color? = group?.let { GenreColours.getOrNull(it - 1) }

/** "20:00", or "8:00 PM", as the phone is set. */
@Composable
fun rememberTimeOf(): (Long) -> String {
    val context = LocalContext.current
    val format = remember(context) { android.text.format.DateFormat.getTimeFormat(context) }
    return remember(format) { { t: Long -> format.format(Date(t * 1000)) } }
}

/** The time now (epoch seconds), turning over with the minute. */
@Composable
fun minuteClock(): Long {
    val now by produceState(epochNow()) {
        while (true) {
            delay(60_000 - System.currentTimeMillis() % 60_000 + 50)
            value = epochNow()
        }
    }
    return now
}

/** "7 · BBC One", or the name alone without a number. */
fun Channel.title(): String = numberLabel?.let { "$it · $name" } ?: name

/** A channel's logo, or its first letters when it has none (or it can't be shown, e.g. an SVG). */
@Composable
fun ChannelLogo(channel: Channel, size: Dp, modifier: Modifier = Modifier) {
    var failed by remember(channel.icon) { mutableStateOf(channel.icon == null) }
    Box(modifier.size(size).clip(RoundedCornerShape(6.dp)).background(Palette.Elevated2), contentAlignment = Alignment.Center) {
        if (failed) {
            Text(channel.name.take(2), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, color = Palette.TextDim)
        } else {
            RemoteImage(
                channel.icon,
                width = size,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                placeholder = Color.Transparent,
                onError = { failed = true },
                modifier = Modifier.fillMaxSize().padding(size / 10),
            )
        }
    }
}

/** A channel in Continue Watching: its logo and name on a poster's shape, nothing about what's on. It plays straight away. */
@Composable
fun ChannelCard(channel: Channel, onClick: () -> Unit) {
    Column(Modifier.width(POSTER_WIDTH).clickable(onClick = onClick)) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(2f / 3f).clip(RoundedCornerShape(6.dp)).background(Palette.Elevated2),
            contentAlignment = Alignment.Center,
        ) {
            ChannelLogo(channel, POSTER_WIDTH * 2 / 3)
        }
        Text(
            channel.name,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 6.dp),
        )
    }
}
