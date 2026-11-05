package app.reelhouse.android.data.playback

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import kotlin.math.abs

/**
 * A manual picture and sound adjustment for this phone, in milliseconds: how much later the sound should come than
 * the picture (negative: earlier). Normally 0: [PictureTiming] measures and makes up for the phone's own picture
 * delay by itself; this is only a fine-tune on top.
 *
 * Both are applied in the player by moving its clock, which is the sound's position: the picture and subtitles
 * follow the clock, so nothing has to be converted (unlike the web player's audio delay).
 */
object AvSync {
    const val MAX_MS = 1000

    fun clamp(ms: Int): Int = ms.coerceIn(-MAX_MS, MAX_MS)

    /** The player's clock for the sound's own position [audioUs] (left alone when the sink doesn't know it yet). */
    @OptIn(UnstableApi::class)
    fun clockUs(audioUs: Long, offsetUs: Long): Long =
        if (audioUs == AudioSink.CURRENT_POSITION_NOT_SET) audioUs else audioUs + offsetUs

    /** "0 ms", "+40 ms · sound later", "−40 ms · sound earlier". */
    fun label(ms: Int): String = when {
        ms > 0 -> "+$ms ms · sound later"
        ms < 0 -> "−${-ms} ms · sound earlier"
        else -> "0 ms"
    }
}

/**
 * Measures how late this phone shows the picture, and how much the player makes up for it.
 *
 * The player hands each frame to Android in time for the moment its sound plays, but some phones add a delay of
 * their own on the way to the screen, so the sound comes first. Android reports when each frame really reached the
 * screen ([onFrameShown]); at that moment the player's clock should have been at the frame's time, and the
 * difference is that delay. The clock is then run that much ahead ([compensationUs]), so frames go out that much
 * earlier. The clock read here already includes the compensation, so what's measured stays the phone's own delay
 * rather than what's left of it, and the figure doesn't chase itself.
 *
 * The figure is the median of the last 10 seconds or so of frames, moves in small steps, and stays between 0 and
 * [MAX_US]: a phone that shows frames on time (or reports nothing useful) gets no change.
 */
class PictureTiming(startUs: Long = 0) {
    /** What's made up for now, in µs (read by the audio sink for every position, and by the screen). */
    @Volatile
    var compensationUs: Long = startUs.coerceIn(0, MAX_US)
        private set

    /** The phone's delay as last measured (µs), or null before there are enough frames. */
    @Volatile
    var measuredUs: Long? = null
        private set

    // The player's clock as last read, and when (System.nanoTime). Only touched on the player's thread.
    private var clockUs = C.TIME_UNSET
    private var clockAtNs = 0L
    private var playingSinceNs = -1L
    private val samples = LongArray(WINDOW)
    private var count = 0
    private var next = 0
    private var sinceUpdate = 0

    /** The clock the player keeps time by was [clockUs] at [atNs]. */
    @OptIn(UnstableApi::class)
    fun onClock(clockUs: Long, atNs: Long) {
        if (clockUs == AudioSink.CURRENT_POSITION_NOT_SET) return
        this.clockUs = clockUs
        clockAtNs = atNs
    }

    /** Playback started or stopped (a pause, a seek, a new item): frames shown right after are left out. */
    fun onPlaying(playing: Boolean, nowNs: Long) {
        playingSinceNs = if (playing) nowNs else -1
        if (!playing) clockUs = C.TIME_UNSET
    }

    /** The frame for [ptsUs] (the player's timeline) reached the screen at [shownNs] (System.nanoTime). */
    fun onFrameShown(ptsUs: Long, shownNs: Long) {
        if (playingSinceNs < 0 || clockUs == C.TIME_UNSET) return
        // Right after starting (or a seek), the first frame is shown at once whatever the clock says.
        if (shownNs - playingSinceNs < SETTLE_NS) return
        val ageNs = shownNs - clockAtNs
        if (abs(ageNs) > MAX_CLOCK_AGE_NS) return
        val lateUs = clockUs + ageNs / 1000 - ptsUs
        if (lateUs < -MAX_US || lateUs > 2 * MAX_US) return // not a timing figure (a jump, a dropped stretch)
        samples[next] = lateUs
        next = (next + 1) % WINDOW
        if (count < WINDOW) count++
        if (++sinceUpdate >= UPDATE_EVERY && count >= MIN_SAMPLES) {
            sinceUpdate = 0
            update(median())
        }
    }

    private fun median(): Long {
        val sorted = samples.copyOf(count).also { it.sort() }
        return sorted[count / 2]
    }

    private fun update(delayUs: Long) {
        measuredUs = delayUs
        val target = delayUs.coerceIn(0, MAX_US)
        val diff = target - compensationUs
        if (abs(diff) < DEADBAND_US) return
        // Small steps: a jump forwards skips a little picture, backwards holds it for a moment.
        compensationUs += diff.coerceIn(-STEP_US, STEP_US)
    }

    companion object {
        const val MAX_US = 250_000L
        // Frames reach the screen on display refreshes, so single frames vary by a refresh or so: the median of
        // about 10 s of frames, updated every 2 s, ignoring differences under 8 ms, keeps the figure from wandering.
        private const val WINDOW = 240
        private const val MIN_SAMPLES = 96
        private const val UPDATE_EVERY = 48
        private const val DEADBAND_US = 8_000L
        const val STEP_US = 15_000L
        private const val SETTLE_NS = 1_000_000_000L
        private const val MAX_CLOCK_AGE_NS = 200_000_000L
    }
}

/**
 * The phone's audio output with the picture timing applied to the position it reports, which is what the player
 * keeps time by: [offsetUs] runs the clock ahead (the picture earlier), and the clock is passed to [timing].
 */
@OptIn(UnstableApi::class)
class SyncedAudioSink(
    sink: AudioSink,
    private val timing: PictureTiming,
    private val offsetUs: () -> Long,
) : ForwardingAudioSink(sink) {
    override fun getCurrentPositionUs(sourceEnded: Boolean): Long {
        val us = AvSync.clockUs(super.getCurrentPositionUs(sourceEnded), offsetUs())
        timing.onClock(us, System.nanoTime())
        return us
    }

    override fun play() {
        super.play()
        timing.onPlaying(true, System.nanoTime())
    }

    override fun pause() {
        timing.onPlaying(false, System.nanoTime())
        super.pause()
    }

    override fun flush() {
        timing.onPlaying(false, System.nanoTime())
        super.flush()
    }

    override fun reset() {
        timing.onPlaying(false, System.nanoTime())
        super.reset()
    }
}
