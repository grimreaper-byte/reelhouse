// What Reelhouse's API returns (server/routes/*.js). Unknown fields are ignored, missing ones get defaults, so
// newer and older servers both work.
package app.reelhouse.android.data.model

import kotlinx.serialization.Serializable

@Serializable
data class NetworkInfo(
    val ip: String? = null,
    val local: Boolean = false,
    val wireguard: Boolean = false,
    val tunnel: Boolean = false,
)

/** GET /api/server (no sign-in needed): also how the app checks that an address reaches Reelhouse. */
@Serializable
data class ServerInfo(
    /** Stable for a Reelhouse install (older servers don't send it), so the app knows it found the right one. */
    val id: String? = null,
    val name: String = "Reelhouse",
    val version: String = "",
    val setupRequired: Boolean = false,
    val network: NetworkInfo? = null,
)

@Serializable
data class User(
    val id: Long,
    val username: String,
    val isAdmin: Boolean = false,
    /** Their picture's address on Reelhouse (it changes with the picture), or null. */
    val avatar: String? = null,
)

/** PUT/DELETE /api/me/avatar */
@Serializable
data class UserResponse(val user: User)

/** Tunnel settings as the pairing QR code, POST /api/auth/pair and GET /api/me/tunnel give them. */
@Serializable
data class TunnelSettings(
    val endpoint: String = "",
    val publicKey: String = "",
    val privateKey: String? = null, // only in a pairing QR code
    val presharedKey: String? = null,
    val address: String = "",
    val url: String = "",
)

@Serializable
data class ServerName(val name: String = "Reelhouse", val version: String = "")

/** POST /api/auth/pair and POST /api/auth/device. */
@Serializable
data class SignInResponse(
    val token: String,
    val user: User,
    val tunnel: TunnelSettings? = null,
    val server: ServerName? = null,
)

@Serializable
data class Defaults(val remoteQuality: String = "4m-720", val allowDownloads: Boolean = true)

/** GET /api/me */
/** The Android app Reelhouse offers at /android/<fileName>. */
@Serializable
data class AppRelease(val versionName: String, val versionCode: Int, val size: Long = 0, val fileName: String)

@Serializable
data class MeResponse(
    val user: User,
    val network: NetworkInfo? = null,
    val defaults: Defaults = Defaults(),
    val androidApp: AppRelease? = null,
    val liveTv: LiveTvAccess = LiveTvAccess(),
    val requests: RequestsAccess = RequestsAccess(),
)

/** GET /api/me/tunnel */
@Serializable
data class TunnelResponse(val tunnel: TunnelSettings? = null)

@Serializable
data class Library(
    val id: Long,
    val name: String,
    val type: String, // movie | show
    val icon: String? = null, // the one picked in Settings → Libraries (see LibraryIcons); none from older servers
    val count: Int = 0,
    val scannedAt: Long? = null,
)

@Serializable
data class Images(val poster: String? = null, val backdrop: String? = null, val thumb: String? = null)

@Serializable
data class ItemState(
    val position: Double = 0.0, // seconds
    val watched: Boolean = false,
    val viewCount: Int = 0,
    val lastViewedAt: Long? = null,
)

@Serializable
data class ShowRef(val id: Long, val title: String, val poster: String? = null)

@Serializable
data class CastMember(val name: String, val role: String? = null, val profile: String? = null)

/** A movie, show, season or episode (serializeItem in server/items.js). */
@Serializable
data class Item(
    val id: Long = 0, // none on a channel
    val libraryId: Long? = null,
    val type: String, // movie | show | season | episode | channel (Continue Watching)
    val title: String,
    val year: Int? = null,
    val parentId: Long? = null,
    val showId: Long? = null,
    val seasonNumber: Int? = null,
    val episodeNumber: Int? = null,
    val episodeEnd: Int? = null,
    val airDate: String? = null,
    val rating: Double? = null,
    val contentRating: String? = null,
    val duration: Double? = null, // seconds
    val addedAt: Long? = null,
    val images: Images = Images(),
    val state: ItemState = ItemState(),
    val videoResolution: String? = null,
    val leafCount: Int? = null,
    val viewedLeafCount: Int? = null,
    val childCount: Int? = null,
    val overview: String? = null,
    val show: ShowRef? = null,
    val newCount: Int? = null,
    /** Continue Watching, when Settings → Live TV shows channels there: nothing else of this item says anything. */
    val channel: Channel? = null,
    // Only on detail pages (full = true):
    val originalTitle: String? = null,
    val tagline: String? = null,
    val genres: List<String> = emptyList(),
    val cast: List<CastMember> = emptyList(),
    val directors: List<String> = emptyList(),
    val studio: String? = null,
    /** The file's streams, on movie and episode detail pages. */
    val media: MediaInfo? = null,
    /** A film with more than one copy (an SD and an HD file): each copy, best first (server/versions.js). */
    val versions: List<Version> = emptyList(),
    /** Set on one of a film's other copies: the film (its best copy). */
    val versionOf: Long? = null,
    /** In "More with <actor>" rows and on a person's page: the part they played. */
    val role: String? = null,
    /** On a person's page: they directed it. */
    val directed: Boolean = false,
    /** In Home's "Watched by Others" row: who (most recent first) and when (ms since 1970). */
    val watchedBy: List<String> = emptyList(),
    val watchedAt: Long? = null,
) {
    /** 0..1 of the way through, for a progress bar; 0 when unstarted or finished. */
    val progress: Float
        get() {
            val d = duration ?: return 0f
            if (d <= 0 || state.watched) return 0f
            return (state.position / d).toFloat().coerceIn(0f, 1f)
        }

    /** "S2 · E5" for episodes. */
    val episodeLabel: String?
        get() = if (type == "episode" && seasonNumber != null && episodeNumber != null) {
            "S$seasonNumber · E$episodeNumber" + (episodeEnd?.let { "–$it" } ?: "")
        } else null
}

