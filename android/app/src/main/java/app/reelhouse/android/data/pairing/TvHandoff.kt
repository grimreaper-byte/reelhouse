package app.reelhouse.android.data.pairing

import app.reelhouse.android.data.AppJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// Pairing a TV from a phone (no camera on a TV, and nothing to tap a link on). The TV shows a PairTvLink as a QR code
// and listens once on the home network; the phone, already signed in, makes a pairing for its own account
// (POST /api/me/pairings) and sends its reelhouse://pair link to the TV, sealed with the code's key (AES-256-GCM), so
// nothing else on the network can read the tunnel key in it. The TV then pairs exactly as with a scanned link.

/** What the phone sends, inside the seal. */
@Serializable
data class TvHandoffMessage(val link: String, val from: String = "")

/** The request body: { v: 1, sealed: base64url(12-byte IV + ciphertext + tag) }. */
@Serializable
data class TvHandoffBody(val v: Int = 1, val sealed: String)

object HandoffCrypto {
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
    private val AAD = "reelhouse-pair-tv-v1".toByteArray()
    private val random = SecureRandom()

    fun newKey(): ByteArray = ByteArray(PairTvLink.KEY_BYTES).also(random::nextBytes)

    fun seal(key: ByteArray, plain: ByteArray): ByteArray {
        val iv = ByteArray(IV_BYTES).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        cipher.updateAAD(AAD)
        return iv + cipher.doFinal(plain)
    }

    /** The plain bytes, or null when they weren't sealed with this key (or were changed on the way). */
    fun open(key: ByteArray, sealed: ByteArray): ByteArray? {
        if (sealed.size <= IV_BYTES + TAG_BITS / 8) return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
            cipher.updateAAD(AAD)
            cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
        } catch (e: AEADBadTagException) {
            null
        } catch (e: java.security.GeneralSecurityException) {
            null
        }
    }

    fun sealMessage(key: ByteArray, message: TvHandoffMessage): String {
        val sealed = seal(key, AppJson.encodeToString(TvHandoffMessage.serializer(), message).toByteArray())
        return AppJson.encodeToString(TvHandoffBody.serializer(), TvHandoffBody(sealed = Base64.getUrlEncoder().withoutPadding().encodeToString(sealed)))
    }

    /** The message in a request body, or null when it isn't one sealed with this key. */
    fun openMessage(key: ByteArray, body: String): TvHandoffMessage? = runCatching {
        val b = AppJson.decodeFromString(TvHandoffBody.serializer(), body)
        if (b.v != 1) return@runCatching null
        val plain = open(key, Base64.getUrlDecoder().decode(b.sealed)) ?: return@runCatching null
        AppJson.decodeFromString(TvHandoffMessage.serializer(), String(plain))
    }.getOrNull()
}

/** One HTTP request as the TV's listener reads it. */
class HandoffRequest(val method: String, val path: String, val body: String)

/**
 * Reads one HTTP/1.1 request: its request line, headers and a body of Content-Length (at most [maxBody] bytes).
 * Null for anything else (too big, cut short, not HTTP).
 */
fun readHandoffRequest(input: InputStream, maxBody: Int = 16 * 1024): HandoffRequest? {
    fun line(): String? {
        val out = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b == -1) return null
            if (b == '\n'.code) break
            if (out.size() > 8192) return null
            out.write(b)
        }
        return out.toString("ISO-8859-1").trimEnd('\r')
    }
    val requestLine = line() ?: return null
    val parts = requestLine.split(' ')
    if (parts.size != 3 || !parts[2].startsWith("HTTP/")) return null
    var length = 0
    var headers = 0
    while (true) {
        val h = line() ?: return null
        if (h.isEmpty()) break
        if (++headers > 100) return null
        if (h.substringBefore(':').trim().equals("Content-Length", ignoreCase = true)) {
            length = h.substringAfter(':').trim().toIntOrNull() ?: return null
        }
    }
    if (length < 0 || length > maxBody) return null
    val body = ByteArray(length)
    var read = 0
    while (read < length) {
        val n = input.read(body, read, length - read)
        if (n == -1) return null
        read += n
    }
    return HandoffRequest(parts[0], parts[1], String(body, Charsets.UTF_8))
}

/** The address to put in the TV's code: its IPv4 address on the home network, or null when it hasn't one. */
fun homeAddress(addresses: List<InetAddress>): String? =
    addresses.filterIsInstance<Inet4Address>()
        .firstOrNull { it.isSiteLocalAddress && !it.isLoopbackAddress }
        ?.hostAddress

/**
 * The TV's side: listens on a free port until one request brings a pairing link sealed with [key], hands it to
 * [onMessage] and stops. Anything else gets an error and the listener carries on (until [close]).
 */
class TvHandoff(private val key: ByteArray, private val onMessage: (TvHandoffMessage) -> Unit) : Closeable {
    private val server = ServerSocket(0)
    @Volatile private var closed = false

    val port: Int get() = server.localPort

    fun start(scope: CoroutineScope) {
        scope.launch(Dispatchers.IO) {
            while (!closed) {
                val socket = try {
                    server.accept()
                } catch (e: Exception) {
                    break // closed
                }
                val message = runCatching { handle(socket) }.getOrNull()
                if (message != null) {
                    close()
                    onMessage(message)
                }
            }
        }
    }

    private fun handle(socket: Socket): TvHandoffMessage? = socket.use { s ->
        s.soTimeout = 10_000
        val request = readHandoffRequest(s.getInputStream())
        val (status, message) = when {
            request == null -> 400 to null
            request.method != "POST" || request.path != "/pair-tv" -> 404 to null
            else -> {
                val m = HandoffCrypto.openMessage(key, request.body)
                when {
                    m == null -> 403 to null
                    !PairingLink.isPairingLink(m.link) || runCatching { PairingLink.parse(m.link) }.isFailure -> 422 to null
                    else -> 200 to m
                }
            }
        }
        val text = if (status == 200) """{"ok":true}""" else """{"error":"${reason(status)}"}"""
        val bytes = text.toByteArray()
        val head = "HTTP/1.1 $status ${reason(status)}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
        s.getOutputStream().apply {
            write(head.toByteArray())
            write(bytes)
            flush()
        }
        message
    }

    private fun reason(status: Int) = when (status) {
        200 -> "OK"
        400 -> "Bad Request"
        403 -> "Not this TV's code"
        404 -> "Not Found"
        else -> "Not a pairing"
    }

    override fun close() {
        closed = true
        runCatching { server.close() }
    }
}
