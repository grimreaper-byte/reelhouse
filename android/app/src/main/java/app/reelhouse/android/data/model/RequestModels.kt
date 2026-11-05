package app.reelhouse.android.data.model

import kotlinx.serialization.Serializable

/** Requested films for the sidebar, from GET /api/me: how many there are, and whether films can be asked for (TMDB is set up). */
@Serializable
data class RequestsAccess(val count: Int = 0, val available: Boolean = false)

/** A film someone asked for (server/requests.js): its poster through Reelhouse, who asked and when (ms). */
@Serializable
data class FilmRequest(
    val id: Long,
    val tmdbId: Long,
    val title: String,
    val year: Int? = null,
    val poster: String? = null,
    val overview: String? = null,
    val requestedAt: Long,
    val user: User,
    /** Your own, or any for an admin. */
    val canRemove: Boolean = false,
)

/** GET /api/requests */
@Serializable
data class RequestsResponse(val available: Boolean = false, val requests: List<FilmRequest> = emptyList())

/** Who already asked for a film found in a search. */
@Serializable
data class RequestedBy(val id: Long, val username: String, val mine: Boolean = false)

/** A film found on TMDB to ask for: already on the server (the item to open), already asked for, or neither. */
@Serializable
data class FilmResult(
    val tmdbId: Long,
    val title: String,
    val year: Int? = null,
    val poster: String? = null,
    val overview: String? = null,
    val onServer: Long? = null,
    val request: RequestedBy? = null,
)

/** GET /api/requests/search */
@Serializable
data class FilmSearchResponse(val results: List<FilmResult> = emptyList())

/** POST /api/requests */
@Serializable
data class RequestResponse(val request: FilmRequest)

/** DELETE /api/requests (admins) */
@Serializable
data class RemovedResponse(val removed: Int = 0)
