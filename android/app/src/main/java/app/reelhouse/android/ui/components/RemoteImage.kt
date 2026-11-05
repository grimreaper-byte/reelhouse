package app.reelhouse.android.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.ColorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import app.reelhouse.android.container
import app.reelhouse.android.data.joinUrl
import app.reelhouse.android.ui.theme.Palette
import coil3.compose.AsyncImage
import coil3.request.ImageRequest

private val WIDTHS = intArrayOf(160, 240, 320, 480, 640, 960, 1280, 1920)

/** Adds Reelhouse's resize parameter; widths are rounded up to a few sizes so cached copies get reused. */
fun sizedImagePath(path: String, widthPx: Int): String {
    val w = WIDTHS.firstOrNull { it >= widthPx } ?: WIDTHS.last()
    return path + (if ('?' in path) "&" else "?") + "w=$w"
}

/**
 * An image from Reelhouse (e.g. /api/images/12/poster?v=…). Cached by its path, not the full address, so the
 * same picture isn't loaded again when the route changes between home and the tunnel. Cropped to fill (unless
 * [contentScale] says otherwise), from [alignment]; [placeholder] shows until it's there (or if it can't be).
 * [onError] is for a picture that couldn't be loaded, not for one that hasn't been tried: while the app has no route
 * yet (starting up, or offline) there's no address to load from, and it loads once there is.
 */
@Composable
fun RemoteImage(
    path: String?,
    width: Dp,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    onError: (() -> Unit)? = null,
    alignment: Alignment = Alignment.Center,
    placeholder: Color = Palette.Elevated2,
    contentScale: ContentScale = ContentScale.Crop,
) {
    val context = LocalContext.current
    val connection = context.container.connection
    val state by connection.state.collectAsState()
    val px = with(LocalDensity.current) { width.roundToPx() }
    val sized = path?.let { sizedImagePath(it, px) }
    val base = state.route?.baseUrl
    val request = remember(sized, base) {
        ImageRequest.Builder(context)
            .data(if (sized != null && base != null) joinUrl(base, sized) else null)
            .apply { sized?.let { memoryCacheKey(it); diskCacheKey(it) } }
            .build()
    }
    AsyncImage(
        model = request,
        contentDescription = contentDescription,
        contentScale = contentScale,
        alignment = alignment,
        placeholder = ColorPainter(placeholder),
        error = ColorPainter(placeholder),
        fallback = ColorPainter(placeholder),
        onError = onError?.takeIf { base != null }?.let { cb -> { _ -> cb() } },
        modifier = modifier,
    )
}
