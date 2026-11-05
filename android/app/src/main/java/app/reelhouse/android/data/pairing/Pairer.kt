package app.reelhouse.android.data.pairing

import app.reelhouse.android.data.api.ApiException
import app.reelhouse.android.data.api.ReelhouseApi
import app.reelhouse.android.data.connection.Prober
import app.reelhouse.android.data.connection.firstReachable
import app.reelhouse.android.data.connection.isPairedServer
import app.reelhouse.android.data.isHomeAddress
import app.reelhouse.android.data.normalizeAddress
import app.reelhouse.android.data.model.SignInResponse
import app.reelhouse.android.data.store.ServerProfile
import app.reelhouse.android.data.store.StoredTunnel
import app.reelhouse.android.data.tunnel.KeyMaker
import app.reelhouse.android.data.tunnel.TunnelEngine

/** Turns a pairing code (or a password) into a stored server profile with this device's sign-in. */
class Pairer(
    private val api: ReelhouseApi,
    private val tunnels: TunnelEngine,
    private val keys: KeyMaker,
    private val deviceName: String,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val prober = Prober { base, timeoutMs -> api.serverInfo(base, timeoutMs).version.isNotEmpty() }

    /**
     * Pairs from a QR code or link. At home, pairs straight at one of the server's addresses with a key made on this
     * phone (the private key never leaves it). Away, brings the tunnel up with the key in the code and pairs through
     * it. Without the app tunnel, only works where one of the addresses answers.
     */
    suspend fun pair(link: PairingPayload): ServerProfile {
        if (link.expired(now())) throw PairingException("This pairing code has expired. Make a new one in Reelhouse.")
        // Only where the code's own Reelhouse answers: away from home, its home address may be something else's.
        val sameServer = Prober { base, timeoutMs -> isPairedServer(link.id, api.serverInfo(base, timeoutMs)) }
        val direct = firstReachable(orderAddresses(link.urls), DIRECT_TIMEOUT_MS, sameServer)
        if (direct != null) {
            val own = if (link.tunnel != null) keys.newKeyPair() else null
            val res = redeem { api.pair(direct, link.code, deviceName, own?.second) }
            val tunnel = res.tunnel?.let { s -> own?.let { StoredTunnel.from(s, it.first) } }
            return profile(res, direct, link.urls, tunnel, link.server)
        }
        val settings = link.tunnel
            ?: throw PairingException("Reelhouse can't be reached from here. Connect to the same Wi-Fi as Reelhouse and try again.")
        val privateKey = settings.privateKey
            ?: throw PairingException("This pairing code has no tunnel key. Make a new one in Reelhouse.")
        val stored = StoredTunnel.from(settings, privateKey)
        val tunnel = try {
            tunnels.start(stored)
        } catch (e: Exception) {
            throw PairingException("The tunnel couldn't start: ${e.message}")
        }
        try {
            if (!prober.reaches(tunnel.baseUrl, TUNNEL_TIMEOUT_MS)) {
                throw PairingException("Reelhouse didn't answer through the tunnel. Check that its app tunnel port is forwarded on the router, or pair at home.")
            }
            val res = redeem { api.pair(tunnel.baseUrl, link.code, deviceName, null) }
            return profile(res, tunnel.baseUrl, link.urls, res.tunnel?.let { stored.updatedFrom(it) } ?: stored, link.server)
        } finally {
            tunnel.stop()
        }
    }

    /** Pairs with a code typed in at home, at an address typed in. */
    suspend fun pairWithCode(address: String, code: String): ServerProfile {
        val base = reachable(address)
        val own = keys.newKeyPair()
        val res = redeem { api.pair(base, code.trim(), deviceName, own.second) }
        return profile(res, base, listOf(base), res.tunnel?.let { StoredTunnel.from(it, own.first) }, null)
    }

    /** Signs in with a username and password (no tunnel: that needs pairing). */
    suspend fun signIn(address: String, username: String, password: String): ServerProfile {
        val base = reachable(address)
        val res = redeem { api.signIn(base, username.trim(), password, deviceName) }
        return profile(res, base, listOf(base), null, null)
    }

    private suspend fun reachable(address: String): String {
        val base = try {
            normalizeAddress(address)
        } catch (e: IllegalArgumentException) {
            throw PairingException(e.message ?: "That doesn't look like an address")
        }
        if (!prober.reaches(base, DIRECT_TIMEOUT_MS * 2)) throw PairingException("Reelhouse didn't answer at $base. Check the address and that this phone is on the same network.")
        return base
    }

    private suspend fun redeem(block: suspend () -> SignInResponse): SignInResponse = try {
        block()
    } catch (e: ApiException) {
        throw PairingException(e.message ?: "Reelhouse refused the sign-in")
    }

    /**
     * [reachedAt] is where Reelhouse answered (maybe the tunnel's temporary local address, which is never stored);
     * [urls] are its lasting direct addresses.
     */
    private suspend fun profile(res: SignInResponse, reachedAt: String, urls: List<String>, tunnel: StoredTunnel?, fallbackName: String?): ServerProfile {
        val info = runCatching { api.serverInfo(reachedAt, 5000) }.getOrNull()
        return ServerProfile(
            serverId = info?.id,
            serverName = res.server?.name ?: info?.name ?: fallbackName ?: "Reelhouse",
            urls = orderAddresses(urls),
            token = res.token,
            user = res.user,
            deviceName = deviceName,
            tunnel = tunnel,
            pairedAt = now(),
        )
    }

    companion object {
        const val DIRECT_TIMEOUT_MS = 2_500L
        const val TUNNEL_TIMEOUT_MS = 12_000L

        /** Home addresses first, then web addresses, without duplicates. */
        fun orderAddresses(urls: List<String>) = urls.distinct().sortedBy { if (isHomeAddress(it)) 0 else 1 }
    }
}

class PairingException(message: String) : Exception(message)
