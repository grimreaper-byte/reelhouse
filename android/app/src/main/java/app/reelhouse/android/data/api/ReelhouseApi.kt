package app.reelhouse.android.data.api

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.joinUrl
import app.reelhouse.android.data.model.Channel
import app.reelhouse.android.data.model.ChannelsResponse
import app.reelhouse.android.data.model.ErrorBody
import app.reelhouse.android.data.model.GuideResponse
import app.reelhouse.android.data.model.LivePlayInfo
import app.reelhouse.android.data.model.NowNext
import app.reelhouse.android.data.model.RecordResponse
import app.reelhouse.android.data.model.RecordingsResponse
import app.reelhouse.android.data.model.SeriesResponse
import app.reelhouse.android.data.model.DeletedRecordings
import app.reelhouse.android.data.model.FilmRequest
import app.reelhouse.android.data.model.FilmResult
import app.reelhouse.android.data.model.FilmSearchResponse
import app.reelhouse.android.data.model.RemovedResponse
import app.reelhouse.android.data.model.RequestResponse
import app.reelhouse.android.data.model.RequestsResponse
import app.reelhouse.android.data.model.Genre
import app.reelhouse.android.data.model.GenresResponse
import app.reelhouse.android.data.model.HomeResponse
import app.reelhouse.android.data.model.ItemDetails
import app.reelhouse.android.data.model.LibrariesResponse
import app.reelhouse.android.data.model.Library
import app.reelhouse.android.data.model.LibraryItemsResponse
import app.reelhouse.android.data.model.PersonPage
import app.reelhouse.android.data.model.Related
import app.reelhouse.android.data.model.SearchResults
import app.reelhouse.android.data.playback.PlayState
import app.reelhouse.android.data.playback.PlaybackInfo
import app.reelhouse.android.data.playback.PlaybackRequest
import app.reelhouse.android.data.playback.QualitiesResponse
import app.reelhouse.android.data.playback.Quality
import kotlinx.serialization.json.jsonObject
import app.reelhouse.android.data.model.MeResponse
import app.reelhouse.android.data.model.ServerInfo
import app.reelhouse.android.data.model.SignInResponse
import app.reelhouse.android.data.model.TunnelResponse
import app.reelhouse.android.data.model.TunnelSettings
import app.reelhouse.android.data.model.User
import app.reelhouse.android.data.model.UserResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * Reelhouse's API. Calls made before there's a route (checking an address, pairing, signing in) take the address
 * explicitly; the rest go to the current route's address from [base], signed in by the client's [TokenSource].
 */
