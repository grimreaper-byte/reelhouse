package app.reelhouse.android.ui.pair

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64
import kotlin.random.Random

class QrDecoderTest {
    /** A pairing link as long as Reelhouse's: two addresses, a web address and three WireGuard keys. */
    private val link: String = run {
        fun key() = Base64.getEncoder().encodeToString(Random(1).nextBytes(32))
        val json = """{"v":1,"server":"Living room media server","code":"ABCD-EFGH","expiresAt":1792262899000,
            "urls":["http://192.168.100.200:8484","http://172.29.224.1:8484","https://my-home-server.duckdns.org:8443"],
            "tunnel":{"endpoint":"my-home-server.duckdns.org:51821","publicKey":"${key()}","privateKey":"${key()}",
            "presharedKey":"${key()}","address":"10.78.0.123","url":"http://10.78.0.1"}}"""
        "reelhouse://pair?d=" + Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())
    }

    /** Draws the QR code as a camera would see it: grey levels, in a bigger frame with padding per row. */
    private fun frame(text: String, size: Int, frameWidth: Int, rowStride: Int, frameHeight: Int): ByteArray {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M))
        val out = ByteArray(rowStride * frameHeight) { 200.toByte() } // light grey paper
        val left = (frameWidth - size) / 2
        val top = (frameHeight - size) / 2
        for (y in 0 until size) for (x in 0 until size) {
            if (matrix[x, y]) out[(top + y) * rowStride + left + x] = 30 // dark grey ink
        }
        return out
    }

    @Test
    fun `a full-size pairing code is read from a camera-like frame`() {
        val (w, h, stride) = Triple(640, 480, 704)
        assertEquals(link, QrDecoder().decode(frame(link, 440, w, stride, h), w, h, stride))
    }

    @Test
    fun `frames without a code give nothing, and the decoder keeps working`() {
        val d = QrDecoder()
        assertNull(d.decode(ByteArray(640 * 480) { 128.toByte() }, 640, 480))
        assertEquals(link, d.decode(frame(link, 440, 640, 640, 480), 640, 480))
    }
}
