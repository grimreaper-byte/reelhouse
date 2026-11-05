package app.reelhouse.android.data.playback

import android.media.MediaCodecInfo.CodecProfileLevel
import android.media.MediaCodecList
import android.media.MediaFormat
import kotlinx.serialization.Serializable

/**
 * What this phone can play itself, in the names Reelhouse's playback decision uses (server/transcode/profile.js).
 * Anything else is converted by the server.
 */
@Serializable
data class Caps(
    val containers: List<String>,
    val video: List<String>,
    val audio: List<String>,
    /** Media3 undoes Matroska header compression, but not every encoding: let the server convert those few files. */
    val mkvContentEncoding: Boolean = false,
    val mse: Boolean = true,
    val nativeHls: Boolean = true,
)

/** One decoder the phone has: a MIME type and the profiles it supports. */
data class Decoder(val mime: String, val profiles: Set<Int> = emptySet())

object DeviceCaps {
    /**
     * Containers Media3 reads well (Reelhouse calls MOV "mp4", and MPEG-2 transport streams "ts"). Not AVI: Media3
     * spaces AVI chunks evenly in time, and files with VirtualDub's usual 0.5 s of sound up front then play their
     * sound half a second ahead of the picture, so the server converts them.
     */
    val CONTAINERS = listOf("mp4", "mkv", "webm", "ts", "flv", "mpeg")

    /** Audio Media3 decodes on every phone, without a hardware decoder. */
    private val ALWAYS_AUDIO = listOf("aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le")

    /** The capabilities for a list of decoders (pure, so it can be tested off the phone). */
    fun from(decoders: List<Decoder>): Caps {
        fun has(mime: String) = decoders.any { it.mime.equals(mime, ignoreCase = true) }
        fun hasProfile(mime: String, vararg profiles: Int) =
            decoders.any { it.mime.equals(mime, ignoreCase = true) && it.profiles.any { p -> p in profiles } }

        val video = buildList {
            if (has(MediaFormat.MIMETYPE_VIDEO_AVC)) add("h264")
            if (hasProfile(MediaFormat.MIMETYPE_VIDEO_AVC, CodecProfileLevel.AVCProfileHigh10)) add("h264-hi")
            if (has(MediaFormat.MIMETYPE_VIDEO_HEVC)) add("hevc")
            if (hasProfile(MediaFormat.MIMETYPE_VIDEO_HEVC, CodecProfileLevel.HEVCProfileMain10, CodecProfileLevel.HEVCProfileMain10HDR10, CodecProfileLevel.HEVCProfileMain10HDR10Plus)) add("hevc10")
            if (has(MediaFormat.MIMETYPE_VIDEO_AV1)) add("av1")
            if (hasProfile(MediaFormat.MIMETYPE_VIDEO_AV1, CodecProfileLevel.AV1ProfileMain10, CodecProfileLevel.AV1ProfileMain10HDR10, CodecProfileLevel.AV1ProfileMain10HDR10Plus)) add("av1-10")
            if (has(MediaFormat.MIMETYPE_VIDEO_VP9)) add("vp9")
            if (has(MediaFormat.MIMETYPE_VIDEO_VP8)) add("vp8")
            if (has(MediaFormat.MIMETYPE_VIDEO_MPEG2)) add("mpeg2video")
            // Simple Profile. XviD/DivX (Advanced Simple, "mpeg4-asp") isn't claimed: Android's decoder can't, and
            // Media3 reads AVI B-frames in file order.
            if (has(MediaFormat.MIMETYPE_VIDEO_MPEG4)) add("mpeg4")
        }
        val audio = buildList {
            addAll(ALWAYS_AUDIO)
            if (has(MediaFormat.MIMETYPE_AUDIO_AC3)) add("ac3")
            if (has(MediaFormat.MIMETYPE_AUDIO_EAC3)) add("eac3")
            if (has("audio/vnd.dts")) add("dts")
            if (has("audio/true-hd")) add("truehd")
            if (has("audio/mpeg-L2")) add("mp2")
        }
        return Caps(containers = CONTAINERS, video = video, audio = audio)
    }

    /** This phone's capabilities (worked out once). */
    val current: Caps by lazy { from(installedDecoders()) }

    private fun installedDecoders(): List<Decoder> =
        MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }.flatMap { info ->
            info.supportedTypes.map { mime ->
                val profiles = runCatching { info.getCapabilitiesForType(mime).profileLevels.map { it.profile }.toSet() }.getOrDefault(emptySet())
                Decoder(mime, profiles)
            }
        }

    /** Whether a decoder on this phone takes video of this codec and size (a 4K file may be too big for some). */
    fun canDecode(codec: String?, width: Int?, height: Int?): Boolean {
        val mime = when (codec) {
            "h264" -> MediaFormat.MIMETYPE_VIDEO_AVC
            "hevc" -> MediaFormat.MIMETYPE_VIDEO_HEVC
            "av1" -> MediaFormat.MIMETYPE_VIDEO_AV1
            "vp9" -> MediaFormat.MIMETYPE_VIDEO_VP9
            "vp8" -> MediaFormat.MIMETYPE_VIDEO_VP8
            "mpeg2video" -> MediaFormat.MIMETYPE_VIDEO_MPEG2
            "mpeg4" -> MediaFormat.MIMETYPE_VIDEO_MPEG4
            else -> return true // unknown here: let the player try
        }
        if (width == null || height == null || width <= 0 || height <= 0) return true
        return runCatching {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(MediaFormat.createVideoFormat(mime, width, height)) != null
        }.getOrDefault(true)
    }
}
