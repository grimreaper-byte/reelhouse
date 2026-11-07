package app.reelhouse.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.reelhouse.android.data.model.Item
import app.reelhouse.android.ui.common.timeAgo
import app.reelhouse.android.ui.theme.Palette
import app.reelhouse.android.ui.theme.pictureHighlight

private val CardShape = RoundedCornerShape(6.dp)

/**
 * A poster (2:3) card for movies, shows, seasons and episodes (Continue Watching: an episode's poster is its season's
 * or show's); [fill] makes it as wide as its grid cell. A [subtitle] (e.g. the year and the part someone played)
 * replaces the usual line under the title and may take two lines.
 */
@Composable
fun PosterCard(item: Item, onClick: () -> Unit, modifier: Modifier = Modifier, fill: Boolean = false, subtitle: String? = null) {
    // The whole card is the button; its highlight goes around the picture, clear of the words under it.
    val press = remember { MutableInteractionSource() }
    Column((if (fill) modifier.fillMaxWidth() else modifier.width(POSTER_WIDTH)).clickable(press, null, onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).pictureHighlight(press, CardShape)) {
            RemoteImage(item.images.poster, if (fill) GRID_IMAGE_WIDTH else POSTER_WIDTH, null, Modifier.fillMaxWidth().aspectRatio(2f / 3f))
            Badge(item, Modifier.align(Alignment.TopEnd).padding(6.dp))
            ProgressBar(item.progress, Modifier.align(Alignment.BottomStart))
        }
        Text(
            posterTitle(item),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 6.dp),
        )
        Text(
            subtitle ?: defaultSubtitle(item),
            style = MaterialTheme.typography.bodySmall,
            color = Palette.TextDim,
            maxLines = if (subtitle != null) 2 else 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** A wide (16:9) card: episodes in search results, and a Home row the server marks "landscape". */
@Composable
fun LandscapeCard(item: Item, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val press = remember { MutableInteractionSource() }
    Column(modifier.width(LANDSCAPE_WIDTH).clickable(press, null, onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).pictureHighlight(press, CardShape)) {
            RemoteImage(item.images.thumb ?: item.images.backdrop ?: item.images.poster, LANDSCAPE_WIDTH, null, Modifier.fillMaxWidth().aspectRatio(16f / 9f))
            ProgressBar(item.progress, Modifier.align(Alignment.BottomStart))
        }
        Text(
            item.show?.title ?: item.title,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 6.dp),
        )
        Text(
            when {
                item.type != "episode" -> defaultSubtitle(item)
                item.show != null -> listOfNotNull(item.episodeLabel, item.title).joinToString(" · ") // the title line is the show
                else -> item.episodeLabel ?: "" // the title line is already the episode's
            },
            style = MaterialTheme.typography.bodySmall,
            color = Palette.TextDim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** A poster's title: a season's or an episode's show when known (Home's rows: the show is what's recognised). */
internal fun posterTitle(item: Item): String =
    item.show?.title?.takeIf { item.type == "season" || item.type == "episode" } ?: item.title

internal fun defaultSubtitle(item: Item): String = when {
    item.watchedBy.isNotEmpty() -> watchedByLine(item)
    item.newCount != null -> "${item.newCount} new"
    // With the show's name as the title (home rows) the season's name goes below; on a show's page, its size.
    item.type == "season" && item.show != null -> item.title
    item.type == "season" -> item.leafCount?.let { if (it == 1) "1 episode" else "$it episodes" } ?: ""
    // With the show's name as the title (Continue Watching), which episode goes below.
    item.type == "episode" && item.show != null -> listOfNotNull(item.episodeLabel, item.title).joinToString(" · ")
    item.type == "episode" -> item.episodeLabel ?: item.title
    item.type == "show" && item.childCount != null -> if (item.childCount == 1) "1 season" else "${item.childCount} seasons"
    else -> item.year?.toString() ?: ""
}

/** "sam · 2 days ago", "sam and jo · …", "sam and 2 others · …" under a "Watched by Others" card. */
internal fun watchedByLine(item: Item, now: Long = System.currentTimeMillis()): String {
    val people = item.watchedBy
    val who = if (people.size > 2) "${people[0]} and ${people.size - 1} others" else people.joinToString(" and ")
    return listOfNotNull(who.ifEmpty { null }, item.watchedAt?.let { timeAgo(it, now) }).joinToString(" · ")
}

@Composable
private fun Badge(item: Item, modifier: Modifier) {
    val unwatched = (item.leafCount ?: 0) - (item.viewedLeafCount ?: 0)
    when {
        item.state.watched -> Box(modifier.size(22.dp).clip(CircleShape).background(Palette.Accent), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.Check, contentDescription = "Watched", tint = Palette.AccentText, modifier = Modifier.size(16.dp))
        }
        (item.type == "show" || item.type == "season") && unwatched > 0 ->
            Box(
                modifier.clip(RoundedCornerShape(11.dp)).background(Palette.Accent).padding(horizontal = 7.dp, vertical = 2.dp)
                    .clearAndSetSemantics { contentDescription = if (unwatched == 1) "1 unwatched episode" else "$unwatched unwatched episodes" },
            ) {
                Text("$unwatched", style = MaterialTheme.typography.labelSmall, color = Palette.AccentText)
            }
    }
}

@Composable
private fun ProgressBar(progress: Float, modifier: Modifier) {
    if (progress <= 0f) return
    Box(modifier.fillMaxWidth().height(4.dp).background(Palette.Background.copy(alpha = 0.7f))) {
        Box(Modifier.fillMaxWidth(progress).height(4.dp).background(Palette.Accent))
    }
}

val POSTER_WIDTH = 116.dp
val LANDSCAPE_WIDTH = 236.dp
private val GRID_IMAGE_WIDTH = 170.dp
