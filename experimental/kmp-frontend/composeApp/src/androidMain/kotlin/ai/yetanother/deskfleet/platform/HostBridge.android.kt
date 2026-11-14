package ai.yetanother.deskfleet.platform

import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.transport.DeskFleetChannel
import ai.yetanother.deskfleet.transport.HttpCentralClient
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

object AndroidAuthCallbackBus {
    @Volatile
    var appContext: Context? = null

    @Volatile
    private var pendingAuthCode: CompletableDeferred<String>? = null

    internal fun awaitAuthCallback(): CompletableDeferred<String> {
        val def = CompletableDeferred<String>()
        pendingAuthCode = def
        return def
    }

    fun onDeepLinkUri(uri: Uri?) {
        if (uri == null) return
        val fragment = uri.fragment.orEmpty()
        val codeFromHash = fragment.split('&')
            .firstOrNull { it.startsWith("loginCode=") }
            ?.removePrefix("loginCode=")
            ?.let { Uri.decode(it) }
        val code = codeFromHash ?: uri.getQueryParameter("loginCode")
        if (!code.isNullOrBlank()) {
            pendingAuthCode?.complete(code)
            pendingAuthCode = null
        }
    }
}

private class AndroidHostBridge : HostBridge {
    override val platform = PlatformProfile(
        kind = PlatformKind.ANDROID,
        osVersion = Build.VERSION.RELEASE.orEmpty(),
        arch = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a",
        hostname = Build.MODEL ?: "Android",
    )

    private fun filesRoot(): File {
        val ctx = AndroidAuthCallbackBus.appContext
        val dir = ctx?.filesDir?.resolve("deskfleet-kmp") ?: File("/data/local/tmp/deskfleet-kmp")
        dir.mkdirs()
        return dir
    }

    override fun readPersistedState(fileName: String): String? {
        val f = File(filesRoot(), fileName)
        return if (f.isFile) runCatching { f.readText() }.getOrNull() else null
    }

    override fun writePersistedState(fileName: String, content: String) {
        runCatching { File(filesRoot(), fileName).writeText(content) }
    }

    override suspend fun authenticateWithBrowser(central: HttpCentralClient): AuthUser {
        val callbackUri = "ai.yetanother.deskfleet://auth/callback"
        val deferred = AndroidAuthCallbackBus.awaitAuthCallback()
        val started = central.startBrowserLogin(callbackUri)
        openExternalUrl(started.authorizationUrl)
        val code = withTimeout(180_000L) { deferred.await() }
        return central.exchangeLoginCode(code, started.loginVerifier)
    }

    override suspend fun queryLocalDaemonStatus(daemonDirOverride: String?): LocalDaemonStatus =
        LocalDaemonStatus(available = false, machineName = platform.hostname)

    override suspend fun enrollLocalMachine(
        central: HttpCentralClient,
        teamId: String,
        machineName: String?,
        daemonDirOverride: String?,
    ): MachineSummary = error("Local daemon enrollment is only supported on Desktop hosts")

    override suspend fun openLocalDaemonChannel(
        scope: CoroutineScope,
        central: HttpCentralClient,
        machineScope: MachineScope,
        purpose: String,
        daemonDirOverride: String?,
    ): DeskFleetChannel? = null

    override suspend fun listLocalFiles(path: String?): FileListing = withContext(Dispatchers.IO) {
        val home = filesRoot().absolutePath
        val dir = File(path?.takeIf { it.isNotBlank() } ?: home)
        val entries = dir.listFiles()?.map { f ->
            FileEntry(
                name = f.name,
                path = f.absolutePath,
                kind = if (f.isDirectory) "directory" else "file",
                size = if (f.isFile) f.length() else 0L,
                modifiedAt = f.lastModified().toString(),
                hidden = f.name.startsWith("."),
                readable = f.canRead(),
                writable = f.canWrite(),
            )
        }?.sortedWith(compareBy<FileEntry>({ it.kind != "directory" }, { it.name.lowercase() })).orEmpty()
        FileListing(
            path = dir.absolutePath,
            parent = dir.parentFile?.absolutePath,
            roots = listOf(home),
            homeDirectory = home,
            entries = entries,
        )
    }

    override suspend fun readLocalFileBytes(path: String): ByteArray = withContext(Dispatchers.IO) {
        File(path).readBytes()
    }

    override suspend fun writeLocalFileBytes(
        directory: String,
        fileName: String,
        bytes: ByteArray,
        conflict: FileConflictPolicy,
    ): String = withContext(Dispatchers.IO) {
        val dir = File(directory).apply { mkdirs() }
        val dest = File(dir, fileName)
        dest.writeBytes(bytes)
        dest.absolutePath
    }

    override fun availableEditors(): List<ExternalEditorApp> = emptyList()
    override fun openInEditor(editorId: String, directoryPath: String): Boolean = false

    override suspend fun launchNativeDesktopViewer(
        scope: CoroutineScope,
        central: HttpCentralClient,
        machineScope: MachineScope,
        title: String,
        control: Boolean,
    ): Boolean = false

    override fun openExternalUrl(url: String) {
        val ctx = AndroidAuthCallbackBus.appContext ?: return
        runCatching {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
        }
    }

    override fun copyToClipboard(text: String) {
        val ctx = AndroidAuthCallbackBus.appContext ?: return
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        cm.setPrimaryClip(ClipData.newPlainText("DeskFleet", text))
    }

    override fun readFromClipboard(): String? {
        val ctx = AndroidAuthCallbackBus.appContext ?: return null
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
        return cm.primaryClip?.getItemAt(0)?.coerceToText(ctx)?.toString()
    }

    private var wakeLock: PowerManager.WakeLock? = null
    override fun setKeepAwake(enabled: Boolean) {
        val ctx = AndroidAuthCallbackBus.appContext ?: return
        if (enabled) {
            if (wakeLock?.isHeld == true) return
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DeskFleetKmp::SessionWakeLock").apply {
                acquire(60 * 60 * 1000L)
            }
        } else {
            runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
            wakeLock = null
        }
    }

    override fun postNotification(title: String, body: String) = Unit

    override suspend fun checkForUpdates(): UpdateStateWire = UpdateStateWire(
        status = "idle",
        currentVersion = "0.15.0",
    )
}

actual fun createPlatformHostBridge(): HostBridge = AndroidHostBridge()
