package app.reelhouse.android.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material.ripple.RippleAlpha
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.SelectableChipColors
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import app.reelhouse.android.ui.theme.Palette
import androidx.compose.material3.Button as MaterialButton
import androidx.compose.material3.FilledTonalButton as MaterialTonalButton
import androidx.compose.material3.FilterChip as MaterialFilterChip
import androidx.compose.material3.OutlinedButton as MaterialOutlinedButton

/**
 * Material's buttons and chips, but with a remote what has the focus gets the accent ring the cards have. Material's own
 * film over it left anything amber darker than the others, looking switched off. Touch never gives them the focus.
 */
@Composable
fun Button(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    colors: ButtonColors = ButtonDefaults.buttonColors(),
    contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
    content: @Composable RowScope.() -> Unit,
) = NoFocusFilm {
    MaterialButton(onClick, modifier.pillRing(), enabled, colors = colors, contentPadding = contentPadding, content = content)
}

@Composable
fun OutlinedButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    colors: ButtonColors = ButtonDefaults.outlinedButtonColors(),
    border: BorderStroke? = ButtonDefaults.outlinedButtonBorder(enabled),
    contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
    content: @Composable RowScope.() -> Unit,
) = NoFocusFilm {
    MaterialOutlinedButton(onClick, modifier.pillRing(), enabled, colors = colors, border = border, contentPadding = contentPadding, content = content)
}

@Composable
fun FilledTonalButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) = NoFocusFilm {
    MaterialTonalButton(onClick, modifier.pillRing(), enabled, content = content)
}

@Composable
fun FilterChip(
    selected: Boolean,
    onClick: () -> Unit,
    label: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    trailingIcon: @Composable (() -> Unit)? = null,
    colors: SelectableChipColors = FilterChipDefaults.filterChipColors(),
) = NoFocusFilm {
    MaterialFilterChip(selected, onClick, label, modifier.chipRing(), trailingIcon = trailingIcon, colors = colors)
}

@OptIn(ExperimentalMaterial3Api::class)
private val NoFilm = RippleConfiguration(rippleAlpha = RippleAlpha(draggedAlpha = 0.16f, focusedAlpha = 0f, hoveredAlpha = 0.08f, pressedAlpha = 0.1f))

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NoFocusFilm(content: @Composable () -> Unit) = CompositionLocalProvider(LocalRippleConfiguration provides NoFilm, content = content)

/**
 * The ring a little way off the pill. A button keeps a 48 dp touch height around its 40 dp pill, which is the gap above
 * and below; a button given another height fills it.
 */
@Composable
private fun Modifier.pillRing(): Modifier {
    var focused by remember { mutableStateOf(false) }
    return onFocusChanged { focused = it.hasFocus }.drawWithContent {
        drawContent()
        if (focused) {
            val gap = 4.dp.toPx()
            val top = if (size.height == 48.dp.toPx()) 0f else -gap
            val height = size.height - 2 * top
            drawRoundRect(
                color = Palette.Accent,
                topLeft = Offset(-gap, top),
                size = Size(size.width + 2 * gap, height),
                cornerRadius = CornerRadius(height / 2),
                style = Stroke(3.dp.toPx()),
            )
        }
    }
}

/** The ring just off a chip, 32 dp high inside its 48 dp touch height. */
@Composable
private fun Modifier.chipRing(): Modifier {
    var focused by remember { mutableStateOf(false) }
    return onFocusChanged { focused = it.hasFocus }.drawWithContent {
        drawContent()
        if (focused) {
            val gap = 3.dp.toPx()
            val height = 32.dp.toPx()
            drawRoundRect(
                color = Palette.Accent,
                topLeft = Offset(-gap, (size.height - height) / 2 - gap),
                size = Size(size.width + 2 * gap, height + 2 * gap),
                cornerRadius = CornerRadius(11.dp.toPx()),
                style = Stroke(3.dp.toPx()),
            )
        }
    }
}
