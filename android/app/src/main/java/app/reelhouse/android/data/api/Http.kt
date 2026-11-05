package app.reelhouse.android.data.api

import app.reelhouse.android.BuildConfig
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

/** Reelhouse answered with an error (its message is meant for people). */
class ApiException(val status: Int, message: String) : Exception(message)

/** No route to Reelhouse right now. */
class OfflineException(message: String = "Not connected to Reelhouse") : IOException(message)

/** Gives the sign-in token for a request, or null when the request isn't going to Reelhouse's current address. */
fun interface TokenSource {
    fun tokenFor(url: HttpUrl): String?
}

object Http {
    val USER_AGENT = "Reelhouse-Android/${BuildConfig.VERSION_NAME}"

    /**
     * The one HTTP client: API calls, images (Coil) and video (Media3) all go through it, and through the tunnel
     * when that's the route, since the route is just a base address.
     */
    fun client(tokens: TokenSource): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val req = chain.request()
            val b = req.newBuilder()
                .header("User-Agent", USER_AGENT)
                .header("X-Requested-With", "reelhouse")
            if (req.header("Authorization") == null) tokens.tokenFor(req.url)?.let { b.header("Authorization", "Bearer $it") }
            chain.proceed(b.build())
        }
        .build()
}

/** Runs a call without blocking a thread; cancelling the coroutine cancels the call. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, r, _ -> r.close() }
        }
    })
    cont.invokeOnCancellation { cancel() }
}
