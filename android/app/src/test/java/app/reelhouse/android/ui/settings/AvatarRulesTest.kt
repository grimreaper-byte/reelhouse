package app.reelhouse.android.ui.settings

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.model.MeResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AvatarRulesTest {
    @Test
    fun `pictures of the right kind and size pass, others get a reason`() {
        assertNull(AvatarRules.fileProblem("image/jpeg", 2_000_000))
        assertNull(AvatarRules.fileProblem("image/heic", 3_000_000)) // the phone converts it
        assertNull(AvatarRules.fileProblem(null, null)) // left to the decoder
        assertEquals("That isn’t a JPEG, PNG, WebP, GIF or HEIC picture.", AvatarRules.fileProblem("image/svg+xml", 400))
        assertEquals("That isn’t a JPEG, PNG, WebP, GIF or HEIC picture.", AvatarRules.fileProblem("video/mp4", 400))
        assertEquals("That picture is empty.", AvatarRules.fileProblem("image/png", 0))
        assertEquals("That picture is 20.0 MB; pictures can be up to 15 MB.", AvatarRules.fileProblem("image/jpeg", 20L * 1024 * 1024))
    }

    @Test
    fun `too small or unreadable pictures are refused`() {
        assertNull(AvatarRules.sizeProblem(64, 64))
        assertEquals("That picture is only 32×32. Choose one at least 64 pixels each way.", AvatarRules.sizeProblem(32, 32))
        assertEquals(AvatarRules.UNREADABLE, AvatarRules.sizeProblem(0, 0))
    }

    @Test
    fun `the middle square, and shrinking while decoding without going under the upload size`() {
        assertEquals(Triple(0, 125, 500), AvatarRules.middleSquare(500, 750))
        assertEquals(Triple(160, 0, 480), AvatarRules.middleSquare(800, 480))
        assertEquals(1, AvatarRules.sampleSize(800, 600))
        assertEquals(2, AvatarRules.sampleSize(4000, 1100))
        assertEquals(4, AvatarRules.sampleSize(4032, 3024))
        assertTrue(minOf(4032, 3024) / AvatarRules.sampleSize(4032, 3024) >= AvatarRules.UPLOAD_SIDE)
    }

    @Test
    fun `the user's picture address comes with them, and older servers have none`() {
        val now = AppJson.decodeFromString(MeResponse.serializer(), """{"user":{"id":1,"username":"dave","avatar":"/api/users/1/avatar?v=5"}}""")
        assertEquals("/api/users/1/avatar?v=5", now.user.avatar)
        assertNull(AppJson.decodeFromString(MeResponse.serializer(), """{"user":{"id":1,"username":"dave"}}""").user.avatar)
    }
}
