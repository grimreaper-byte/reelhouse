package app.reelhouse.android.data.remote

import app.reelhouse.android.data.events.ServerEvent
import app.reelhouse.android.data.events.parseServerEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The phone remote's events as the app reads them (server/remote.js), and the position running on between reports. */
class RemoteTest {
    @Test
    fun `the remote's events`() {
        assertEquals(ServerEvent.RemoteTargetsChanged, parseServerEvent("remote-targets", "{}"))
        assertEquals(
            ServerEvent.RemoteStateChanged(
                "t1",
                RemoteState(itemId = 11, title = "Pilot", show = "A Show", season = 1, episode = 1, position = 100.0, duration = 1500.0, state = "paused", age = 40),
            ),
            parseServerEvent(
                "remote-state",
                """{"targetId":"t1","state":{"itemId":11,"title":"Pilot","show":"A Show","season":1,"episode":1,"position":100,"duration":1500,"state":"paused","live":false,"age":40}}""",
            ),
        )
        assertEquals(ServerEvent.RemoteStateChanged("t1", null), parseServerEvent("remote-state", """{"targetId":"t1","state":null}"""))
        assertEquals(ServerEvent.RemoteDone("c1", false, "blocked"), parseServerEvent("remote-done", """{"id":"c1","targetId":"t1","ok":false,"problem":"blocked"}"""))
        assertEquals(ServerEvent.RemoteDone("c2", true, null), parseServerEvent("remote-done", """{"id":"c2","targetId":"t1","ok":true,"problem":null}"""))
        assertEquals(
            ServerEvent.RemoteCommandReceived(RemoteCommand("c3", "play", itemId = 1, start = 90.0, from = "Pixel")),
            parseServerEvent("remote", """{"id":"c3","type":"play","itemId":1,"start":90,"from":"Pixel"}"""),
        )
        assertNull(parseServerEvent("remote-state", """{"state":null}"""))
        assertNull(parseServerEvent("remote-hello", """{"targetId":"t1"}"""))
    }

    @Test
    fun `the position runs on while playing, from when the report was made, never past the end`() {
        val playing = RemoteState(position = 100.0, duration = 120.0, state = "playing", age = 500)
        assertEquals(100.5, runOn(playing, 0), 0.001)
        assertEquals(110.5, runOn(playing, 10_000), 0.001)
        assertEquals(120.0, runOn(playing, 60_000), 0.001)
        assertEquals(100.0, runOn(playing.copy(state = "paused"), 60_000), 0.001)
        assertEquals(30.0, runOn(RemoteState(position = 0.0, state = "playing"), 30_000), 0.001) // no duration known
        assertEquals(42.0, Playback(playing.copy(state = "paused", position = 42.0), 1_000).positionAt(9_000), 0.001)
    }

    @Test
    fun `what the phone says when a device couldn't do something`() {
        assertEquals("Firefox on Windows needs a press of Play: browsers don't start videos by themselves", problemText("Firefox on Windows", "blocked"))
        assertEquals("Fire TV couldn't do that", problemText("Fire TV", null))
        assertEquals("This is the last episode.", problemText("Fire TV", "This is the last episode."))
    }

    @Test
    fun `an episode's line names the show, series and episode`() {
        assertEquals("A Show · S1 · E3", RemoteState(show = "A Show", season = 1, episode = 3).showLine)
        assertNull(RemoteState(title = "A Film").showLine)
    }
}
