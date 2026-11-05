package app.reelhouse.android.data.tunnel

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.store.StoredTunnel
import app.reelhouse.rhtunnel.Rhtunnel
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A running app tunnel: Reelhouse at a local address inside this app. */
interface ActiveTunnel {
    /** Use this as Reelhouse's address (http://127.0.0.1:<port>/<secret>). */
    val baseUrl: String
    fun status(): TunnelStatus
    fun rebind()
    fun setEndpoint(endpoint: String)
    fun stop()
}

/** Starts tunnels; a fake in tests. */
fun interface TunnelEngine {
    fun start(settings: StoredTunnel): ActiveTunnel
}

/** Makes this device's WireGuard key pair (private, public). */
fun interface KeyMaker {
    fun newKeyPair(): Pair<String, String>
}

@Serializable
data class TunnelStatus(
    val lastHandshake: Long = 0, // unix seconds, 0 = never
    val rxBytes: Long = 0,
    val txBytes: Long = 0,
    val endpoint: String? = null,
    val lastError: String? = null,
)

/** The Go library (tunnel/mobile), built into the app by gomobile. */
object GoTunnels : TunnelEngine, KeyMaker {
    override fun start(settings: StoredTunnel): ActiveTunnel {
        val config = buildJsonObject {
            put("privateKey", settings.privateKey)
            put("publicKey", settings.publicKey)
            settings.presharedKey?.let { put("presharedKey", it) }
            put("endpoint", settings.endpoint)
            put("address", settings.address)
            put("url", settings.url)
        }
        val t = Rhtunnel.start(config.toString())
        return object : ActiveTunnel {
            override val baseUrl: String = t.proxyURL()
            override fun status(): TunnelStatus =
                runCatching { AppJson.decodeFromString(TunnelStatus.serializer(), t.status()) }.getOrDefault(TunnelStatus())
            override fun rebind() = t.rebind()
            override fun setEndpoint(endpoint: String) = t.setEndpoint(endpoint)
            override fun stop() = t.stop()
        }
    }

    override fun newKeyPair(): Pair<String, String> {
        val k = Rhtunnel.generateKeyPair()
        return k.privateKey to k.publicKey
    }
}
