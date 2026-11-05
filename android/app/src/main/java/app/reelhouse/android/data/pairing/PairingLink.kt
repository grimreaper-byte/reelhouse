package app.reelhouse.android.data.pairing

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.model.TunnelSettings
import kotlinx.serialization.Serializable
import java.net.URLDecoder
import java.util.Base64

/** What a pairing QR code or link carries: reelhouse://pair?d=<base64url JSON> (server/pairing.js). */
@Serializable
data class PairingPayload(
    val v: Int = 1,
    val server: String = "Reelhouse",
    /** The server's id (GET /api/server); older servers leave it out. */
    val id: String? = null,
    val code: String,
    val expiresAt: Long = 0,
    val urls: List<String> = emptyList(),
    val tunnel: TunnelSettings? = null,
) {
    fun expired(now: Long = System.currentTimeMillis()) = expiresAt in 1 until now
}

/**
 * A pairing link opened from outside the app (a browser, a message, the camera app). Anything can open one, so it
 * pairs only once the person has said yes ([confirmed]).
 */
data class PendingPairLink(val link: String, val confirmed: Boolean = false) {
    /** The Reelhouse it pairs with, for the question; null if the link can't be read (pairing then says why). */
    val serverName: String? get() = runCatching { PairingLink.parse(link).server }.getOrNull()
}

object PairingLink {
    /** The newest pairing format this app understands; a newer server marks changes it can't read with a higher v. */
    const val VERSION = 1

    fun isPairingLink(text: String) = text.trim().startsWith("reelhouse://pair", ignoreCase = true)

    /** Reads a pairing link; throws IllegalArgumentException with a message for the person pairing. */
    fun parse(text: String): PairingPayload {
        val link = text.trim()
        require(isPairingLink(link)) { "That isn't a Reelhouse pairing code." }
        val query = link.substringAfter('?', "")
        val d = query.split('&')
            .map { it.substringBefore('=') to it.substringAfter('=', "") }
            .firstOrNull { it.first == "d" }?.second
        require(!d.isNullOrEmpty()) { "That pairing code is incomplete." }
        val payload = try {
            val raw = Base64.getUrlDecoder().decode(URLDecoder.decode(d, "UTF-8"))
            AppJson.decodeFromString(PairingPayload.serializer(), String(raw, Charsets.UTF_8))
        } catch (e: Exception) {
            throw IllegalArgumentException("That pairing code couldn't be read.")
        }
        require(payload.v <= VERSION) { "This pairing code is from a newer Reelhouse. Update the app." }
        require(payload.code.isNotBlank()) { "That pairing code is incomplete." }
        return payload
    }
}
