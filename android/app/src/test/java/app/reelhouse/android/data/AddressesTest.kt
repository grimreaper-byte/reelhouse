package app.reelhouse.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AddressesTest {
    @Test
    fun `typed addresses get a scheme and Reelhouse's port`() {
        assertEquals("http://192.168.0.3:8484", normalizeAddress("192.168.0.3"))
        assertEquals("http://192.168.0.3:9000", normalizeAddress(" 192.168.0.3:9000/ "))
        assertEquals("https://myhome.duckdns.org:8443", normalizeAddress("https://myhome.duckdns.org:8443/"))
        assertEquals("https://myhome.duckdns.org", normalizeAddress("https://myhome.duckdns.org"))
        assertEquals("http://nas.local:8484", normalizeAddress("nas.local"))
        assertThrows(IllegalArgumentException::class.java) { normalizeAddress("  ") }
        assertThrows(IllegalArgumentException::class.java) { normalizeAddress("ftp://x") }
    }

    @Test
    fun `home addresses are the private ones`() {
        for (u in listOf("http://192.168.0.3:8484", "http://10.0.0.5:8484", "http://172.20.1.1", "http://nas.local:8484", "http://[fd00::1]:8484")) {
            assertTrue(u, isHomeAddress(u))
        }
        for (u in listOf("https://myhome.duckdns.org:8443", "http://203.0.113.9:8484", "http://172.32.0.1", "not a url")) {
            assertFalse(u, isHomeAddress(u))
        }
    }

    @Test
    fun `paths join onto bases with or without a path`() {
        assertEquals("http://h:1/api/x", joinUrl("http://h:1/", "/api/x"))
        assertEquals("http://127.0.0.1:5/abc/api/x?y=1", joinUrl("http://127.0.0.1:5/abc", "/api/x?y=1"))
        assertEquals("http://127.0.0.1:5/abc/api/x", joinUrl("http://127.0.0.1:5/abc", "api/x"))
    }
}