@Serializable
data class Hub(
    val id: String,
    val title: String,
    val style: String = "poster", // poster | landscape
    val libraryId: Long? = null,
    val items: List<Item> = emptyList(),
)

/** GET /api/hubs/home */
@Serializable
data class HomeResponse(val hubs: List<Hub> = emptyList(), val libraries: List<Library> = emptyList())

@Serializable
data class ErrorBody(val error: String? = null)

// ---------- browsing ----------

/** GET /api/libraries */
@Serializable
data class LibrariesResponse(val libraries: List<Library> = emptyList())

/** GET /api/libraries/:id/items */
@Serializable
data class LibraryItemsResponse(val library: Library, val items: List<Item> = emptyList())

@Serializable
data class Genre(val genre: String, val n: Int = 0)

/** GET /api/libraries/:id/genres */
@Serializable
data class GenresResponse(val genres: List<Genre> = emptyList())

@Serializable
data class VideoInfo(
    val codec: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val bitDepth: Int? = null,
    val hdr: String? = null,
    val profile: String? = null,
)

@Serializable
data class AudioInfo(
    val index: Int? = null,
    val codec: String? = null,
    val channels: Int? = null,
    val language: String? = null,
    val title: String? = null,
    val isDefault: Boolean = false,
)

@Serializable
data class SubtitleInfo(
    val index: Int? = null,
    val codec: String? = null,
    val language: String? = null,
    val title: String? = null,
    val forced: Boolean = false,
    val format: String? = null, // sidecar files
)

@Serializable
data class MediaInfo(
    val container: String? = null,
    val duration: Double? = null,
    val bitrate: Long? = null,
    val fileSize: Long? = null,
    val video: VideoInfo? = null,
    val audio: List<AudioInfo> = emptyList(),
    val subtitles: List<SubtitleInfo> = emptyList(),
    val external: List<SubtitleInfo> = emptyList(),
)

/** One copy of a film that has more than one; Play plays the first (the best). */
@Serializable
data class Version(
    val id: Long,
    val label: String, // SD, 720p, 1080p, 4K…
    val width: Int? = null,
    val height: Int? = null,
    val videoCodec: String? = null,
    val audioCodec: String? = null,
    val container: String? = null,
    val duration: Double? = null,
    val bitrate: Long? = null,
    val fileSize: Long? = null,
    val media: MediaInfo? = null,
)

@Serializable
data class SeasonRef(val id: Long, val title: String, val seasonNumber: Int? = null)

/** GET /api/items/:id — the item plus what its page shows around it. */
@Serializable
data class ItemDetails(
    val item: Item,
    val children: List<Item> = emptyList(), // a show's seasons, a season's episodes
    val onDeck: Item? = null, // the next episode to watch
    val show: Item? = null,
    val season: Item? = null,
    val seasons: List<SeasonRef> = emptyList(), // a season's siblings
    val prev: Item? = null,
    val next: Item? = null,
)

@Serializable
data class CastRow(val name: String, val profile: String? = null, val items: List<Item> = emptyList())

/** GET /api/items/:id/related */
@Serializable
data class Related(val similar: List<Item> = emptyList(), val byCast: List<CastRow> = emptyList())

/** A movie someone has been in that isn't on the server (from TMDB; nothing to open). */
@Serializable
data class OtherMovie(val tmdbId: Long, val title: String, val year: Int? = null, val role: String? = null, val poster: String? = null)

/**
 * Their movies that aren't on the server. [status]: "ok", "off" (the server has no TMDB key), "unknown" (TMDB
 * doesn't know them) or "failed" (TMDB couldn't be asked).
 */
@Serializable
data class OtherMovies(val status: String = "off", val items: List<OtherMovie> = emptyList())

/** Who someone is, from TMDB (dates are YYYY-MM-DD; [age] is their age at death if they've died). */
@Serializable
data class PersonInfo(
    val biography: String? = null,
    val birthday: String? = null,
    val deathday: String? = null,
    val birthplace: String? = null,
    val age: Int? = null,
)

/** GET /api/people — a cast member's page: their titles on the server (newest first), then their other movies. */
@Serializable
data class PersonPage(
    val name: String,
    val profile: String? = null,
    val info: PersonInfo? = null,
    val items: List<Item> = emptyList(),
    val others: OtherMovies = OtherMovies(),
)

/** GET /api/search */
@Serializable
data class SearchResults(
    val movies: List<Item> = emptyList(),
    val shows: List<Item> = emptyList(),
    val episodes: List<Item> = emptyList(),
    val people: List<Item> = emptyList(), // titles matched by cast or director
) {
    val isEmpty get() = movies.isEmpty() && shows.isEmpty() && episodes.isEmpty() && people.isEmpty()
}