class ReelhouseApi(
    private val client: OkHttpClient,
    private val base: () -> String?,
    private val onUnauthorized: () -> Unit = {},
) {
    // ---------- before a route exists ----------

    /** GET /api/server: answers without a sign-in, so it's also how an address is checked. */
    suspend fun serverInfo(base: String, timeoutMs: Long = 5000): ServerInfo =
        call("GET", joinUrl(base, "/api/server"), null, ServerInfo.serializer(), timeoutMs)

    suspend fun pair(base: String, code: String, device: String, publicKey: String?): SignInResponse =
        call("POST", joinUrl(base, "/api/auth/pair"), buildJsonObject {
            put("code", code)
            put("device", device)
            if (publicKey != null) put("publicKey", publicKey)
        }, SignInResponse.serializer(), 20_000)

    suspend fun signIn(base: String, username: String, password: String, device: String): SignInResponse =
        call("POST", joinUrl(base, "/api/auth/device"), buildJsonObject {
            put("username", username)
            put("password", password)
            put("device", device)
        }, SignInResponse.serializer(), 20_000)

    /** Ends this device's sign-in (the server drops its tunnel key too). Needs the token, since it may not be stored. */
    suspend fun logout(base: String, token: String) {
        val req = Request.Builder().url(joinUrl(base, "/api/auth/logout"))
            .header("Authorization", "Bearer $token")
            .post("{}".toRequestBody(JSON))
            .build()
        val call = client.newCall(req)
        call.timeout().timeout(8, TimeUnit.SECONDS)
        withContext(Dispatchers.IO) { call.await().close() }
    }

    // ---------- signed in, over the current route ----------

    suspend fun me(): MeResponse = get("/api/me", MeResponse.serializer())

    suspend fun tunnel(): TunnelSettings? = get("/api/me/tunnel", TunnelResponse.serializer()).tunnel

    // channels=1: this app knows what a channel in Continue Watching is (older ones are sent only titles).
    suspend fun home(): HomeResponse = get("/api/hubs/home?channels=1", HomeResponse.serializer())

    suspend fun libraries(): List<Library> = get("/api/libraries", LibrariesResponse.serializer()).libraries

    /** [sort]: title | year | added | rating | released | duration; [filter]: unwatched | watched | inprogress. */
    suspend fun libraryItems(id: Long, sort: String, descending: Boolean, filter: String?, genre: String?): LibraryItemsResponse {
        val q = buildList {
            add("sort=" + enc(sort))
            add("order=" + if (descending) "desc" else "asc")
            filter?.let { add("filter=" + enc(it)) }
            genre?.let { add("genre=" + enc(it)) }
        }.joinToString("&")
        return get("/api/libraries/$id/items?$q", LibraryItemsResponse.serializer())
    }

    suspend fun genres(libraryId: Long): List<Genre> = get("/api/libraries/$libraryId/genres", GenresResponse.serializer()).genres

    suspend fun item(id: Long): ItemDetails = get("/api/items/$id", ItemDetails.serializer())

    suspend fun related(id: Long): Related = get("/api/items/$id/related", Related.serializer())

    suspend fun search(query: String): SearchResults = get("/api/search?q=" + enc(query), SearchResults.serializer())

    /** A cast member's page; [fromItem] is the movie or show they were picked from (it tells same-named people apart). */
    suspend fun person(name: String, fromItem: Long?): PersonPage =
        get("/api/people?name=" + enc(name) + (fromItem?.let { "&item=$it" } ?: ""), PersonPage.serializer())

    /** Marks a movie or episode, or everything in a show or season, watched or unwatched. */
    suspend fun setWatched(id: Long, watched: Boolean) {
        val b = base() ?: throw OfflineException()
        call("POST", joinUrl(b, "/api/items/$id/watched"), buildJsonObject { put("watched", watched) }, JsonObject.serializer(), 20_000, signedIn = true)
    }

    // ---------- playback ----------

    /** Asks the server how to play an item on this phone; may start a conversion. */
    suspend fun playback(id: Long, request: PlaybackRequest): PlaybackInfo {
        val b = base() ?: throw OfflineException()
        val body = AppJson.encodeToJsonElement(PlaybackRequest.serializer(), request).jsonObject
        return call("POST", joinUrl(b, "/api/playback/$id"), body, PlaybackInfo.serializer(), 60_000, signedIn = true)
    }

    /** Reports the play position (resume point; "ended" marks it watched). */
    suspend fun progress(itemId: Long, position: Double, duration: Double?, state: PlayState, info: PlaybackInfo) =
        progress(itemId, position, duration, state.wire, info.playId, info.mode, info.quality)

    /**
     * The same, for plays without a server decision (a download played on the phone, reports sent later). [ageMs]:
     * how long ago a report sent late was made, so Reelhouse doesn't let it undo anything that happened since.
     */
    suspend fun progress(itemId: Long, position: Double, duration: Double?, state: String, playId: String?, mode: String, quality: String, ageMs: Long? = null) {
        val b = base() ?: throw OfflineException()
        call("POST", joinUrl(b, "/api/progress"), buildJsonObject {
            put("itemId", itemId)
            put("position", position)
            duration?.let { put("duration", it) }
            put("state", state)
            playId?.let { put("playId", it) }
            put("mode", mode)
            put("quality", quality)
            ageMs?.let { put("age", it.coerceAtLeast(0)) }
        }, JsonObject.serializer(), 10_000, signedIn = true)
    }

    /** Stops a conversion the app no longer needs. */
    suspend fun endSession(sessionId: String) {
        val b = base() ?: return
        call("DELETE", joinUrl(b, "/api/hls/$sessionId"), null, JsonObject.serializer(), 5_000, signedIn = true)
    }

    suspend fun qualities(): List<Quality> = get("/api/qualities", QualitiesResponse.serializer()).qualities

    // ---------- live TV (server/routes/livetv.js) ----------

    /** The guide for [from, to) in epoch seconds (the server rounds from down to the half hour; a day at most). */
    suspend fun guide(from: Long, to: Long): GuideResponse = get("/api/livetv/guide?from=$from&to=$to", GuideResponse.serializer())

    suspend fun channels(): List<Channel> = get("/api/livetv/channels", ChannelsResponse.serializer()).channels

    suspend fun nowAndNext(channel: String): NowNext = get("/api/livetv/channels/${enc(channel)}/now", NowNext.serializer())

    /**
     * Starts a channel for this phone. [previousSession]: the channel being changed from, stopped first so its tuner
     * is free (and the change doesn't count as a second stream).
     */
    suspend fun playLive(channel: String, quality: String, previousSession: String?): LivePlayInfo {
        val b = base() ?: throw OfflineException()
        return call("POST", joinUrl(b, "/api/livetv/play/${enc(channel)}"), buildJsonObject {
            put("quality", quality)
            previousSession?.let { put("previousSession", it) }
        }, LivePlayInfo.serializer(), 60_000, signedIn = true)
    }

    /** Whether a live stream's playlist has its first seconds yet (it answers "Not ready" until then). */
    suspend fun livePlaylistReady(path: String): Boolean {
        val b = base() ?: throw OfflineException()
        val call = client.newCall(Request.Builder().url(joinUrl(b, path)).build())
        call.timeout().timeout(10, TimeUnit.SECONDS)
        return withContext(Dispatchers.IO) {
            call.await().use { res ->
                if (res.isSuccessful) return@use true
                val text = res.body.string()
                if (res.code == 404 && text.startsWith("Not ready")) false
                else throw ApiException(res.code, text.ifBlank { "The live stream stopped (${res.code})" })
            }
        }
    }

    /** The live player's heartbeat (every 10 s): playing | paused | stopped (stopped frees the tuner at once). */
    suspend fun liveProgress(playId: String, state: String) {
        val b = base() ?: throw OfflineException()
        call("POST", joinUrl(b, "/api/livetv/progress"), buildJsonObject {
            put("playId", playId)
            put("state", state)
        }, JsonObject.serializer(), 10_000, signedIn = true)
    }

    suspend fun record(eventId: Long): RecordResponse {
        val b = base() ?: throw OfflineException()
        return call("POST", joinUrl(b, "/api/livetv/record"), buildJsonObject { put("eventId", eventId) }, RecordResponse.serializer(), 30_000, signedIn = true)
    }

    /** Every episode of a guide entry's show on its channel, from now on. */
    suspend fun recordSeries(eventId: Long): SeriesResponse {
        val b = base() ?: throw OfflineException()
        return call("POST", joinUrl(b, "/api/livetv/series"), buildJsonObject { put("eventId", eventId) }, SeriesResponse.serializer(), 30_000, signedIn = true)
    }

    /** Ends a series recording: what it had scheduled goes; what's recording or recorded stays. */
    suspend fun cancelSeries(uuid: String) {
        val b = base() ?: throw OfflineException()
        call("POST", joinUrl(b, "/api/livetv/series/${enc(uuid)}/cancel"), null, JsonObject.serializer(), 30_000, signedIn = true)
    }

    /** The recordings this account set, or everyone's ([everyone]: admins). */
    suspend fun recordings(everyone: Boolean): RecordingsResponse =
        get("/api/livetv/recordings" + if (everyone) "?all=1" else "", RecordingsResponse.serializer())

    /** Deletes finished recordings at once (a series, a show); scheduled ones and others' are left (skipped). */
    suspend fun deleteRecordings(uuids: List<String>): DeletedRecordings {
        val b = base() ?: throw OfflineException()
        return call("POST", joinUrl(b, "/api/livetv/recordings/delete"), buildJsonObject {
            put("uuids", JsonArray(uuids.map { JsonPrimitive(it) }))
        }, DeletedRecordings.serializer(), 60_000, signedIn = true)
    }

    /**
     * [action]: cancel (a scheduled recording; one a series recording made is skipped) | record (one that was skipped) |
     * stop (one that's recording now) | delete (a finished one, its file too).
     */
    suspend fun changeRecording(dvrUuid: String, action: String) {
        val b = base() ?: throw OfflineException()
        call("POST", joinUrl(b, "/api/livetv/recordings/${enc(dvrUuid)}/${enc(action)}"), null, JsonObject.serializer(), 30_000, signedIn = true)
    }

    // ---------- requests (server/routes/requests.js) ----------

    suspend fun requests(): RequestsResponse = get("/api/requests", RequestsResponse.serializer())

    /** Films on TMDB to ask for (a trailing year narrows it down), each marked as on the server or already asked for. */
    suspend fun searchFilms(query: String): List<FilmResult> = get("/api/requests/search?q=" + enc(query), FilmSearchResponse.serializer()).results

    suspend fun addRequest(tmdbId: Long): FilmRequest {
        val b = base() ?: throw OfflineException()
        return call("POST", joinUrl(b, "/api/requests"), buildJsonObject { put("tmdbId", tmdbId) }, RequestResponse.serializer(), 30_000, signedIn = true).request
    }

    /** Your own request, or any for an admin. */
    suspend fun removeRequest(id: Long) {
        val b = base() ?: throw OfflineException()
        call("DELETE", joinUrl(b, "/api/requests/$id"), null, JsonObject.serializer(), 20_000, signedIn = true)
    }

    /** Every request (admins); how many there were. */
    suspend fun removeAllRequests(): Int {
        val b = base() ?: throw OfflineException()
        return call("DELETE", joinUrl(b, "/api/requests"), null, RemovedResponse.serializer(), 20_000, signedIn = true).removed
    }

    // ---------- your picture ----------

    /** Sets your picture from a JPEG (checked on the phone first; Reelhouse checks and redraws it again). */
    suspend fun uploadAvatar(jpeg: ByteArray): User {
        val b = base() ?: throw OfflineException()
        return call("PUT", joinUrl(b, "/api/me/avatar"), null, UserResponse.serializer(), 60_000, signedIn = true, raw = jpeg.toRequestBody(JPEG)).user
    }

    suspend fun removeAvatar(): User {
        val b = base() ?: throw OfflineException()
        return call("DELETE", joinUrl(b, "/api/me/avatar"), null, UserResponse.serializer(), 20_000, signedIn = true).user
    }

    // ---------- plumbing ----------

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private suspend fun <T> get(path: String, serializer: KSerializer<T>): T {
        val b = base() ?: throw OfflineException()
        return call("GET", joinUrl(b, path), null, serializer, 30_000, signedIn = true)
    }

    private suspend fun <T> call(
        method: String,
        url: String,
        body: JsonObject?,
        serializer: KSerializer<T>,
        timeoutMs: Long,
        signedIn: Boolean = false,
        /** A body that isn't JSON (a picture), sent instead of [body]. */
        raw: RequestBody? = null,
    ): T = withContext(Dispatchers.IO) { // reading the body is network I/O too, never on the main thread
        val req = Request.Builder().url(url)
            .header("Accept", "application/json")
            .method(method, raw ?: body?.toString()?.toRequestBody(JSON) ?: if (method == "GET") null else "{}".toRequestBody(JSON))
            .build()
        val call = client.newCall(req)
        call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
        call.await().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) {
                if (signedIn && res.code == 401) onUnauthorized()
                val message = runCatching { AppJson.decodeFromString(ErrorBody.serializer(), text).error }.getOrNull()
                throw ApiException(res.code, message ?: "Reelhouse answered ${res.code}")
            }
            AppJson.decodeFromString(serializer, text)
        }
    }

    companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
        val JPEG = "image/jpeg".toMediaType()
    }
}
