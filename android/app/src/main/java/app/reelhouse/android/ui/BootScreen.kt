package app.reelhouse.android.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.reelhouse.android.R
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.delay

private const val SHOWN_MS = 2_000L

/**
 * The boot screen over the app while it starts: the logo with "Reelhouse" under it, for 2 seconds, then it fades
 * into the app (which loads underneath meanwhile). It carries on from Android's own launch screen (Android 12 and
 * later: values-v31/themes.xml), which shows the same logo, the same size, in the same place, on the same colour, so
 * the name just appears under it. Only when the app starts afresh, not when it comes back from the background.
 */
@Composable
fun BootScreen() {
    var showing by rememberSaveable { mutableStateOf(true) }
    var named by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        if (!showing) return@LaunchedEffect
        named = true
        delay(SHOWN_MS)
        showing = false
    }
    val nameAlpha by animateFloatAsState(if (named) 1f else 0f, tween(400), label = "name")
    AnimatedVisibility(showing, exit = fadeOut(tween(350))) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Palette.Background)
                // Taps wait for the app underneath.
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {}
                .semantics { contentDescription = "Reelhouse" },
            contentAlignment = Alignment.Center,
        ) {
            // The icon's foreground drawn at the size Android's launch screen gives an icon without a backdrop
            // (288 dp), so the logo doesn't move or change size from one screen to the next.
            Image(painterResource(R.drawable.ic_launcher_foreground), contentDescription = null, modifier = Modifier.size(288.dp))
            // Just under the logo: its drawing ends about 50 dp below the middle of its box.
            Text(
                "Reelhouse",
                style = MaterialTheme.typography.headlineMedium,
                fontSize = 40.sp,
                lineHeight = 44.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = (-0.02).em,
                color = Palette.Text,
                modifier = Modifier.offset(y = 84.dp).alpha(nameAlpha),
            )
        }
    }
}
