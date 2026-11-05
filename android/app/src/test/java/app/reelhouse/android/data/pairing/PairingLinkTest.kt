package app.reelhouse.android.data.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class PairingLinkTest {
    private fun link(json: String) = "reelhouse://pair?d=" + Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())

    @Test
    fun `reads what Reelhouse puts in the QR code`() {
        val p = PairingLink.parse(
            link(
                """{"v":1,"server":"Home","code":"ABCD-EFGH","expiresAt":4102444800000,
                "urls":["http://192.168.0.3:8484","https://myhome.duckdns.org:8443"],
                "tunnel":{"endpoint":"203.0.113.9:51821","publicKey":"pub=","privateKey":"priv=","presharedKey":"psk=","address":"10.78.0.2","url":"http://10.78.0.1"}}""",
            ),
        )
        assertEquals("ABCD-EFGH", p.code)
        assertEquals("Home", p.server)
        assertEquals(2, p.urls.size)
        assertEquals("priv=", p.tunnel?.privateKey)
        assertEquals("http://10.78.0.1", p.tunnel?.url)
        assertFalse(p.expired())
    }

    @Test
    fun `a pairing without the app tunnel has no tunnel`() {
        val p = PairingLink.parse(link("""{"v":1,"code":"ABCD-EFGH","urls":[],"tunnel":null}"""))
        assertNull(p.tunnel)
    }

    @Test
    fun `expired, foreign, broken and newer codes are refused with a reason`() {
        assertTrue(PairingLink.parse(link("""{"v":1,"code":"A","expiresAt":1000}""")).expired(2000))
        assertThrows(IllegalArgumentException::class.java) { PairingLink.parse("https://example.com/?d=x") }
        assertThrows(IllegalArgumentException::class.java) { PairingLink.parse("reelhouse://pair?d=%%%") }
        assertThrows(IllegalArgumentException::class.java) { PairingLink.parse("reelhouse://pair") }
        val newer = assertThrows(IllegalArgumentException::class.java) { PairingLink.parse(link("""{"v":2,"code":"A"}""")) }
        assertTrue(newer.message!!.contains("newer"))
    }

    @Test
    fun `padding and percent-encoding in the link are fine`() {
        val padded = "reelhouse://pair?d=" + Base64.getUrlEncoder().encodeToString("""{"v":1,"code":"XY"}""".toByteArray()).replace("=", "%3D")
        assertEquals("XY", PairingLink.parse(padded).code)
    }
}
