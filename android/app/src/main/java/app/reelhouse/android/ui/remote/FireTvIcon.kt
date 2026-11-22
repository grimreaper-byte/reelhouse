package app.reelhouse.android.ui.remote

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * A Fire TV in the phone remote's list: the stick beside its remote (Material has no streaming-stick icon). Drawn on
 * Material's 24 by 24 grid and filled as its icons are, so it sits with them; the Icon's tint colours it.
 */
val FireTvIcon: ImageVector by lazy {
    ImageVector.Builder(name = "FireTv", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
        .addPath(pathData = addPathNodes(FIRE_TV_PATH), pathFillType = PathFillType.EvenOdd, fill = SolidColor(Color.Black))
        .build()
}

// The stick (its body, then the HDMI plug on top), then the remote: the ring of arrow keys round the select button,
// and two buttons below, which the even-odd fill cuts out of it.
private const val FIRE_TV_PATH =
    "M4.5,9h4a1.5,1.5 0 0 1 1.5,1.5v9a1.5,1.5 0 0 1 -1.5,1.5h-4a1.5,1.5 0 0 1 -1.5,-1.5v-9a1.5,1.5 0 0 1 1.5,-1.5z" +
        "M4.75,5.5h3.5v3.5h-3.5z" +
        "M16,2h1a3,3 0 0 1 3,3v14a3,3 0 0 1 -3,3h-1a3,3 0 0 1 -3,-3v-14a3,3 0 0 1 3,-3z" +
        "M16.5,4.75a2.25,2.25 0 1 0 0,4.5a2.25,2.25 0 1 0 0,-4.5z" +
        "M16.5,6a1,1 0 1 0 0,2a1,1 0 1 0 0,-2z" +
        "M16.5,11.25a0.75,0.75 0 1 0 0,1.5a0.75,0.75 0 1 0 0,-1.5z" +
        "M16.5,14.25a0.75,0.75 0 1 0 0,1.5a0.75,0.75 0 1 0 0,-1.5z"
