package app.reelhouse.android.data.remote

import app.reelhouse.android.data.events.ServerEvent
import app.reelhouse.android.data.events.parseServerEvent
import app.reelhouse.android.ui.common.deviceForm
import app.reelhouse.android.ui.common.phoneSized
import app.reelhouse.android.ui.remote.DeviceIcon
import app.reelhouse.android.ui.remote.deviceIcon
import app.reelhouse.android.ui.remote.stateLine
import kotlinx.serialization.json.Json
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
        assertEquals(ServerEvent.RemoteHello, parseServerEvent("remote-hello", """{"targetId":"t1"}"""))
    }

    @Test
    fun `phase 2's events - what a device offers, a channel playing, and commands for them`() {
        val offer = RemoteControls(
            audio = listOf(RemoteTrack("a0", "English · AC3 · 5.1"), RemoteTrack("a1", "French")), audioId = "a1",
            subtitles = listOf(RemoteTrack("s1", "English")), subtitleId = null, volume = 80, muted = false, canPause = true,
        )
        assertEquals(
            ServerEvent.RemoteStateChanged("t1", RemoteState(title = "One", live = true, channel = "ch1", programme = "The News", age = 5), offer),
            parseServerEvent(
                "remote-state",
                """{"targetId":"t1","state":{"itemId":null,"title":"One","live":true,"channel":"ch1","radio":false,"programme":"The News","state":"playing","age":5},""" +
                    """"controls":{"audio":[{"id":"a0","label":"English · AC3 · 5.1"},{"id":"a1","label":"French"}],"audioId":"a1",""" +
                    """"subtitles":[{"id":"s1","label":"English"}],"subtitleId":null,"volume":80,"muted":false,"canPause":true}}""",
            ),
        )
        assertEquals(ServerEvent.RemoteStateChanged("t1", null, null), parseServerEvent("remote-state", """{"targetId":"t1","state":null,"controls":null}"""))
        assertEquals(
            ServerEvent.RemoteCommandReceived(RemoteCommand("c4", "play", channel = "ch2", radio = false, name = "Two", zap = true, from = "sam's Galaxy")),
            parseServerEvent("remote", """{"id":"c4","type":"play","channel":"ch2","radio":false,"name":"Two","zap":true,"from":"sam's Galaxy"}"""),
        )
        assertEquals(RemoteCommand("c5", "subtitle", track = null), (parseServerEvent("remote", """{"id":"c5","type":"subtitle","track":null}""") as ServerEvent.RemoteCommandReceived).command)
        assertEquals(35, (parseServerEvent("remote", """{"id":"c6","type":"volume","level":35}""") as ServerEvent.RemoteCommandReceived).command.level)
        // A device from before 0.26.0: no controls.
        assertNull((parseServerEvent("remote-state", """{"targetId":"t1","state":null}""") as ServerEvent.RemoteStateChanged).controls)
    }

    @Test
    fun `the tracks sheet is worth showing with more than one sound track or any subtitles`() {
        assertEquals(false, RemoteControls(audio = listOf(RemoteTrack("a0", "English"))).hasTracks)
        assertEquals(true, RemoteControls(audio = listOf(RemoteTrack("a0", "English"), RemoteTrack("a1", "French"))).hasTracks)
        assertEquals(true, RemoteControls(subtitles = listOf(RemoteTrack("s1", "English"))).hasTracks)
    }

    @Test
    fun `someone else's shared device says whose it is`() {
        assertEquals("Living room TV · dave's", RemoteTarget("t", "tv", "Living room TV", owner = "dave").label)
        assertEquals("Fire TV", RemoteTarget("t", "tv", "Fire TV").label)
    }

    @Test
    fun `a channel's second line is what's on`() {
        assertEquals("The News", RemoteState(title = "One", live = true, programme = "The News").secondLine)
        assertEquals("A Show · S1 · E3", RemoteState(show = "A Show", season = 1, episode = 3).secondLine)
    }

    @Test
    fun `the phone's volume buttons go 5 at a time, within 0 to 100`() {
        assertEquals(55, stepVolume(50, up = true))
        assertEquals(45, stepVolume(50, up = false))
        assertEquals(100, stepVolume(98, up = true))
        assertEquals(0, stepVolume(3, up = false))
    }

    @Test
    fun `a player's volume from the phone - muting keeps the level for later`() {
        var v = 0.8f
        val volume = RemoteVolume({ v }, { v = it })
        assertEquals(80, volume.level())
        volume.setMuted(true)
        assertEquals(0f, v)
        assertEquals(80, volume.level()) // what it goes back to
        volume.setMuted(false)
        assertEquals(0.8f, v)
        volume.setLevel(30)
        assertEquals(0.3f, v, 0.0001f)
        volume.setLevel(0)
        assertEquals(true, volume.muted)
        volume.setMuted(false)
        assertEquals(0.3f, v, 0.0001f) // back to the last level heard
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

    @Test
    fun `a device line says what plays, or only that something does when it isn't for this account`() {
        assertEquals("Paused · A Film", stateLine(RemoteState(title = "A Film", state = "paused")))
        assertEquals("Playing · A Show · S1 · E3", stateLine(RemoteState(title = "Pilot", show = "A Show", season = 1, episode = 3)))
        assertEquals("Playing", stateLine(RemoteState(title = null)))
        assertNull(stateLine(null))
    }

    @Test
    fun `phones are the remote, tablets and TVs can be controlled`() {
        assertEquals(true, phoneSized(411)) // a usual phone
        assertEquals(true, phoneSized(599))
        assertEquals(false, phoneSized(600)) // a small tablet
        assertEquals(false, phoneSized(800)) // a Fire HD 10
        assertEquals(false, phoneSized(0)) // Android doesn't know: not taken as a phone
    }

    @Test
    fun `a device says what it is - a Fire TV or a tablet - and the stream query carries it while it may be controlled`() {
        assertEquals("firetv", deviceForm(tvBox = true, phone = false, fireTv = true))
        assertNull(deviceForm(tvBox = true, phone = false, fireTv = false)) // another TV box: its kind says it
        assertEquals("tablet", deviceForm(tvBox = false, phone = false, fireTv = false))
        assertNull(deviceForm(tvBox = false, phone = true, fireTv = false))

        assertEquals("?target=tv&form=firetv", liveStreamQuery(tvBox = true, form = "firetv", target = true, shared = false))
        assertEquals("?target=tv&form=firetv&shared=1", liveStreamQuery(tvBox = true, form = "firetv", target = true, shared = true))
        assertEquals("?target=tv", liveStreamQuery(tvBox = true, form = null, target = true, shared = false))
        assertEquals("", liveStreamQuery(tvBox = true, form = "firetv", target = false, shared = true))
        assertEquals("?controller=1&target=phone&form=tablet", liveStreamQuery(tvBox = false, form = "tablet", target = true, shared = false))
        assertEquals("?controller=1", liveStreamQuery(tvBox = false, form = "tablet", target = false, shared = false))
        assertEquals("?controller=1", liveStreamQuery(tvBox = false, form = null, target = false, shared = false))
    }

    @Test
    fun `each device's icon - what it says it is, else its kind`() {
        assertEquals(DeviceIcon.FireTv, deviceIcon("tv", "firetv"))
        assertEquals(DeviceIcon.Tablet, deviceIcon("phone", "tablet"))
        assertEquals(DeviceIcon.Tv, deviceIcon("tv", null))
        assertEquals(DeviceIcon.Tv, deviceIcon("kodi", null))
        assertEquals(DeviceIcon.Computer, deviceIcon("web", null))
        assertEquals(DeviceIcon.Phone, deviceIcon("phone", null)) // an older app on a tablet
        assertEquals(DeviceIcon.Tv, deviceIcon("tv", "toaster")) // something new from a later app: by its kind
        assertEquals("firetv", parseTarget("""{"id":"t","kind":"tv","name":"Fire TV Stick 4K","form":"firetv"}""").form)
        assertNull(parseTarget("""{"id":"t","kind":"tv","name":"Shield"}""").form) // an older server
    }

    private fun parseTarget(json: String): RemoteTarget = Json { ignoreUnknownKeys = true }.decodeFromString(json)
}
