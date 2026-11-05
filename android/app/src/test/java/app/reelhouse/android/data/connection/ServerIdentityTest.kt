package app.reelhouse.android.data.connection

import app.reelhouse.android.data.model.ServerInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The sign-in token only goes where the paired Reelhouse answers (a home address may be someone else's elsewhere). */
class ServerIdentityTest {
    private val ours = "4466a09bf68ec4109835"

    @Test
    fun `the paired Reelhouse is recognised by its id`() {
        assertTrue(isPairedServer(ours, ServerInfo(id = ours, version = "0.1.0")))
        assertFalse(isPairedServer(ours, ServerInfo(id = "0000000000aaaaaaaaaa", version = "0.1.0")))
    }

    @Test
    fun `an answer without an id isn't taken for the paired Reelhouse`() {
        // Anything can answer {"version": "…"} at a home address on another network.
        assertFalse(isPairedServer(ours, ServerInfo(version = "0.1.0")))
    }

    @Test
    fun `a renamed Reelhouse gives its new name, case included, and nothing changes otherwise`() {
        assertEquals("My-Server", renamedTo("my-server", ServerInfo(id = ours, name = "My-Server", version = "0.1.0")))
        assertEquals("Living room", renamedTo("my-server", ServerInfo(id = ours, name = " Living room ", version = "0.1.0")))
        assertNull(renamedTo("My-Server", ServerInfo(id = ours, name = "My-Server", version = "0.1.0")))
        assertNull(renamedTo("My-Server", ServerInfo(id = ours, name = "  ", version = "0.1.0")))
    }

    @Test
    fun `servers paired before ids existed, and non-Reelhouse answers`() {
        assertTrue(isPairedServer(null, ServerInfo(version = "0.1.0")))
        assertFalse(isPairedServer(ours, ServerInfo(id = ours, version = "")))
    }
}
