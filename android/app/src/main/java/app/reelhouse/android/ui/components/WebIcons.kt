package app.reelhouse.android.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp
import app.reelhouse.android.data.model.Library

/**
 * Icons the app shares with the web app, drawn as the web draws them (web/js/dom.js): the same 24×24 paths in
 * 2-wide lines with round ends, so a library looks the same in both. Tinted like any other icon.
 */
object WebIcons {
    /** A strip of film: movie libraries. */
    val Film: ImageVector by lazy {
        outline("Film", "M4 4h16v16H4z M8 4v16 M16 4v16 M4 8h4 M4 12h4 M4 16h4 M16 8h4 M16 12h4 M16 16h4")
    }

    /** A television: show libraries. */
    val Tv: ImageVector by lazy { outline("Tv", "M3 7h18v12H3z M8 3l4 4 4-4") }

    // The other icons a library can be given (Settings → Libraries on the web).
    val TvOld: ImageVector by lazy { outline("TvOld", "M3 8h18v12H3z M8 3l4 5 4-5 M6 11h8v6H6z M17.5 12h.01 M17.5 15.5h.01") }
    val TvFlat: ImageVector by lazy { outline("TvFlat", "M3 4h18v12H3z M12 16v4 M8 20h8") }
    val TvPlay: ImageVector by lazy { outline("TvPlay", "M3 7h18v12H3z M8 3l4 4 4-4 M10.5 10.5v6l4.5-3z") }
    val Clapperboard: ImageVector by lazy {
        outline("Clapperboard", "M3 11h18v9H3z M2.5 7.5L19.5 3l1 3.5L3.5 11z M7.6 6.15l2.36 3.14 M13.04 4.71l2.36 3.14")
    }
    val MovieCamera: ImageVector by lazy {
        outline(
            "MovieCamera",
            "M3 11h12v9H3z M15 14l6-3v9l-6-3 M6.5 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M12.5 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
        )
    }
    val Trophy: ImageVector by lazy {
        outline("Trophy", "M7 4h10v5a5 5 0 0 1-10 0z M7 6H4v1a3 3 0 0 0 3 3 M17 6h3v1a3 3 0 0 1-3 3 M12 14v4 M8 21h8l-1-3H9z")
    }
    val Heart: ImageVector by lazy {
        outline("Heart", "M12 20s-8-4.7-8-10.6A4.4 4.4 0 0 1 12 6.8a4.4 4.4 0 0 1 8 2.6C20 15.3 12 20 12 20z")
    }

    /** A bookmark with a plus: Requests. */
    val Request: ImageVector by lazy {
        outline("Request", "M6 3h12v18l-6-4.5L6 21z M12 7v6 M9 10h6")
    }

    /** A library's icon, by the name the server gives it (see [LibraryIcons]). */
    fun library(lib: Library): LibraryIcon = when (LibraryIcons.nameFor(lib.type, lib.icon)) {
        "tv" -> LibraryIcon(Tv)
        "tvRecord" -> LibraryIcon(Tv, LibraryIcons.RECORDING_SPOT)
        "tvOld" -> LibraryIcon(TvOld)
        "tvFlat" -> LibraryIcon(TvFlat)
        "tvPlay" -> LibraryIcon(TvPlay)
        "clapperboard" -> LibraryIcon(Clapperboard)
        "movieCamera" -> LibraryIcon(MovieCamera)
        "trophy" -> LibraryIcon(Trophy)
        "heart" -> LibraryIcon(Heart)
        else -> LibraryIcon(Film)
    }

    private fun outline(name: String, path: String) = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
        .addPath(
            addPathNodes(path),
            fill = null,
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 2f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        )
        .build()
}

/** A library's icon: [vector], tinted as the row is, and maybe a [spot] of red drawn over it whatever the tint. */
class LibraryIcon(val vector: ImageVector, val spot: Spot? = null)

/** A filled circle on an icon's 24×24 grid. */
data class Spot(val x: Float, val y: Float, val radius: Float)

/** The icons a library can have: the server's names (server/libraries.js LIBRARY_ICONS, the web's icon names). */
object LibraryIcons {
    val NAMES = listOf("film", "tv", "tvRecord", "tvOld", "tvFlat", "tvPlay", "clapperboard", "movieCamera", "trophy", "heart")

    /** The recording TV's red spot, in the middle of the screen as on the web. */
    val RECORDING_SPOT = Spot(12f, 13f, 3f)

    /** The icon a library shows: its own, or its type's (as for a server from before icons, or a name this app doesn't know). */
    fun nameFor(type: String, icon: String?): String = icon?.takeIf { it in NAMES } ?: if (type == "show") "tv" else "film"
}
