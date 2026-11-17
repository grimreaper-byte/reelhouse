package app.reelhouse.android.ui.pair

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import app.reelhouse.android.AppContainer
import app.reelhouse.android.container
import app.reelhouse.android.data.api.ApiException
import app.reelhouse.android.data.pairing.HandoffCrypto
import app.reelhouse.android.data.pairing.PairTvLink
import app.reelhouse.android.data.pairing.TvHandoffMessage
import app.reelhouse.android.ui.components.Button
import app.reelhouse.android.ui.components.OutlinedButton
import app.reelhouse.android.ui.components.statusRowBar
import app.reelhouse.android.ui.theme.Palette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Settings → Pair a TV: scans the code a TV shows under "Pair with your phone", makes a pairing for this account and
 * sends it to the TV over the home network (TvHandoff.kt), then follows it until the TV has used it.
 */
class PairTvViewModel(private val c: AppContainer, initial: String?) : ViewModel() {
    sealed interface Step {
        data object Scan : Step
        data class Confirm(val tv: PairTvLink) : Step
        data class Working(val message: String) : Step
        data class Done(val device: String) : Step
    }

    var step by mutableStateOf<Step>(Step.Scan)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    /** Each scan round, so the scanner starts over after a code that couldn't be used. */
    var round by mutableIntStateOf(0)
        private set

    init {
        initial?.let(::onScanned)
    }

    fun onScanned(text: String) {
        error = null
        try {
            step = Step.Confirm(PairTvLink.parse(text))
        } catch (e: IllegalArgumentException) {
            failed(
                if (PairTvLink.isPairTvLink(text)) e.message.orEmpty()
                else "That isn't a TV's code. On the TV, open Reelhouse and choose Pair with your phone.",
            )
        }
    }

    fun scanAgain() {
        error = null
        step = Step.Scan
        round++
    }

    private fun failed(message: String) {
        error = message
        step = Step.Scan
        round++
    }

    private class Refused(message: String) : Exception(message)

    fun pair(tv: PairTvLink) {
        step = Step.Working("Making a pairing code…")
        viewModelScope.launch {
            var id: String? = null
            try {
                val pairing = c.api.createPairing()
                id = pairing.id
                step = Step.Working("Sending it to ${tv.name}…")
                withContext(Dispatchers.IO) { send(tv, HandoffCrypto.sealMessage(tv.key, TvHandoffMessage(pairing.link, c.deviceName))) }
                val sent = id
                id = null // the TV has it now: cancelling would only pull it from under the TV
                step = Step.Working("${tv.name} is pairing…")
                step = Step.Done(waitUntilUsed(sent) ?: tv.name)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Refused) {
                failed(e.message.orEmpty())
            } catch (e: ApiException) {
                failed("Reelhouse didn't make a pairing code: ${e.message}")
            } catch (e: IOException) {
                failed(
                    if (id != null) "Couldn't reach ${tv.name}. Check that this phone is on the same Wi-Fi as the TV, then scan its code again."
                    else "Reelhouse couldn't be reached: ${e.message ?: "network error"}",
                )
            } finally {
                id?.let { unused -> c.scope.launch { runCatching { c.api.cancelPairing(unused) } } }
            }
        }
    }

    /** Hands the sealed pairing to the TV, straight over the home network (never the tunnel). */
    private fun send(tv: PairTvLink, body: String) {
        val client = c.http.newBuilder().connectTimeout(6, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
        val req = Request.Builder().url(tv.url).post(body.toRequestBody("application/json".toMediaType())).build()
        client.newCall(req).execute().use { res ->
            when (res.code) {
                200 -> Unit
                403 -> throw Refused("${tv.name} didn't take it: its code has changed. Scan the code on the TV again.")
                else -> throw Refused("That isn't a TV waiting to pair (it answered ${res.code}). Scan the code on the TV again.")
            }
        }
    }

    /** The name the TV paired as, once it has used the code; null when Reelhouse doesn't say. */
    private suspend fun waitUntilUsed(id: String): String? {
        repeat(60) {
            val st = runCatching { c.api.pairingStatus(id) }.getOrNull()
            when (st?.status) {
                "used" -> return st.device
                "expired" -> throw Refused("The TV didn't finish pairing. Look at the TV: it says what went wrong.")
            }
            delay(2000)
        }
        throw Refused("The TV hasn't finished pairing yet. Look at the TV: it says if something went wrong.")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairTvScreen(link: String?, onBack: () -> Unit) {
    val context = LocalContext.current
    val c = context.container
    val vm = viewModel { PairTvViewModel(c, link) }
    val profile by c.store.profile.collectAsState()
    var cameraAllowed by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var cameraRefused by remember { mutableStateOf(false) }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        cameraAllowed = granted
        cameraRefused = !granted
    }
    val step = vm.step
    LaunchedEffect(Unit) {
        if (!cameraAllowed && vm.step is PairTvViewModel.Step.Scan) askCamera.launch(Manifest.permission.CAMERA)
    }

    val statusRow = statusRowBar()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pair a TV") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                expandedHeight = statusRow.height,
                windowInsets = statusRow.insets,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.Background),
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 420.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                when (step) {
                    PairTvViewModel.Step.Scan -> {
                        Text(
                            "On the TV, open Reelhouse and choose Pair with your phone. Then scan the code it shows. " +
                                "This phone must be on the same Wi-Fi as the TV.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = Palette.TextDim,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(20.dp))
                        if (cameraAllowed) {
                            Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(12.dp))) {
                                key(vm.round) { QrScanner(onResult = vm::onScanned, onError = { cameraRefused = true }, modifier = Modifier.fillMaxSize()) }
                            }
                        } else {
                            Text(
                                if (cameraRefused) "Without the camera, the TV's code can't be scanned." else "Reelhouse needs the camera to scan the TV's code.",
                                style = MaterialTheme.typography.bodyMedium,
                                textAlign = TextAlign.Center,
                            )
                            Spacer(Modifier.height(12.dp))
                            Button(onClick = { askCamera.launch(Manifest.permission.CAMERA) }) {
                                Icon(Icons.Filled.QrCodeScanner, contentDescription = null, modifier = Modifier.size(20.dp))
                                Spacer(Modifier.size(10.dp))
                                Text("Scan the TV's code")
                            }
                        }
                    }
                    is PairTvViewModel.Step.Confirm -> {
                        Text("Pair “${step.tv.name}”?", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(12.dp))
                        Text(
                            "It will be signed in to ${profile?.serverName ?: "Reelhouse"} as ${profile?.user?.username ?: "you"}, " +
                                "like this phone, with your watch history. Only pair a TV that's in front of you.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = Palette.TextDim,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(24.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            OutlinedButton(onClick = vm::scanAgain) { Text("Cancel") }
                            Button(onClick = { vm.pair(step.tv) }) { Text("Pair") }
                        }
                    }
                    is PairTvViewModel.Step.Working -> {
                        Spacer(Modifier.height(24.dp))
                        CircularProgressIndicator()
                        Spacer(Modifier.height(12.dp))
                        Text(step.message, style = MaterialTheme.typography.bodyMedium, color = Palette.TextDim, textAlign = TextAlign.Center)
                    }
                    is PairTvViewModel.Step.Done -> {
                        Spacer(Modifier.height(24.dp))
                        Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Palette.Accent, modifier = Modifier.size(48.dp))
                        Spacer(Modifier.height(12.dp))
                        Text("“${step.device}” is paired.", style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(24.dp))
                        Button(onClick = onBack) { Text("Done") }
                    }
                }
                vm.error?.let {
                    Spacer(Modifier.height(16.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
                }
            }
        }
    }
}
