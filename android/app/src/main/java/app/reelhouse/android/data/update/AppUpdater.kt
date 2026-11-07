package app.reelhouse.android.data.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.reelhouse.android.BuildConfig
import app.reelhouse.android.data.connection.ConnectionManager
import app.reelhouse.android.data.downloads.FileDownloader
import app.reelhouse.android.data.joinUrl
import app.reelhouse.android.data.model.AppRelease
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import java.io.File

/** A newer build than this one, or null. */
fun newerRelease(offered: AppRelease?, installedCode: Int): AppRelease? = offered?.takeIf { it.versionCode > installedCode }

/**
 * Updates the app from the APK Reelhouse offers at /android/ (uploaded by an admin): downloads it over the current
 * route, then hands it to Android's installer. Android only installs it over this app if it's signed with the same
 * key.
 */
class AppUpdater(
    private val context: Context,
    private val connection: ConnectionManager,
    private val downloader: FileDownloader,
) {
    sealed interface State {
        data object Idle : State
        data class Downloading(val progress: Float) : State
        data class Ready(val release: AppRelease, val file: File) : State
        data class Failed(val message: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    /** A newer version on Reelhouse than the one installed. */
    val available: Flow<AppRelease?> = connection.appRelease.map { newerRelease(it, BuildConfig.VERSION_CODE) }

    private val folder get() = File(context.cacheDir, "updates")

    /** Downloads [release] and opens the installer. */
    suspend fun downloadAndInstall(release: AppRelease) {
        if (_state.value is State.Downloading) return
        val base = connection.baseUrl ?: run {
            _state.value = State.Failed("Reelhouse can't be reached right now.")
            return
        }
        folder.deleteRecursively()
        folder.mkdirs()
        val file = File(folder, "reelhouse-${release.versionCode}.apk")
        _state.value = State.Downloading(0f)
        val outcome = downloader.download(
            joinUrl(base, "/android/${Uri.encode(release.fileName)}"),
            file,
            onProgress = { done, total ->
                val size = if (total > 0) total else release.size
                if (size > 0) _state.value = State.Downloading((done.toFloat() / size).coerceIn(0f, 1f))
            },
        )
        _state.value = when (outcome) {
            is FileDownloader.Outcome.Done -> State.Ready(release, file)
            is FileDownloader.Outcome.Refused -> State.Failed(if (outcome.status == 404) "That version isn't on Reelhouse any more." else outcome.message ?: "Reelhouse answered ${outcome.status}.")
            is FileDownloader.Outcome.Failed -> State.Failed("The download stopped: ${outcome.error.message}")
            FileDownloader.Outcome.Stopped -> State.Idle
        }
        (_state.value as? State.Ready)?.let { install(it.file) }
    }

    /** Whether Android lets this app hand APKs to the installer ("Install unknown apps" for Reelhouse). */
    fun canInstall() = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    /** Opens Android's installer with a downloaded update, or its "Install unknown apps" switch first. */
    fun install(file: File) {
        if (!canInstall()) {
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            return
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        context.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
