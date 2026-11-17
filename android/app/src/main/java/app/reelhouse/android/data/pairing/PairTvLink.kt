package app.reelhouse.android.data.pairing

import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Base64

/**
 * What a TV's "Pair with your phone" QR code carries:
 * reelhouse://pair-tv?a=<the TV's address:port on the home network>&k=<a one-time key, base64url>&n=<the TV's name>.
 * A phone already signed in to Reelhouse scans it, makes a pairing for its own account and sends it to the TV there,
 * sealed with the key ([TvHandoff]). The key only ever shows on the TV's screen.
 */
class PairTvLink(val address: String, val key: ByteArray, val name: String) {
    fun toUri(): String =
        "reelhouse://pair-tv?a=${enc(address)}&k=${Base64.getUrlEncoder().withoutPadding().encodeToString(key)}&n=${enc(name)}"

    /** Where the phone sends the pairing. */
    val url: String get() = "http://$address/pair-tv"

    companion object {
        const val KEY_BYTES = 32
        private const val MAX_NAME = 60

        fun isPairTvLink(text: String) = text.trim().startsWith("reelhouse://pair-tv", ignoreCase = true)

        /** Reads a TV's code; throws IllegalArgumentException with a message for the person scanning it. */
        fun parse(text: String): PairTvLink {
            val link = text.trim()
            require(isPairTvLink(link)) { "That isn't a Reelhouse TV code." }
            val query = link.substringAfter('?', "").split('&')
                .associate { it.substringBefore('=') to URLDecoder.decode(it.substringAfter('=', ""), "UTF-8") }
            val address = query["a"].orEmpty()
            require(isHomeAddress(address)) { "That TV code has no address on a home network." }
            val key = runCatching { Base64.getUrlDecoder().decode(query["k"].orEmpty()) }.getOrNull()
            require(key != null && key.size == KEY_BYTES) { "That TV code is incomplete." }
            val name = query["n"].orEmpty().trim().take(MAX_NAME).ifEmpty { "TV" }
            return PairTvLink(address, key, name)
        }

        /**
         * An IPv4 address and port on a home network (10.x, 172.16–31.x, 192.168.x): a code that says to send the
         * pairing anywhere else isn't a TV's, so the phone never sends it out to the internet.
         */
        fun isHomeAddress(address: String): Boolean {
            val m = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$""").matchEntire(address) ?: return false
            val (a, b, c, d, port) = m.destructured.toList().map { it.toInt() }
            if (listOf(a, b, c, d).any { it > 255 } || port !in 1..65535) return false
            return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168)
        }

        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
    }
}
