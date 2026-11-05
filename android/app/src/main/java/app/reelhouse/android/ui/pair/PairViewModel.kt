package app.reelhouse.android.ui.pair

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.reelhouse.android.AppContainer
import app.reelhouse.android.data.pairing.PairingException
import app.reelhouse.android.data.pairing.PairingLink
import app.reelhouse.android.data.store.ServerProfile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

class PairViewModel(private val c: AppContainer) : ViewModel() {
    enum class Mode { Choose, Scan, Code, Password }

    var mode by mutableStateOf(Mode.Choose)
    var busy by mutableStateOf<String?>(null)
        private set
    var error by mutableStateOf<String?>(null)

    fun show(m: Mode) {
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

    fun pairLink(text: String) = run("Pairing with Reelhouse…") { c.pairer().pair(PairingLink.parse(text)) }

    fun pairCode(address: String, code: String) = run("Pairing with Reelhouse…") { c.pairer().pairWithCode(address, code) }

    fun signIn(address: String, username: String, password: String) =
        run("Signing in…") { c.pairer().signIn(address, username, password) }

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
}
