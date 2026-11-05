package app.reelhouse.android.data.playback

import androidx.media3.exoplayer.audio.AudioSink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AvSyncTest {
    @Test
    fun `running the clock ahead brings the picture forward`() {
        // The player shows a frame once its clock reaches the frame's time: 40 ms ahead means 40 ms earlier.
        assertEquals(10_040_000L, AvSync.clockUs(10_000_000L, 40_000))
        assertEquals(9_960_000L, AvSync.clockUs(10_000_000L, -40_000))
        assertEquals(AudioSink.CURRENT_POSITION_NOT_SET, AvSync.clockUs(AudioSink.CURRENT_POSITION_NOT_SET, 40_000))
    }

    @Test
    fun `the fine-tune stays within a second either way and reads in the viewer's terms`() {
        assertEquals(1000, AvSync.clamp(1500))
        assertEquals(-1000, AvSync.clamp(-2000))
        assertEquals("+40 ms · sound later", AvSync.label(40))
        assertEquals("−60 ms · sound earlier", AvSync.label(-60))
        assertEquals("0 ms", AvSync.label(0))
    }

    /**
     * A phone that puts each frame on screen [delayMs] after the player meant it to, playing 24 fps for [seconds].
     * The sound plays from [startNs]; the player's clock is the sound's position plus the compensation so far, and
     * (as in the player, which reads it every few milliseconds) it was read just before each frame is reported.
     */
    private fun play(timing: PictureTiming, delayMs: Long, seconds: Int, jitterMs: Long = 0, startNs: Long = 1_000_000_000_000L) {
        timing.onPlaying(true, startNs)
        val frameUs = 41_708L
        for (n in 0 until seconds * 24) {
            val ptsUs = n * frameUs
            // The clock reaches the frame's time when the sound is at ptsUs - compensation (the clock runs ahead).
            val dueNs = startNs + (ptsUs - timing.compensationUs) * 1000
            val jitter = if (jitterMs == 0L) 0 else ((n % 5) - 2) * jitterMs / 2
            val shownNs = dueNs + (delayMs + jitter) * 1_000_000
            timing.onClock((shownNs - startNs) / 1000 + timing.compensationUs, shownNs)
            timing.onFrameShown(ptsUs, shownNs)
        }
    }

    @Test
    fun `a phone that shows the picture late is measured and made up for, in small steps`() {
        val timing = PictureTiming()
        // The first second after starting is left out each time, and it takes 4 s of frames to measure.
        play(timing, delayMs = 60, seconds = 4) // 3 s counted
        assertNull(timing.measuredUs)
        play(timing, delayMs = 60, seconds = 2) // 1 s more: 4 s
        assertEquals(60_000L, timing.measuredUs)
        assertEquals(PictureTiming.STEP_US, timing.compensationUs) // one step so far
        play(timing, delayMs = 60, seconds = 20)
        assertEquals(60_000L, timing.compensationUs)
        // What's measured stays the phone's delay once it's made up for, so it doesn't wander off.
        play(timing, delayMs = 60, seconds = 30, jitterMs = 8)
        assertEquals(60_000L, timing.compensationUs)
    }

    @Test
    fun `a phone that shows the picture on time, or early, gets nothing, and so do the first second and pauses`() {
        val onTime = PictureTiming()
        play(onTime, delayMs = 0, seconds = 10, jitterMs = 8)
        assertEquals(0L, onTime.compensationUs)
        val early = PictureTiming()
        play(early, delayMs = -15, seconds = 10)
        assertEquals(0L, early.compensationUs)

        val paused = PictureTiming()
        paused.onPlaying(true, 0)
        paused.onPlaying(false, 1)
        for (n in 0 until 500) {
            paused.onClock(n * 41_708L, 2_000_000_000L + n * 41_708_000L)
            paused.onFrameShown(n * 41_708L, 2_000_000_000L + n * 41_708_000L + 80_000_000)
        }
        assertNull(paused.measuredUs)

        val settling = PictureTiming()
        play(settling, delayMs = 60, seconds = 1)
        assertNull(settling.measuredUs)
    }

    @Test
    fun `a delay measured before carries over, within limits`() {
        assertEquals(40_000L, PictureTiming(40_000).compensationUs)
        assertEquals(PictureTiming.MAX_US, PictureTiming(5_000_000).compensationUs)
        assertEquals(0L, PictureTiming(-1).compensationUs)
        // And a phone whose delay is beyond what's made up for gets the most.
        val slow = PictureTiming()
        play(slow, delayMs = 400, seconds = 40)
        assertEquals(PictureTiming.MAX_US, slow.compensationUs)
    }
}
