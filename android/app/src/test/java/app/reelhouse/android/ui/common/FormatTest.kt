package app.reelhouse.android.ui.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FormatTest {
    @Test
    fun durations() {
        assertEquals("1 h 52 min", formatDuration(112 * 60.0))
        assertEquals("45 min", formatDuration(45 * 60.0 + 10))
        assertEquals("1 min", formatDuration(20.0)) // never "0 min" while something is left
        assertNull(formatDuration(0.0))
        assertNull(formatDuration(null))
    }

    @Test
    fun sizes() {
        assertEquals("4.2 GB", formatSize(4_200_000_000))
        assertEquals("350 MB", formatSize(350_000_000))
        assertEquals("1 MB", formatSize(12_000))
    }

    @Test
    fun positions() {
        assertEquals("12:05", formatPosition(725.4))
        assertEquals("1:02:03", formatPosition(3723.0))
    }
}
