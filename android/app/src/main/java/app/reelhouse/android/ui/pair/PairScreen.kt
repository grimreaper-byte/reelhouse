package app.reelhouse.android.ui.pair

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import app.reelhouse.android.container
import app.reelhouse.android.data.pairing.PendingPairLink
import app.reelhouse.android.ui.common.RemoteTextBox
import app.reelhouse.android.ui.common.startFocus
import app.reelhouse.android.ui.components.Button
import app.reelhouse.android.ui.components.OutlinedButton
import app.reelhouse.android.ui.theme.Palette

@Composable
fun PairScreen() {
    val context = LocalContext.current
    val c = context.container
    val vm = viewModel { PairViewModel(c) }
    val notice by c.notice.collectAsState()
    val pending by c.pendingPairLink.collectAsState()

    // A reelhouse://pair link opened from outside the app: anything can open one, so ask first.
    var asking by remember { mutableStateOf<PendingPairLink?>(null) }
    LaunchedEffect(pending) {
        pending?.let {
            c.pendingPairLink.value = null
            if (it.confirmed) vm.pairLink(it.link) else asking = it
        }
    }
    asking?.let { link ->
        AlertDialog(
            onDismissRequest = { asking = null },
            title = { Text("Pair with ${link.serverName?.let { "“$it”" } ?: "this Reelhouse"}?") },
            text = { Text("A pairing link was opened. Pair only if you made this code in your own Reelhouse.") },
            confirmButton = {
                TextButton(onClick = {
                    asking = null
                    vm.pairLink(link.link)
                }) { Text("Pair") }
            },
            dismissButton = { TextButton(onClick = { asking = null }) { Text("Cancel") } },
        )
    }

    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) vm.show(PairViewModel.Mode.Scan) else vm.error = "Without the camera, type the code instead."
    }
    fun startScan() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            vm.show(PairViewModel.Mode.Scan)
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    BackHandler(enabled = vm.mode != PairViewModel.Mode.Choose && vm.busy == null) { vm.show(PairViewModel.Mode.Choose) }

    if (vm.mode == PairViewModel.Mode.Scan && vm.busy == null) {
        Box(Modifier.fillMaxSize()) {
            QrScanner(onResult = vm::onScanned, onError = { vm.show(PairViewModel.Mode.Choose); vm.error = it }, modifier = Modifier.fillMaxSize())
            Column(
                Modifier.align(Alignment.BottomCenter).safeDrawingPadding().padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Surface(color = Palette.Background.copy(alpha = 0.75f), shape = RoundedCornerShape(8.dp)) {
                    Text(
                        "Point the camera at the QR code in Reelhouse",
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = { vm.show(PairViewModel.Mode.Choose) }) { Text("Cancel") }
            }
        }
        return
    }

    Column(
        Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Reelhouse", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.SemiBold, color = Palette.Accent)
            Spacer(Modifier.height(8.dp))
            Text("Pair this device with your Reelhouse", style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
            Spacer(Modifier.height(24.dp))

            notice?.let {
                Surface(color = Palette.Elevated2, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
                    Text(it, modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium)
                }
                Spacer(Modifier.height(16.dp))
            }

            val busy = vm.busy
            if (busy != null) {
                CircularProgressIndicator()
                Spacer(Modifier.height(12.dp))
                Text(busy, style = MaterialTheme.typography.bodyMedium, color = Palette.TextDim)
            } else when (vm.mode) {
                PairViewModel.Mode.Choose, PairViewModel.Mode.Scan -> ChooseWay(onScan = ::startScan, onCode = { vm.show(PairViewModel.Mode.Code) }, onPassword = { vm.show(PairViewModel.Mode.Password) })
                PairViewModel.Mode.Code -> CodeForm(onPair = vm::pairCode, onBack = { vm.show(PairViewModel.Mode.Choose) })
                PairViewModel.Mode.Password -> PasswordForm(onSignIn = vm::signIn, onBack = { vm.show(PairViewModel.Mode.Choose) })
            }

            vm.error?.let {
                Spacer(Modifier.height(16.dp))
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
            }
        }
    }
}

