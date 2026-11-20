package app.reelhouse.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import app.reelhouse.android.data.connection.ConnectionManager
import app.reelhouse.android.data.connection.ConnectionManager.Phase
import app.reelhouse.android.data.connection.Route
import app.reelhouse.android.ui.theme.Palette

/** How the app reaches Reelhouse, in words. */
fun routeLabel(state: ConnectionManager.State): String = when (state.phase) {
    Phase.SignedOut -> "Not paired"
    Phase.Connecting -> "Connecting…"
    Phase.Offline -> "Offline"
    Phase.Connected -> when (state.route) {
        is Route.Home -> "At home"
        is Route.Tunnel -> "Tunnel"
        is Route.Web -> "Web"
        null -> "Connected"
    }
}

private fun routeColor(state: ConnectionManager.State): Color = when (state.phase) {
    Phase.Connected -> if (state.route is Route.Home) Palette.Ok else Palette.Accent
    Phase.Offline -> Palette.Danger
    else -> Palette.TextFaint
}

/**
 * How the app reaches Reelhouse: a coloured dot and the words. [compact] (the top bars): the dot alone, with the words
 * for screen readers and in a tooltip when it's touched; Settings shows them in full.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectionChip(state: ConnectionManager.State, modifier: Modifier = Modifier, compact: Boolean = false) {
    if (compact) {
        val tooltip = rememberTooltipState()
        val scope = rememberCoroutineScope()
        TooltipBox(
            positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Below),
            tooltip = { PlainTooltip { Text(routeLabel(state)) } },
            state = tooltip,
        ) {
            Box(
                modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .clickable { scope.launch { tooltip.show() } }
                    .semantics { contentDescription = "Connection: " + routeLabel(state) },
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.size(10.dp).clip(CircleShape).background(routeColor(state)))
            }
        }
        return
    }
    Row(
        modifier.clip(RoundedCornerShape(12.dp)).background(Palette.Elevated2).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(routeColor(state)))
        Text(routeLabel(state), style = MaterialTheme.typography.labelMedium, color = Palette.TextDim)
    }
}
