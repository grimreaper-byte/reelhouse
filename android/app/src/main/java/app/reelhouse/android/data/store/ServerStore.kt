package app.reelhouse.android.data.store

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.model.TunnelSettings
import app.reelhouse.android.data.model.User
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import java.io.File

/** The tunnel settings plus this device's private key, which is all a device needs to bring the tunnel up. */
@Serializable
data class StoredTunnel(
    val endpoint: String,
    val publicKey: String,
    val presharedKey: String? = null,
    val address: String,
    val url: String,
    val privateKey: String,
) {
    /** The same tunnel with what the server now says (it never sends this device's private key back). */
    fun updatedFrom(s: TunnelSettings) = copy(
        endpoint = s.endpoint.ifEmpty { endpoint },
        publicKey = s.publicKey.ifEmpty { publicKey },
        presharedKey = s.presharedKey ?: presharedKey,
        address = s.address.ifEmpty { address },
        url = s.url.ifEmpty { url },
    )

    companion object {
        fun from(s: TunnelSettings, privateKey: String) =
            StoredTunnel(s.endpoint, s.publicKey, s.presharedKey, s.address, s.url, privateKey)
    }
}

/** The paired Reelhouse server: how to reach it and this device's sign-in. */
@Serializable
data class ServerProfile(
    val serverId: String? = null, // from GET /api/server; null for servers that don't send one
    val serverName: String,
    val urls: List<String>, // direct addresses: home addresses first, then web addresses
    val token: String,
    val user: User,
    val deviceName: String,
    val tunnel: StoredTunnel? = null,
    val pairedAt: Long = System.currentTimeMillis(),
)

/** Keeps the server profile encrypted in one file, and offers it as a flow. */
class ServerStore(private val file: File, private val box: SecretBox) {
    private val _profile = MutableStateFlow(load())
    val profile: StateFlow<ServerProfile?> = _profile.asStateFlow()

    private fun load(): ServerProfile? {
        if (!file.exists()) return null
        return try {
            AppJson.decodeFromString(ServerProfile.serializer(), String(box.open(file.readBytes()), Charsets.UTF_8))
        } catch (e: Exception) {
            // Unreadable (e.g. the Keystore key was reset): start over with pairing.
            file.delete()
            null
        }
    }

    @Synchronized
    fun save(profile: ServerProfile) {
        val sealed = box.seal(AppJson.encodeToString(ServerProfile.serializer(), profile).toByteArray(Charsets.UTF_8))
        val tmp = File(file.parentFile, file.name + ".new")
        tmp.writeBytes(sealed)
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
        _profile.value = profile
    }

    @Synchronized
    fun update(change: (ServerProfile) -> ServerProfile) {
        _profile.value?.let { save(change(it)) }
    }

    /** Your account as Reelhouse last described it (a new picture or name), when it differs from the stored one. */
    @Synchronized
    fun updateUser(user: User) {
        if (_profile.value?.let { it.user != user } == true) update { it.copy(user = user) }
    }

    @Synchronized
    fun clear() {
        file.delete()
        _profile.value = null
    }
}
