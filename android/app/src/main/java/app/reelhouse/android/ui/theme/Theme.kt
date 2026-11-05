package app.reelhouse.android.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The web app's colours (web/css/app.css).
object Palette {
    val Background = Color(0xFF111315)
    val Elevated = Color(0xFF191C20)
    val Elevated2 = Color(0xFF22262B)
    val Elevated3 = Color(0xFF2C3137)
    val Border = Color(0xFF2A2F35)
    val Text = Color(0xFFECEFF3)
    val TextDim = Color(0xFFA2ABB5)
    val TextFaint = Color(0xFF6F7882)
    val Accent = Color(0xFFE5A00D)
    val AccentText = Color(0xFF1A1300)
    val Danger = Color(0xFFE5534B)
    val Ok = Color(0xFF3FB950)
    val Warn = Color(0xFFD29922)
}

private val Colors = darkColorScheme(
    primary = Palette.Accent,
    onPrimary = Palette.AccentText,
    primaryContainer = Palette.Elevated3,
    onPrimaryContainer = Palette.Text,
    secondary = Palette.TextDim,
    onSecondary = Palette.Background,
    secondaryContainer = Palette.Elevated2,
    onSecondaryContainer = Palette.Text,
    background = Palette.Background,
    onBackground = Palette.Text,
    surface = Palette.Background,
    onSurface = Palette.Text,
    surfaceVariant = Palette.Elevated2,
    onSurfaceVariant = Palette.TextDim,
    surfaceContainerLowest = Palette.Background,
    surfaceContainerLow = Palette.Elevated,
    surfaceContainer = Palette.Elevated,
    surfaceContainerHigh = Palette.Elevated2,
    surfaceContainerHighest = Palette.Elevated3,
    outline = Palette.Border,
    outlineVariant = Palette.Border,
    error = Palette.Danger,
    onError = Color.White,
)

@Composable
fun ReelhouseTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Colors, typography = Typography(), content = content)
}
