package app.reelhouse.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.reelhouse.android.container
import app.reelhouse.android.data.model.User
import app.reelhouse.android.ui.theme.Palette

/**
 * Someone's picture in a circle, or the first letter of their name (sized to the circle, as on the web): the letter
 * while there's no route to Reelhouse yet (the app starting, or offline), and when the picture can't be loaded, until
 * the route changes (found at start-up, home ↔ tunnel, back online), when it's tried again.
 */
@Composable
fun AvatarCircle(user: User, sizeDp: Int, modifier: Modifier = Modifier) {
    val route = LocalContext.current.container.connection.state.collectAsState().value.route?.baseUrl
    Box(modifier.size(sizeDp.dp).clip(CircleShape).background(Palette.Accent), contentAlignment = Alignment.Center) {
        var failed by remember(user.avatar, route) { mutableStateOf(false) }
        val path = user.avatar
        if (path != null && route != null && !failed) {
            RemoteImage(path, sizeDp.dp, null, Modifier.fillMaxSize(), onError = { failed = true })
        } else {
            Text(user.username.take(1).uppercase(), fontSize = (sizeDp * 0.4f).sp, fontWeight = FontWeight.Bold, color = Palette.AccentText)
        }
    }
}
