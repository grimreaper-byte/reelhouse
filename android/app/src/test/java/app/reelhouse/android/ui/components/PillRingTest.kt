package app.reelhouse.android.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

/** Where a button's focus ring goes with a remote: just off the pill, not round the touch height Material keeps. */
class PillRingTest {
    private val dp = 2f // the Fire TV Stick's density

    private fun ring(width: Float, height: Float, pill: Float?) =
        pillRingBox(width * dp, height * dp, pill?.times(dp), dp).let { RingBox(it.left / dp, it.top / dp, it.width / dp, it.height / dp) }

    @Test
    fun `a plain button's 40 dp pill in its 48 dp touch height, 4 dp off all round`() {
        assertEquals(RingBox(-4f, 0f, 128f, 48f), ring(120f, 48f, null))
    }

    @Test
    fun `a small 32 dp button (Request) gets a ring round the pill, as close as a chip's`() {
        // Material still takes 48 dp for it, with the pill in the middle: the ring once went round all 48.
        assertEquals(RingBox(-3f, 5f, 106f, 38f), ring(100f, 48f, 32f))
    }

    @Test
    fun `a button taller than the touch height fills it`() {
        assertEquals(RingBox(-4f, -4f, 208f, 60f), ring(200f, 52f, 52f))
        assertEquals(RingBox(-4f, -4f, 208f, 56f), ring(200f, 48f, 48f))
        // Two lines of text make a plain button taller than 48 dp, with no room round its pill.
        assertEquals(RingBox(-4f, -4f, 128f, 64f), ring(120f, 56f, null))
    }
}
