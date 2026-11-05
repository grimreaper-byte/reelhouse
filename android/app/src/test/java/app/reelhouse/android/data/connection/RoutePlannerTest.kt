package app.reelhouse.android.data.connection

import app.reelhouse.android.data.model.User
import app.reelhouse.android.data.store.ServerProfile
import app.reelhouse.android.data.store.StoredTunnel
import app.reelhouse.android.data.tunnel.ActiveTunnel
import app.reelhouse.android.data.tunnel.TunnelEngine
import app.reelhouse.android.data.tunnel.TunnelStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RoutePlannerTest {
    private class FakeTunnel(override val baseUrl: String = "http://127.0.0.1:4000/secret") : ActiveTunnel {
        var stopped = false
        override fun status() = TunnelStatus()
        override fun rebind() {}
        override fun setEndpoint(endpoint: String) {}
        override fun stop() {
            stopped = true
        }
    }

    private class FakeEngine : TunnelEngine {
        val started = mutableListOf<FakeTunnel>()
        override fun start(settings: StoredTunnel) = FakeTunnel().also { started += it }
    }

    private val tunnel = StoredTunnel("203.0.113.9:51821", "pub", null, "10.78.0.2", "http://10.78.0.1", "priv")
    private val profile = ServerProfile(
        serverName = "Home",
        urls = listOf("http://192.168.0.3:8484", "https://myhome.duckdns.org:8443"),
        token = "t",
        user = User(1, "dave"),
        deviceName = "Pixel",
        tunnel = tunnel,
    )

    /** Answers for the listed addresses; the tunnel's local address answers when [tunnelUp]. */
    private fun prober(vararg up: String, tunnelUp: Boolean = false) = Prober { base, _ ->
        delay(10)
        base in up || (tunnelUp && base.startsWith("http://127.0.0.1"))
    }

    @Test
    fun `at home, the home address wins and a running tunnel stops`() = runTest {
        val engine = FakeEngine()
        val running = FakeTunnel()
        val c = RoutePlanner(engine).choose(profile, running, RouteMode.Auto, prober("http://192.168.0.3:8484", "https://myhome.duckdns.org:8443", tunnelUp = true))
        assertEquals(Route.Home("http://192.168.0.3:8484"), c.route)
        assertNull(c.tunnel)
        assertTrue(running.stopped)
        assertTrue(engine.started.isEmpty())
    }

    @Test
    fun `away, the tunnel comes up and is kept`() = runTest {
        val engine = FakeEngine()
        val c = RoutePlanner(engine).choose(profile, null, RouteMode.Auto, prober("https://myhome.duckdns.org:8443", tunnelUp = true))
        assertTrue(c.route is Route.Tunnel)
        assertSame(engine.started.single(), c.tunnel)
        assertEquals(false, engine.started.single().stopped)
    }

    @Test
    fun `a running tunnel is reused rather than started again`() = runTest {
        val engine = FakeEngine()
        val running = FakeTunnel()
        val c = RoutePlanner(engine).choose(profile, running, RouteMode.Auto, prober(tunnelUp = true))
        assertSame(running, c.tunnel)
        assertTrue(engine.started.isEmpty())
    }

    @Test
    fun `when the tunnel doesn't answer, it stops and the web address is used`() = runTest {
        val engine = FakeEngine()
        val c = RoutePlanner(engine).choose(profile, null, RouteMode.Auto, prober("https://myhome.duckdns.org:8443"))
        assertEquals(Route.Web("https://myhome.duckdns.org:8443"), c.route)
        assertTrue(engine.started.single().stopped)
        assertNull(c.tunnel)
    }

    @Test
    fun `nothing answering means no route, with a reason`() = runTest {
        val c = RoutePlanner(FakeEngine()).choose(profile, null, RouteMode.Auto, prober())
        assertNull(c.route)
        assertTrue(c.problem!!.isNotEmpty())
    }

    @Test
    fun `tunnel-only skips the home and web addresses`() = runTest {
        val c = RoutePlanner(FakeEngine()).choose(profile, null, RouteMode.TunnelOnly, prober("http://192.168.0.3:8484", tunnelUp = true))
        assertTrue(c.route is Route.Tunnel)
    }

    @Test
    fun `a device signed in with a password has no tunnel to try`() = runTest {
        val engine = FakeEngine()
        val c = RoutePlanner(engine).choose(profile.copy(tunnel = null), null, RouteMode.Auto, prober())
        assertNull(c.route)
        assertTrue(engine.started.isEmpty())
    }

    @Test
    fun `a check that fails with an error counts as no answer`() = runTest {
        // As when Reelhouse is down: the tunnel's local proxy times out (found crashing the app on the emulator).
        val throwing = Prober { base, _ -> if (base.startsWith("http://127.0.0.1")) throw java.io.InterruptedIOException("timeout") else false }
        val engine = FakeEngine()
        val c = RoutePlanner(engine).choose(profile, null, RouteMode.Auto, throwing)
        assertNull(c.route)
        assertTrue(engine.started.single().stopped)
    }

    @Test
    fun `the first address to answer is taken`() = runTest {
        val slow = Prober { base, _ ->
            delay(if (base.endsWith("1")) 500 else 50)
            true
        }
        assertEquals("http://b2", firstReachable(listOf("http://a1", "http://b2"), 1000, slow))
        assertNull(firstReachable(emptyList(), 1000, slow))
    }
}
