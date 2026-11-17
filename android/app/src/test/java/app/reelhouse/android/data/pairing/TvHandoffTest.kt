package app.reelhouse.android.data.pairing

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Pairing a TV from a phone: the TV's code, the seal, and the TV's one-request listener. */
class TvHandoffTest {
    private val key = ByteArray(32) { it.toByte() }
    private val pairing = "reelhouse://pair?d=" + Base64.getUrlEncoder().withoutPadding()
        .encodeToString("""{"v":1,"server":"Home","code":"ABCD-EFGH","urls":[]}""".toByteArray())

    @Test
    fun `the TV's code carries its address, a key and its name, and reads back`() {
        val uri = PairTvLink("192.168.1.50:41234", key, "Living room Fire TV").toUri()
        assertTrue(uri.startsWith("reelhouse://pair-tv?a=192.168.1.50%3A41234&k="))
        val back = PairTvLink.parse(uri)
        assertEquals("192.168.1.50:41234", back.address)
        assertArrayEquals(key, back.key)
        assertEquals("Living room Fire TV", back.name)
        assertEquals("http://192.168.1.50:41234/pair-tv", back.url)
    }

    @Test
    fun `a code that would send the pairing off the home network, or is incomplete, is refused`() {
        val k = Base64.getUrlEncoder().withoutPadding().encodeToString(key)
        for (address in listOf("8.8.8.8:80", "example.com:80", "192.168.1.5", "192.168.1.5:0", "300.1.1.1:80", "127.0.0.1:80")) {
            assertThrows(address, IllegalArgumentException::class.java) { PairTvLink.parse("reelhouse://pair-tv?a=$address&k=$k&n=TV") }
        }
        for (address in listOf("10.0.2.2:8080", "172.20.0.4:5000", "192.168.1.185:41234")) assertTrue(PairTvLink.isHomeAddress(address))
        assertThrows(IllegalArgumentException::class.java) { PairTvLink.parse("reelhouse://pair-tv?a=192.168.1.5:80&k=c2hvcnQ&n=TV") }
        assertThrows(IllegalArgumentException::class.java) { PairTvLink.parse(pairing) }
        assertEquals("TV", PairTvLink.parse("reelhouse://pair-tv?a=192.168.1.5:80&k=$k").name)
    }

    @Test
    fun `the seal opens only with its key, and not once changed`() {
        val sealed = HandoffCrypto.seal(key, "hello".toByteArray())
        assertEquals("hello", String(HandoffCrypto.open(key, sealed)!!))
        assertNull(HandoffCrypto.open(ByteArray(32), sealed))
        val changed = sealed.copyOf().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() }
        assertNull(HandoffCrypto.open(key, changed))
        assertNull(HandoffCrypto.open(key, ByteArray(10)))
        assertFalse(HandoffCrypto.seal(key, "hello".toByteArray()).contentEquals(sealed)) // a new IV each time

        val body = HandoffCrypto.sealMessage(key, TvHandoffMessage(pairing, "Pixel 8"))
        assertFalse(body.contains("ABCD")) // nothing readable on the network
        assertEquals(TvHandoffMessage(pairing, "Pixel 8"), HandoffCrypto.openMessage(key, body))
        assertNull(HandoffCrypto.openMessage(ByteArray(32), body))
        assertNull(HandoffCrypto.openMessage(key, "not json"))
    }

    @Test
    fun `the listener reads one plain HTTP request and nothing bigger than it allows`() {
        val r = readHandoffRequest(ByteArrayInputStream("POST /pair-tv HTTP/1.1\r\nHost: x\r\ncontent-length: 5\r\n\r\nhello".toByteArray()))!!
        assertEquals("POST", r.method)
        assertEquals("/pair-tv", r.path)
        assertEquals("hello", r.body)
        assertNull(readHandoffRequest(ByteArrayInputStream("POST /pair-tv HTTP/1.1\r\nContent-Length: 99999\r\n\r\n".toByteArray())))
        assertNull(readHandoffRequest(ByteArrayInputStream("POST /pair-tv HTTP/1.1\r\nContent-Length: 10\r\n\r\nshort".toByteArray())))
        assertNull(readHandoffRequest(ByteArrayInputStream("hello there\r\n\r\n".toByteArray())))
    }

    @Test
    fun `the TV's address is its IPv4 one on the home network`() {
        val addresses = listOf("::1", "127.0.0.1", "fe80::1", "192.168.1.50", "10.0.0.2").map { InetAddress.getByName(it) }
        assertEquals("192.168.1.50", homeAddress(addresses))
        assertNull(homeAddress(listOf(InetAddress.getByName("::1"), InetAddress.getByName("8.8.8.8"))))
    }

    @Test
    fun `the TV takes one sealed pairing, refuses anything else, then stops listening`() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val got = mutableListOf<TvHandoffMessage>()
        val done = CountDownLatch(1)
        val tv = TvHandoff(key) { got += it; done.countDown() }
        tv.start(scope)
        val client = OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()
        fun post(path: String, body: String) = client.newCall(
            Request.Builder().url("http://127.0.0.1:${tv.port}$path").post(body.toRequestBody("application/json".toMediaType())).build(),
        ).execute().use { it.code }
        try {
            assertEquals(403, post("/pair-tv", HandoffCrypto.sealMessage(ByteArray(32), TvHandoffMessage(pairing, "Someone else"))))
            assertEquals(404, post("/other", HandoffCrypto.sealMessage(key, TvHandoffMessage(pairing))))
            assertEquals(422, post("/pair-tv", HandoffCrypto.sealMessage(key, TvHandoffMessage("https://example.com", "x"))))
            assertTrue(got.isEmpty())
            assertEquals(200, post("/pair-tv", HandoffCrypto.sealMessage(key, TvHandoffMessage(pairing, "Pixel 8"))))
            assertTrue(done.await(5, TimeUnit.SECONDS))
            assertEquals(listOf(TvHandoffMessage(pairing, "Pixel 8")), got)
            val again = runCatching { post("/pair-tv", HandoffCrypto.sealMessage(key, TvHandoffMessage(pairing, "Pixel 8"))) }
            assertNotNull("no longer listening", again.exceptionOrNull())
        } finally {
            tv.close()
            scope.cancel()
        }
    }
}
