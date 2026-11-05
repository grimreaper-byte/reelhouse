package app.reelhouse.android.data.update

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.model.AppRelease
import app.reelhouse.android.data.model.MeResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppUpdaterTest {
    private val offered = AppRelease(versionName = "0.2.0", versionCode = 2, size = 37_000_000, fileName = "reelhouse-0.2.0.apk")

    @Test
    fun `only a newer build is an update`() {
        assertEquals(offered, newerRelease(offered, installedCode = 1))
        assertNull(newerRelease(offered, installedCode = 2))
        assertNull(newerRelease(offered, installedCode = 3)) // an older APK on the server is never offered
        assertNull(newerRelease(null, installedCode = 1))
    }

    @Test
    fun `the server says which app it offers, or nothing`() {
        val user = """"user":{"id":1,"username":"dave","isAdmin":true}"""
        val withApp = AppJson.decodeFromString(
            MeResponse.serializer(),
            """{$user,"androidApp":{"versionName":"0.2.0","versionCode":2,"size":37000000,"fileName":"reelhouse-0.2.0.apk"}}""",
        )
        assertEquals(offered, withApp.androidApp)
        assertNull(AppJson.decodeFromString(MeResponse.serializer(), """{$user,"androidApp":null}""").androidApp)
        assertNull(AppJson.decodeFromString(MeResponse.serializer(), """{$user}""").androidApp) // an older server
    }
}
