package app.reelhouse.android.ui.requests

import app.reelhouse.android.data.model.FilmRequest
import app.reelhouse.android.data.model.FilmResult
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** What a film found in a search offers: opening it (it's on the server), who asked for it, or asking for it. */
sealed interface FilmAction {
    data class Open(val itemId: Long) : FilmAction
    data class AskedFor(val label: String) : FilmAction
    data object Ask : FilmAction
}

fun filmAction(film: FilmResult): FilmAction = when {
    film.onServer != null -> FilmAction.Open(film.onServer)
    film.request != null -> FilmAction.AskedFor(if (film.request.mine) "You asked for it" else "Asked for by ${film.request.username}")
    else -> FilmAction.Ask
}

/** The day a film was asked for, as the phone writes dates: "28 Oct 2026". */
fun requestedDay(request: FilmRequest, locale: Locale = Locale.getDefault(), zone: ZoneId = ZoneId.systemDefault()): String =
    DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale).format(Instant.ofEpochMilli(request.requestedAt).atZone(zone))

/** Removing someone else's request (an admin can) asks first; your own goes at once, as on the web. */
fun removalNeedsConfirming(request: FilmRequest, myId: Long?): Boolean = request.user.id != myId
