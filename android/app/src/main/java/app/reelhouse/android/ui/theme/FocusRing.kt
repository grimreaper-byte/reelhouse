package app.reelhouse.android.ui.theme

import androidx.compose.foundation.IndicationNodeFactory
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.FocusInteraction
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.material3.ripple
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.node.DelegatableNode
import androidx.compose.ui.node.DelegatingNode
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch

/**
 * What clickable things show, everywhere: the usual ripple when touched, and with a remote or a keyboard an accent ring
 * around what has the focus, as on the web app's cards. Touch never gives them the focus, so a phone never shows it.
 */
internal object FocusRing : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode = RingNode(interactionSource, RingAt.Inside, rippleToo = true)

    override fun hashCode(): Int = javaClass.hashCode()

    override fun equals(other: Any?): Boolean = other === this
}

/** For rows of text that start right at their edge, where [FocusRing] would run through the words: the ring goes wider. */
internal object TextRing : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode = RingNode(interactionSource, RingAt.BesideText, rippleToo = true)

    override fun hashCode(): Int = javaClass.hashCode()

    override fun equals(other: Any?): Boolean = other === this
}

private object OutsideRing : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode = RingNode(interactionSource, RingAt.Outside, rippleToo = false)

    override fun hashCode(): Int = javaClass.hashCode()

    override fun equals(other: Any?): Boolean = other === this
}

private enum class RingAt { Inside, Outside, BesideText }

/**
 * A card's picture, cut to [shape]: the ripple on it when touched, and the ring just outside it, clear of the words below
 * and of what's on the picture (its progress bar, its badges). Its button is the whole card: pass the card's [press].
 */
fun Modifier.pictureHighlight(press: InteractionSource, shape: Shape): Modifier =
    indication(press, OutsideRing).clip(shape).indication(press, PressRipple)

/** The ripple for touches alone, without its film over what has the focus. */
internal object PressRipple : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode = ripple().create(PressesOf(interactionSource))

    override fun hashCode(): Int = javaClass.hashCode()

    override fun equals(other: Any?): Boolean = other === this
}

/** Only the touches: the ring shows the focus, and the ripple's own film over it would wash out the picture. */
private class PressesOf(source: InteractionSource) : InteractionSource {
    override val interactions = source.interactions.filter { it is PressInteraction }
}

private class RingNode(private val source: InteractionSource, private val at: RingAt, rippleToo: Boolean) : DelegatingNode(), DrawModifierNode {
    private var focused = false

    init {
        if (rippleToo) delegate(PressRipple.create(source))
    }

    override fun onAttach() {
        coroutineScope.launch {
            source.interactions.collect { interaction ->
                val now = when (interaction) {
                    is FocusInteraction.Focus -> true
                    is FocusInteraction.Unfocus -> false
                    else -> focused
                }
                if (now != focused) {
                    focused = now
                    invalidateDraw()
                }
            }
        }
    }

    override fun ContentDrawScope.draw() {
        drawContent()
        if (focused) {
            val width = 3.dp.toPx()
            val (insetX, insetY) = when (at) {
                RingAt.Inside -> width / 2 to width / 2
                RingAt.Outside -> -width / 2 to -width / 2
                RingAt.BesideText -> -8.dp.toPx() to 0f
            }
            drawRoundRect(
                color = Palette.Accent,
                topLeft = Offset(insetX, insetY),
                size = Size(size.width - 2 * insetX, size.height - 2 * insetY),
                cornerRadius = CornerRadius(8.dp.toPx()),
                style = Stroke(width),
            )
        }
    }
}
