package app.reelhouse.android.ui.pair

import android.content.Context
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.reelhouse.android.AppContainer
import app.reelhouse.android.BuildConfig
import app.reelhouse.android.data.pairing.HandoffCrypto
import app.reelhouse.android.data.pairing.PairTvLink
import app.reelhouse.android.data.pairing.PairingException
import app.reelhouse.android.data.pairing.PairingLink
import app.reelhouse.android.data.pairing.TvHandoff
import app.reelhouse.android.data.pairing.TvHandoffMessage
import app.reelhouse.android.data.pairing.deviceAddresses
import app.reelhouse.android.data.pairing.homeAddress
import app.reelhouse.android.data.store.ServerProfile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

class PairViewModel(private val c: AppContainer) : ViewModel() {
    enum class Mode { Choose, Scan, Code, Password, FromPhone }

    /** The code a TV shows for a phone to scan ([Mode.FromPhone]): its reelhouse://pair-tv link and when it runs out. */
    data class TvCode(val link: String, val expiresAt: Long)

    var mode by mutableStateOf(Mode.Choose)
    var busy by mutableStateOf<String?>(null)
        private set
    var error by mutableStateOf<String?>(null)
    var tvCode by mutableStateOf<TvCode?>(null)
        private set

    private var handoff: TvHandoff? = null
    private var handoffJob: Job? = null

    fun show(m: Mode) {
        if (m != Mode.FromPhone) stopFromPhone()
        error = null
        mode = m
    }

    fun onScanned(text: String) {
        mode = Mode.Choose
        if (!PairingLink.isPairingLink(text)) {
            error = "That QR code isn't a Reelhouse pairing code."
            return
        }
        pairLink(text)
    }

    fun pairLink(text: String, message: String = "Pairing with Reelhouse…") = run(message) { c.pairer().pair(PairingLink.parse(text)) }

    fun pairCode(address: String, code: String) = run("Pairing with Reelhouse…") { c.pairer().pairWithCode(address, code) }

    fun signIn(address: String, username: String, password: String) =
        run("Signing in…") { c.pairer().signIn(address, username, password) }

    /**
     * A TV pairing from a phone (see TvHandoff.kt): listens on the home network and shows the code for the phone to
     * scan, for [HANDOFF_MS]. When the phone's pairing arrives, pairs with it as with a scanned code.
     */
    fun startFromPhone(context: Context) {
        stopFromPhone()
        error = null
        val app = context.applicationContext
        handoffJob = viewModelScope.launch {
            val address = withContext(Dispatchers.IO) { homeAddress(deviceAddresses(app)) }
            if (address == null) {
                mode = Mode.Choose
                error = "This TV isn't connected to a network. Connect it to Wi-Fi or a cable, then try again."
                return@launch
            }
            val key = HandoffCrypto.newKey()
            val h = try {
                withContext(Dispatchers.IO) { TvHandoff(key) { m -> viewModelScope.launch { fromPhone(m) } } }
            } catch (e: IOException) {
                mode = Mode.Choose
                error = "This TV couldn't wait for the phone: ${e.message}"
                return@launch
            }
            handoff = h
            h.start(viewModelScope)
            val link = PairTvLink("$address:${h.port}", key, c.deviceName).toUri()
            if (BuildConfig.DEBUG) Log.d("Reelhouse", "pair-tv code: $link")
            tvCode = TvCode(link, System.currentTimeMillis() + HANDOFF_MS)
            mode = Mode.FromPhone
            delay(HANDOFF_MS)
            stopFromPhone()
            mode = Mode.Choose
            error = "The code ran out after 10 minutes. Choose Pair with your phone to show a new one."
        }
    }

    private fun fromPhone(message: TvHandoffMessage) {
        stopFromPhone()
        mode = Mode.Choose
        pairLink(message.link, if (message.from.isNotBlank()) "Pairing with Reelhouse (sent from ${message.from})…" else "Pairing with Reelhouse…")
    }

    fun stopFromPhone() {
        handoffJob?.cancel()
        handoffJob = null
        handoff?.close()
        handoff = null
        tvCode = null
    }

    override fun onCleared() {
        stopFromPhone()
    }

    private fun run(message: String, block: suspend () -> ServerProfile) {
        if (busy != null) return
        busy = message
        error = null
        c.notice.value = null
        viewModelScope.launch {
            try {
                val profile = withContext(Dispatchers.IO) { block() }
                c.store.save(profile) // the app switches to Home on its own
            } catch (e: CancellationException) {
                throw e
            } catch (e: PairingException) {
                error = e.message
            } catch (e: IllegalArgumentException) {
                error = e.message
            } catch (e: IOException) {
                error = "Reelhouse couldn't be reached: ${e.message ?: "network error"}"
            } catch (e: Exception) {
                error = "Pairing failed: ${e.message ?: e.javaClass.simpleName}"
            } finally {
                busy = null
            }
        }
    }

    companion object {
        const val HANDOFF_MS = 10 * 60 * 1000L
    }
}
