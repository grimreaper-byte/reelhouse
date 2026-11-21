package app.reelhouse.android.data.store

import android.content.Context

/** Small, non-secret choices the app remembers. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    /** The playback quality picked at home or away (null: the default for that place). */
    fun quality(atHome: Boolean): String? = sp.getString(if (atHome) "quality.home" else "quality.away", null)

    /** Remembers [id] for home or away; null goes back to that place's default. */
    fun setQuality(atHome: Boolean, id: String?) {
        val key = if (atHome) "quality.home" else "quality.away"
        sp.edit().apply { if (id == null) remove(key) else putString(key, id) }.apply()
    }

    /** Picture and sound sync for this phone (ms, positive: the sound later), see AvSync. */
    var avSyncMs: Int
        get() = sp.getInt("playback.avSyncMs", 0)
        set(value) = sp.edit().putInt("playback.avSyncMs", value).apply()

    /** How late this phone shows the picture (µs), as last measured by the player (see PictureTiming). */
    var pictureDelayUs: Long
        get() = sp.getLong("playback.pictureDelayUs", 0)
        set(value) = sp.edit().putLong("playback.pictureDelayUs", value).apply()

    /** The sidebar pinned open beside the page on a wide screen (else a strip of icons), see ui/Sidebar.kt. */
    var sidebarPinned: Boolean
        get() = sp.getBoolean("sidebar.pinned", false)
        set(value) = sp.edit().putBoolean("sidebar.pinned", value).apply()

    /**
     * Whether a phone may control this device with the phone remote (null: as it comes, which is on for a TV box and
     * off for a phone or tablet).
     */
    var remoteTarget: Boolean?
        get() = if (sp.contains("remote.target")) sp.getBoolean("remote.target", false) else null
        set(value) = sp.edit().apply { if (value == null) remove("remote.target") else putBoolean("remote.target", value) }.apply()

    /** Whether anyone at home (other accounts' phones on the same network) may use this device too; off unless set. */
    var remoteShared: Boolean
        get() = sp.getBoolean("remote.shared", false)
        set(value) = sp.edit().putBoolean("remote.shared", value).apply()

    /** Download only over Wi-Fi (or another unmetered network). */
    var wifiOnlyDownloads: Boolean
        get() = sp.getBoolean("downloads.wifiOnly", true)
        set(value) = sp.edit().putBoolean("downloads.wifiOnly", value).apply()
}
