package app.reelhouse.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import app.reelhouse.android.data.pairing.PairingLink
import app.reelhouse.android.data.pairing.PendingPairLink
import app.reelhouse.android.ui.BootScreen
import app.reelhouse.android.ui.ReelhouseRoot
import app.reelhouse.android.ui.theme.ReelhouseTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) takePairingLink(intent)
        setContent {
            ReelhouseTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    ReelhouseRoot()
                    BootScreen() // over the app for its first 2 seconds
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takePairingLink(intent)
    }

    /** reelhouse://pair?d=… opened from a browser, a message or the camera app. */
    private fun takePairingLink(intent: Intent?) {
        val link = intent?.dataString ?: return
        if (PairingLink.isPairingLink(link)) container.pendingPairLink.value = PendingPairLink(link)
    }
}
