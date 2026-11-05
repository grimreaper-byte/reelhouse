package app.reelhouse.android.data.connection

import app.reelhouse.android.data.isHomeAddress
import app.reelhouse.android.data.store.ServerProfile
import app.reelhouse.android.data.tunnel.ActiveTunnel
import app.reelhouse.android.data.tunnel.TunnelEngine

/** How the app reaches Reelhouse right now. All of it is just a base address for requests. */
sealed interface Route {
    val baseUrl: String

    /** On the home network, straight to Reelhouse. */
    data class Home(override val baseUrl: String) : Route

    /** Away, through the app tunnel's local address. */
    data class Tunnel(override val baseUrl: String) : Route

    /** Away, at Reelhouse's web address (Option 3: dynamic DNS and HTTPS). */
    data class Web(override val baseUrl: String) : Route
}

enum class RouteMode {
    Auto,

    /** For testing the tunnel at home: skip the home and web addresses. */
    TunnelOnly,
}

class RoutePlanner(private val engine: TunnelEngine) {
    /** The chosen route (null: none works) and the tunnel to keep running (only for a tunnel route). */
    class Choice(val route: Route?, val tunnel: ActiveTunnel?, val problem: String? = null)

    /**
     * Picks the route: home addresses first (fast, nothing in between), then the tunnel, then the web address.
     * [current] is the tunnel already running, if any: reused when the tunnel is still the way, stopped otherwise.
     * Tunnels this doesn't return are stopped, so the caller only has to keep what it gets back.
     */
    suspend fun choose(profile: ServerProfile, current: ActiveTunnel?, mode: RouteMode, prober: Prober): Choice {
        val home = profile.urls.filter(::isHomeAddress)
        val web = profile.urls.filterNot(::isHomeAddress)
        if (mode == RouteMode.Auto) {
            firstReachable(home, HOME_TIMEOUT_MS, prober)?.let {
                current?.stop()
                return Choice(Route.Home(it), null)
            }
        }
        var problem: String? = null
        val settings = profile.tunnel
        if (settings != null) {
            val tunnel = current ?: try {
                engine.start(settings)
            } catch (e: Exception) {
                problem = "The tunnel couldn't start: ${e.message}"
                null
            }
            if (tunnel != null) {
                // A failed check (a timeout, say) only means no answer.
                if (runCatching { prober.reaches(tunnel.baseUrl, TUNNEL_TIMEOUT_MS) }.getOrDefault(false)) return Choice(Route.Tunnel(tunnel.baseUrl), tunnel)
                tunnel.stop()
                problem = "Reelhouse didn't answer through the tunnel"
            }
        } else {
            current?.stop()
        }
        if (mode == RouteMode.Auto) {
            firstReachable(web, WEB_TIMEOUT_MS, prober)?.let { return Choice(Route.Web(it), null) }
        }
        return Choice(null, null, problem ?: "Reelhouse can't be reached from this network")
    }

    companion object {
        const val HOME_TIMEOUT_MS = 2_000L
        const val TUNNEL_TIMEOUT_MS = 8_000L // includes WireGuard's handshake
        const val WEB_TIMEOUT_MS = 6_000L
    }
}