@Composable
private fun ChooseWay(onScan: () -> Unit, onCode: () -> Unit, onPassword: () -> Unit) {
    val hasCamera = LocalContext.current.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    Text(
        "In Reelhouse on a computer, open Your account → Apps and devices → Pair the Reelhouse app.",
        style = MaterialTheme.typography.bodyMedium,
        color = Palette.TextDim,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(24.dp))
    if (hasCamera) {
        Button(onClick = onScan, modifier = Modifier.startFocus().fillMaxWidth().height(52.dp)) {
            Icon(Icons.Filled.QrCodeScanner, contentDescription = null, modifier = Modifier.size(20.dp))
            Spacer(Modifier.size(10.dp))
            Text("Scan the QR code")
        }
        Spacer(Modifier.height(12.dp))
    }
    OutlinedButton(onClick = onCode, modifier = (if (hasCamera) Modifier else Modifier.startFocus()).fillMaxWidth().height(52.dp)) {
        Icon(Icons.Filled.Keyboard, contentDescription = null, modifier = Modifier.size(20.dp))
        Spacer(Modifier.size(10.dp))
        Text("Type the code (at home)")
    }
    Spacer(Modifier.height(8.dp))
    TextButton(onClick = onPassword) { Text("Sign in with a password instead") }
}

@Composable
private fun CodeForm(onPair: (String, String) -> Unit, onBack: () -> Unit) {
    var address by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    Text(
        "On the same network as Reelhouse, enter its address and the code shown under the QR code.",
        style = MaterialTheme.typography.bodyMedium,
        color = Palette.TextDim,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(16.dp))
    AddressField(address) { address = it }
    Spacer(Modifier.height(8.dp))
    RemoteTextBox(Modifier.fillMaxWidth()) { box ->
    OutlinedTextField(
        value = code,
        onValueChange = { code = it.uppercase().filter { ch -> ch.isLetterOrDigit() || ch == '-' || ch == ' ' }.take(12) },
        label = { Text("Pairing code") },
        placeholder = { Text("XXXX-XXXX") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
        modifier = Modifier.fillMaxWidth().then(box),
    )
    }
    Spacer(Modifier.height(16.dp))
    Button(onClick = { onPair(address, code) }, enabled = address.isNotBlank() && code.count { it.isLetterOrDigit() } >= 8, modifier = Modifier.fillMaxWidth().height(48.dp)) {
        Text("Pair")
    }
    TextButton(onClick = onBack) { Text("Back") }
}

@Composable
private fun PasswordForm(onSignIn: (String, String, String) -> Unit, onBack: () -> Unit) {
    var address by rememberSaveable { mutableStateOf("") }
    var username by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    Text(
        "Signing in with a password works at this address only. Pairing with the QR code also lets the app reach Reelhouse away from home.",
        style = MaterialTheme.typography.bodyMedium,
        color = Palette.TextDim,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(16.dp))
    AddressField(address) { address = it }
    Spacer(Modifier.height(8.dp))
    RemoteTextBox(Modifier.fillMaxWidth()) { box ->
        OutlinedTextField(username, { username = it }, label = { Text("Username") }, singleLine = true, modifier = Modifier.fillMaxWidth().then(box))
    }
    Spacer(Modifier.height(8.dp))
    RemoteTextBox(Modifier.fillMaxWidth()) { box ->
    OutlinedTextField(
        password, { password = it }, label = { Text("Password") }, singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
        modifier = Modifier.fillMaxWidth().then(box),
    )
    }
    Spacer(Modifier.height(16.dp))
    Button(onClick = { onSignIn(address, username, password) }, enabled = address.isNotBlank() && username.isNotBlank() && password.isNotEmpty(), modifier = Modifier.fillMaxWidth().height(48.dp)) {
        Text("Sign in")
    }
    TextButton(onClick = onBack) { Text("Back") }
}

@Composable
private fun AddressField(value: String, onChange: (String) -> Unit) {
    RemoteTextBox(Modifier.startFocus().fillMaxWidth()) { box ->
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text("Reelhouse address") },
        placeholder = { Text("192.168.1.20:8484") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
        modifier = Modifier.fillMaxWidth().then(box),
    )
    }
}
