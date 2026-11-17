package app.reelhouse.android.ui.pair

import app.reelhouse.android.data.pairing.PairTvLink
import org.junit.Assert.assertEquals
import org.junit.Test

/** The TV's code, drawn as a QR code, reads back with the same reader the phone's scanner uses. */
class QrImageTest {
    @Test
    fun `a TV's code round-trips through the QR code`() {
        val text = PairTvLink("192.168.1.50:41234", ByteArray(32) { (it * 7).toByte() }, "Living room Fire TV").toUri()
        val m = qrMatrix(text)
        // As a camera would see it on the screen: each module 4 pixels, with a white border.
        val scale = 4
        val border = 4 * scale
        val size = m.width * scale + 2 * border
        val luminance = ByteArray(size * size) { 255.toByte() }
        for (y in 0 until m.height) for (x in 0 until m.width) {
            if (!m[x, y]) continue
            for (dy in 0 until scale) for (dx in 0 until scale) luminance[(border + y * scale + dy) * size + border + x * scale + dx] = 0
        }
        assertEquals(text, QrDecoder().decode(luminance, size, size))
    }
}
