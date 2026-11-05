package app.reelhouse.android.data.playback

import android.media.MediaCodecInfo.CodecProfileLevel
import app.reelhouse.android.data.AppJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceCapsTest {
    @Test
    fun `a typical phone plays H264 and HEVC but leaves AC3 to the server`() {
        val caps = DeviceCaps.from(
            listOf(
                Decoder("video/avc", setOf(CodecProfileLevel.AVCProfileHigh)),
                Decoder("video/hevc", setOf(CodecProfileLevel.HEVCProfileMain, CodecProfileLevel.HEVCProfileMain10)),
                Decoder("video/x-vnd.on2.vp9"),
                Decoder("audio/mp4a-latm"),
            ),
        )
        assertEquals(listOf("h264", "hevc", "hevc10", "vp9"), caps.video)
        assertTrue("aac" in caps.audio && "opus" in caps.audio && "flac" in caps.audio)
        assertFalse("ac3" in caps.audio)
        assertTrue("mkv" in caps.containers && "mp4" in caps.containers)
        assertFalse("asf" in caps.containers) // Media3 can't read WMV/ASF
        assertFalse("avi" in caps.containers) // Media3 times AVI sound wrongly (half a second ahead): converted
    }

    @Test
    fun `10-bit and Dolby decoders count only when the phone has them`() {
        val caps = DeviceCaps.from(
            listOf(
                Decoder("video/avc", setOf(CodecProfileLevel.AVCProfileHigh10)),
                Decoder("video/hevc", setOf(CodecProfileLevel.HEVCProfileMain)),
                Decoder("video/av01", setOf(CodecProfileLevel.AV1ProfileMain10)),
                Decoder("audio/ac3"),
                Decoder("audio/eac3"),
            ),
        )
        assertEquals(listOf("h264", "h264-hi", "hevc", "av1", "av1-10"), caps.video)
        assertTrue("ac3" in caps.audio && "eac3" in caps.audio)
        assertFalse("dts" in caps.audio)
    }

    @Test
    fun `what's sent matches the server's field names`() {
        val json = AppJson.encodeToString(Caps.serializer(), DeviceCaps.from(emptyList()))
        for (key in listOf("\"containers\"", "\"video\"", "\"audio\"", "\"mkvContentEncoding\":false")) assertTrue(json, key in json)
    }

    @Test
    fun `the server's decisions decode, direct and converted`() {
        fun fixture(name: String) = javaClass.getResource("/fixtures/$name")!!.readText()
        val direct = AppJson.decodeFromString(PlaybackInfo.serializer(), fixture("playback-direct.json"))
        assertFalse(direct.converted)
        assertTrue(direct.url.startsWith("/api/stream/"))
        assertTrue(direct.subtitleTracks.single().external)

        val hls = AppJson.decodeFromString(PlaybackInfo.serializer(), fixture("playback-hls.json"))
        assertTrue(hls.converted)
        assertTrue(hls.url.endsWith("index.m3u8"))
        assertEquals(hls.sessionId, hls.playId)
        assertEquals(2, hls.audioTracks.size)
        assertTrue(hls.reasons.any { "ac3" in it })
        assertEquals("text", hls.subtitleTracks.single().kind)
    }
}
