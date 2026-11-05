package app.reelhouse.android.data.playback

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.mediacodec.MediaCodecAdapter
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.video.MediaCodecVideoRenderer
import androidx.media3.exoplayer.video.VideoRendererEventListener

/**
 * Media3's video renderer, plus Android's reports of when each frame really reached the screen, passed to [timing].
 * (Media3 only asks for those reports when tunneling, which this app doesn't use.)
 */
@OptIn(UnstableApi::class)
class TimedVideoRenderer(builder: MediaCodecVideoRenderer.Builder, private val timing: PictureTiming) : MediaCodecVideoRenderer(builder) {
    override fun onCodecInitialized(name: String, configuration: MediaCodecAdapter.Configuration, initializedTimestampMs: Long, initializationDurationMs: Long) {
        super.onCodecInitialized(name, configuration, initializedTimestampMs, initializationDurationMs)
        val codec = codec ?: return
        val looper = Looper.myLooper() ?: return
        // On the player's thread, like the audio sink's clock readings.
        runCatching {
            codec.setOnFrameRenderedListener({ _, presentationTimeUs, nanoTime -> timing.onFrameShown(presentationTimeUs, nanoTime) }, Handler(looper))
        }
    }
}

/**
 * Media3's renderers with picture timing: the video renderer reports when frames reach the screen, and the audio
 * output's position (the player's clock) is moved by the measured delay plus [manualUs].
 */
@OptIn(UnstableApi::class)
class TimedRenderersFactory(
    context: Context,
    private val timing: PictureTiming,
    private val manualUs: () -> Long,
) : DefaultRenderersFactory(context) {
    override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink? =
        super.buildAudioSink(context, enableFloatOutput, enableAudioTrackPlaybackParams)
            ?.let { SyncedAudioSink(it, timing) { timing.compensationUs + manualUs() } }

    override fun buildVideoRenderers(
        context: Context,
        extensionRendererMode: Int,
        mediaCodecSelector: MediaCodecSelector,
        enableDecoderFallback: Boolean,
        eventHandler: Handler,
        eventListener: VideoRendererEventListener,
        allowedVideoJoiningTimeMs: Long,
        out: ArrayList<Renderer>,
    ) {
        super.buildVideoRenderers(context, extensionRendererMode, mediaCodecSelector, enableDecoderFallback, eventHandler, eventListener, allowedVideoJoiningTimeMs, out)
        // The same settings DefaultRenderersFactory gives its own (its other ones are Builder defaults too).
        val i = out.indexOfFirst { it is MediaCodecVideoRenderer }
        if (i < 0) return
        out[i] = TimedVideoRenderer(
            MediaCodecVideoRenderer.Builder(context)
                .setCodecAdapterFactory(codecAdapterFactory)
                .setMediaCodecSelector(mediaCodecSelector)
                .setAllowedJoiningTimeMs(allowedVideoJoiningTimeMs)
                .setEnableDecoderFallback(enableDecoderFallback)
                .setEventHandler(eventHandler)
                .setEventListener(eventListener)
                .setMaxDroppedFramesToNotify(MAX_DROPPED_VIDEO_FRAME_COUNT_TO_NOTIFY),
            timing,
        )
    }
}
