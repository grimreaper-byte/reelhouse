package app.reelhouse.android.ui.components

import android.content.res.Configuration
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.add
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.statusBars
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Whether the sidebar's strip of icons is beside the page (a tablet, or a phone on its side); set by SidebarFrame. */
val LocalSidebarStrip = staticCompositionLocalOf { false }

/**
 * A phone on its side keeps the status bar across the top: the clock on the left (over the sidebar strip) and the
 * icons on the right, with nothing between. A page's top bar goes up into that row instead of sitting under it, which
 * gives the page below the room. Only with the strip beside the page: without it the bar's ☰ or ← would meet the
 * clock.
 */
class StatusRowBar(val on: Boolean) {
    /** The bar's height: the usual one under the status bar, or a slimmer one in its row. */
    @OptIn(ExperimentalMaterial3Api::class)
    val height: Dp get() = if (on) ROW_HEIGHT else TopAppBarDefaults.TopAppBarExpandedHeight

    /** The bar's insets: the usual ones, or none at the top and room kept on the right for the status icons. */
    @OptIn(ExperimentalMaterial3Api::class)
    val insets: WindowInsets
        @Composable get() = if (on) {
            TopAppBarDefaults.windowInsets.only(WindowInsetsSides.Horizontal).add(WindowInsets(right = STATUS_ICONS))
        } else {
            TopAppBarDefaults.windowInsets
        }

    companion object {
        val ROW_HEIGHT = 48.dp
        /** The status icons' share of the row (Wi-Fi, signal, battery and a few more), as on the user's phone. */
        val STATUS_ICONS = 180.dp
    }
}

/** How this page's top bar sits: give a TopAppBar its [StatusRowBar.height] and [StatusRowBar.insets]. */
@Composable
fun statusRowBar(besideStrip: Boolean = LocalSidebarStrip.current): StatusRowBar {
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val statusBar = WindowInsets.statusBars.getTop(LocalDensity.current) > 0
    return StatusRowBar(besideStrip && landscape && statusBar)
}
