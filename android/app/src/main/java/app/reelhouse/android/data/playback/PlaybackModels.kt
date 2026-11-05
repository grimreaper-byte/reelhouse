package app.reelhouse.android.data.playback

import app.reelhouse.android.data.model.Item
import kotlinx.serialization.Serializable

/** POST /api/playback/:id */
@Serializable
data class PlaybackRequest(
    val caps: Caps,
    val quality: String,
    val audioIndex: Int? = null,
    val burnSubtitle: Int? = null,
    val forceTranscode: Boolean = false,
    /** The conversion this one replaces; the server stops it. */
    val previousSession: String? = null,
)

@Serializable
data class AudioTrack(
    val index: Int,
    val codec: String? = null,
    val channels: Int? = null,
    val language: String? = null,
    val title: String? = null,
    val isDefault: Boolean = false,
)

@Serializable
data class SubtitleTrack(
    val id: String, // s<stream index> for subtitles in the file, x<n> for files next to it
    val streamIndex: Int? = null,
    val language: String? = null,
    val title: String? = null,
    val codec: String? = null,
    val forced: Boolean = false,
    val isDefault: Boolean = false,
    val external: Boolean = false,
    val kind: String = "text", // text (WebVTT at url) | image (only burned in) | unsupported
    val url: String? = null,
)

@Serializable
data class PlaybackVideo(val codec: String? = null, val width: Int? = null, val height: Int? = null, val hdr: String? = null)

/** The server's decision: play the file as it is ("direct") or a conversion ("hls"), and what's in it. */
@Serializable
data class PlaybackInfo(
    val playId: String,
    val mode: String, // direct | hls
    val url: String,
    val sessionId: String? = null,
    val reasons: List<String> = emptyList(),
    val quality: String = "original",
    /** The qualities worth offering for this file: the original and the presets below it (empty: older servers). */
    val qualities: List<String> = emptyList(),
    val duration: Double? = null,
    val audioIndex: Int? = null,
    val burnSubtitle: Int? = null,
    val audioTracks: List<AudioTrack> = emptyList(),
    val subtitleTracks: List<SubtitleTrack> = emptyList(),
    val video: PlaybackVideo? = null,
    /** The file's chapters, in seconds (empty when it has none, or from older servers). */
    val chapters: List<Chapter> = emptyList(),
    val next: Item? = null,
    val prev: Item? = null,
) {
    val converted get() = mode == "hls"
}

@Serializable
data class Chapter(val start: Double, val end: Double? = null, val title: String? = null)

@Serializable
data class Quality(val id: String, val label: String, val height: Int? = null, val bitrate: Int? = null)

@Serializable
data class QualitiesResponse(val qualities: List<Quality> = emptyList())

/** POST /api/progress states. */
enum class PlayState(val wire: String) { Playing("playing"), Paused("paused"), Stopped("stopped"), Ended("ended") }
