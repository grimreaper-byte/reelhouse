package app.reelhouse.android.data.pairing

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.api.Http
import app.reelhouse.android.data.api.ReelhouseApi
import app.reelhouse.android.data.model.TunnelSettings
import app.reelhouse.android.data.store.StoredTunnel
import app.reelhouse.android.data.tunnel.ActiveTunnel
import app.reelhouse.android.data.tunnel.KeyMaker
import app.reelhouse.android.data.tunnel.TunnelEngine
import app.reelhouse.android.data.tunnel.TunnelStatus
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class PairerTest {
    private val server = MockWebServer()
    private val pairBodies = CopyOnWriteArrayList<String>()
    private var pairStatus = 200
    private lateinit var base: String

    private val tunnelAnswer = """{"endpoint":"203.0.113.9:51821","publicKey":"spub=","presharedKey":"psk=","address":"10.78.0.3","url":"http://10.78.0.1"}"""

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/api/server" -> json(200, """{"id":"abc123","name":"Mock House","version":"0.1.0"}""")
                "/api/auth/pair" -> {
                    pairBodies += request.body?.utf8().orEmpty()
                    if (pairStatus == 200) json(200, """{"token":"tok","user":{"id":1,"username":"dave"},"tunnel":$tunnelAnswer,"server":{"name":"Mock House"}}""")
                    else json(pairStatus, """{"error":"That pairing code is wrong, already used or expired."}""")
                }
                "/api/auth/device" -> json(200, """{"token":"pw-tok","user":{"id":2,"username":"kid"},"server":{"name":"Mock House"}}""")
                else -> json(404, """{"error":"Not found"}""")
            }
        }
        server.start()
        base = server.url("/").toString().trimEnd('/')
    }

    @After
    fun tearDown() = server.close()

    private fun json(code: Int, body: String) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private class FakeTunnel(override val baseUrl: String) : ActiveTunnel {
        var stopped = false
        override fun status() = TunnelStatus()
        override fun rebind() {}
        override fun setEndpoint(endpoint: String) {}
        override fun stop() {
            stopped = true
        }
    }

    /** "Brings the tunnel up" by pointing at the mock server, as the real one points at its local address. */
    private inner class FakeEngine : TunnelEngine {
        val started = mutableListOf<Pair<StoredTunnel, FakeTunnel>>()
        override fun start(settings: StoredTunnel) = FakeTunnel(base).also { started += settings to it }
    }

    private val keys = KeyMaker { "own-priv=" to "own-pub=" }
    private val unreachable = "http://127.0.0.1:1" // nothing listens there: refused at once

    private fun qrTunnel() = TunnelSettings("203.0.113.9:51821", "spub=", "qr-priv=", "psk=", "10.78.0.2", "http://10.78.0.1")

    private fun pairer(engine: TunnelEngine = FakeEngine(), now: Long = 1_000) =
        Pairer(ReelhouseApi(Http.client { null }, base = { null }), engine, keys, "Test Phone", now = { now })

    @Test
    fun `at home the phone pairs with its own key, which never leaves it`() = runTest {
        val link = PairingPayload(code = "ABCD-EFGH", expiresAt = 0, urls = listOf("https://myhome.example:8443", base), tunnel = qrTunnel())
        val p = pairer().pair(link)
        val sent = AppJson.parseToJsonElement(pairBodies.single()).jsonObject
        assertEquals("own-pub=", sent["publicKey"]?.jsonPrimitive?.content)
        assertEquals("Test Phone", sent["device"]?.jsonPrimitive?.content)
        assertFalse(pairBodies.single().contains("own-priv"))
        assertEquals("own-priv=", p.tunnel?.privateKey) // not the QR code's key
        assertEquals("10.78.0.3", p.tunnel?.address) // what the server answered
        assertEquals("tok", p.token)
        assertEquals("abc123", p.serverId)
        assertEquals("Mock House", p.serverName)
        assertEquals(listOf(base, "https://myhome.example:8443"), p.urls) // home addresses first
    }

    @Test
    fun `away it pairs through the tunnel with the QR code's key, and stops that tunnel`() = runTest {
        val engine = FakeEngine()
        val link = PairingPayload(code = "ABCD-EFGH", urls = listOf(unreachable), tunnel = qrTunnel())
        val p = pairer(engine).pair(link)
        val (settings, tunnel) = engine.started.single()
        assertEquals("qr-priv=", settings.privateKey)
        assertTrue(tunnel.stopped)
        assertFalse(pairBodies.single().contains("publicKey"))
        assertEquals("qr-priv=", p.tunnel?.privateKey)
        assertEquals(listOf(unreachable), p.urls) // the tunnel's temporary local address isn't kept
    }

    @Test
    fun `a home address where another Reelhouse answers never gets the code`() = runTest {
        // Away from home, the code's home address can belong to something else on this network.
        val engine = FakeEngine()
        val link = PairingPayload(code = "ABCD-EFGH", id = "not-abc123", urls = listOf(base), tunnel = qrTunnel())
        pairer(engine).pair(link)
        assertEquals(1, engine.started.size) // it went through the tunnel instead
        assertFalse(pairBodies.single().contains("publicKey"))
        // Without a tunnel there's nowhere safe to send it.
        val noTunnel = assertThrows(PairingException::class.java) {
            kotlinx.coroutines.runBlocking { pairer().pair(PairingPayload(code = "ABCD-EFGH", id = "not-abc123", urls = listOf(base))) }
        }
        assertTrue(noTunnel.message!!.contains("can't be reached"))
        assertEquals(1, pairBodies.size)
    }

    @Test
    fun `refusals and dead ends say what to do`() = runTest {
        val expired = assertThrows(PairingException::class.java) {
            kotlinx.coroutines.runBlocking { pairer(now = 5_000).pair(PairingPayload(code = "A", expiresAt = 4_000, urls = listOf(base))) }
        }
        assertTrue(expired.message!!.contains("expired"))

        val noWay = assertThrows(PairingException::class.java) {
            kotlinx.coroutines.runBlocking { pairer().pair(PairingPayload(code = "A", urls = listOf(unreachable), tunnel = null)) }
        }
        assertTrue(noWay.message!!.contains("Wi-Fi"))

        pairStatus = 401
        val wrong = assertThrows(PairingException::class.java) {
            kotlinx.coroutines.runBlocking { pairer().pairWithCode(base, "WRONG-CODE") }
        }
        assertTrue(wrong.message!!.contains("wrong"))
    }

    @Test
    fun `a typed code pairs at the typed address with the phone's own key`() = runTest {
        val p = pairer().pairWithCode(base, " abcd-efgh ")
        assertTrue(pairBodies.single().contains("\"code\":\"abcd-efgh\""))
        assertEquals("own-priv=", p.tunnel?.privateKey)
        assertEquals(listOf(base), p.urls)
    }

    @Test
    fun `a password sign-in has no tunnel`() = runTest {
        val p = pairer().signIn(base, "kid", "secret")
        assertEquals("pw-tok", p.token)
        assertNull(p.tunnel)
    }
}
