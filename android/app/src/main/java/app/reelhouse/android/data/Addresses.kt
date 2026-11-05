package app.reelhouse.android.data

import kotlinx.serialization.json.Json
import java.net.URI

/** One JSON setup for the whole app: tolerant of fields a newer or older Reelhouse adds or leaves out. */
val AppJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    encodeDefaults = true
}

const val DEFAULT_PORT = 8484

/**
 * Turns what someone typed ("192.168.0.3", "192.168.0.3:8484", "https://myhome.duckdns.org:8443/") into a base
 * address without a trailing slash. Plain addresses get http:// and Reelhouse's default port.
 */
fun normalizeAddress(input: String): String {
    var s = input.trim().trimEnd('/')
    require(s.isNotEmpty()) { "Enter Reelhouse's address" }
    val hasScheme = s.contains("://")
    if (!hasScheme) s = "http://$s"
    val uri = try {
        URI(s)
    } catch (e: Exception) {
        throw IllegalArgumentException("That doesn't look like an address: $input")
    }
    require(uri.host != null && (uri.scheme == "http" || uri.scheme == "https")) { "That doesn't look like an address: $input" }
    if (!hasScheme && uri.port == -1) s = "$s:$DEFAULT_PORT"
    return s
}

/** base + path, for bases with or without a path of their own (the tunnel's local address has one). */
fun joinUrl(base: String, path: String): String =
    if (path.startsWith("http://") || path.startsWith("https://")) path
    else base.trimEnd('/') + (if (path.startsWith("/")) path else "/$path")

/**
 * True for addresses that only work at home: private IPv4 ranges, link-local, .local names and IPv6 local
 * addresses. Everything else (a dynamic DNS name, a public IP) is a web address.
 */
fun isHomeAddress(url: String): Boolean {
    val host = try {
        URI(url).host
    } catch (e: Exception) {
        null
    } ?: return false
    val h = host.trim('[', ']').lowercase()
    if (h.endsWith(".local") || h == "localhost") return true
    if (h.contains(':')) return h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")
    val parts = h.split('.').mapNotNull { it.toIntOrNull() }
    if (parts.size != 4) return false
    val (a, b) = parts
    return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
}
