@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package ai.yetanother.deskfleet.platform

import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.transport.DeskFleetChannel
import ai.yetanother.deskfleet.transport.HttpCentralClient
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import platform.Foundation.*
import platform.UIKit.UIApplication
import platform.UIKit.UIDevice
import platform.UIKit.UIPasteboard
import platform.posix.memcpy

object IosAuthCallbackBus {
    private var pendingCode: CompletableDeferred<String>? = null

    internal fun awaitAuthCallback(): CompletableDeferred<String> {
        val def = CompletableDeferred<String>()
        pendingCode = def
        return def
    }

    fun onCallbackUrl(urlString: String) {
        val fragment = urlString.substringAfter('#', "")
        val query = urlString.substringAfter('?', "").substringBefore('#')
        val code = (fragment.split('&') + query.split('&'))
            .firstOrNull { it.startsWith("loginCode=") }
            ?.removePrefix("loginCode=")
        if (!code.isNullOrBlank()) {
            pendingCode?.complete(code)
            pendingCode = null
        }
    }
}

private class IosHostBridge : HostBridge {
    override val platform = PlatformProfile(
        kind = PlatformKind.IOS,
        osVersion = UIDevice.currentDevice.systemVersion,
        arch = "arm64",
        hostname = UIDevice.currentDevice.name,
    )

    private fun appDocsDir(): String {
        val urls = NSFileManager.defaultManager.URLsForDirectory(NSDocumentDirectory, NSUserDomainMask)
        val docUrl = urls.firstOrNull() as? NSURL
        val dir = ((docUrl?.path ?: NSTemporaryDirectory()).trimEnd('/')) + "/deskfleet-kmp"
        NSFileManager.defaultManager.createDirectoryAtPath(dir, true, null, null)
        return dir
    }

    override fun readPersistedState(fileName: String): String? {
        val full = "${appDocsDir()}/$fileName"
        if (!NSFileManager.defaultManager.fileExistsAtPath(full)) return null
        return NSString.stringWithContentsOfFile(full, NSUTF8StringEncoding, null)
    }

    override fun writePersistedState(fileName: String, content: String) {
        val full = "${appDocsDir()}/$fileName"
        val ns = content as NSString
        ns.writeToFile(full, true, NSUTF8StringEncoding, null)
    }

    override suspend fun authenticateWithBrowser(central: HttpCentralClient): AuthUser {
        val callbackUri = "ai.yetanother.deskfleet://auth/callback"
        val deferred = IosAuthCallbackBus.awaitAuthCallback()
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
        val home = appDocsDir()
        val target = path?.takeIf { it.isNotBlank() } ?: home
        val fm = NSFileManager.defaultManager
        val names = (fm.contentsOfDirectoryAtPath(target, null) as? List<*>)?.mapNotNull { it as? String }.orEmpty()
        val entries = names.map { name ->
            val itemPath = "${target.trimEnd('/')}/$name"
            val attrs = fm.attributesOfItemAtPath(itemPath, null)
            val fileType = attrs?.get(NSFileType) as? String
            val size = (attrs?.get(NSFileSize) as? NSNumber)?.longLongValue ?: 0L
            FileEntry(
                name = name,
                path = itemPath,
                kind = if (fileType == NSFileTypeDirectory) "directory" else "file",
                size = size,
                hidden = name.startsWith("."),
            )
        }.sortedWith(compareBy<FileEntry>({ it.kind != "directory" }, { it.name.lowercase() }))
        val parent = target.substringBeforeLast('/', "").takeIf { it.isNotBlank() && it != target }
        FileListing(
            path = target,
            parent = parent,
            roots = listOf(home),
            homeDirectory = home,
            entries = entries,
        )
    }

    override suspend fun readLocalFileBytes(path: String): ByteArray = withContext(Dispatchers.IO) {
        val data = NSData.dataWithContentsOfFile(path) ?: return@withContext ByteArray(0)
        val len = data.length.toInt()
        if (len == 0) return@withContext ByteArray(0)
        val out = ByteArray(len)
        out.usePinned { pinned ->
            memcpy(pinned.addressOf(0), data.bytes, data.length)
        }
        out
    }

    override suspend fun writeLocalFileBytes(
        directory: String,
        fileName: String,
        bytes: ByteArray,
        conflict: FileConflictPolicy,
    ): String = withContext(Dispatchers.IO) {
        NSFileManager.defaultManager.createDirectoryAtPath(directory, true, null, null)
        val full = "${directory.trimEnd('/')}/$fileName"
        val nsData = if (bytes.isEmpty()) {
            NSData()
        } else {
            bytes.usePinned { pinned ->
                NSData.create(bytes = pinned.addressOf(0), length = bytes.size.toULong())
            }
        }
        nsData.writeToFile(full, true)
        full
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
        val nsUrl = NSURL.URLWithString(url) ?: return
        UIApplication.sharedApplication.openURL(nsUrl, emptyMap<Any?, Any>(), null)
    }

    override fun copyToClipboard(text: String) {
        UIPasteboard.generalPasteboard.string = text
    }

    override fun readFromClipboard(): String? = UIPasteboard.generalPasteboard.string

    override fun setKeepAwake(enabled: Boolean) {
        UIApplication.sharedApplication.idleTimerDisabled = enabled
    }

    override fun postNotification(title: String, body: String) = Unit

    override suspend fun checkForUpdates(): UpdateStateWire = UpdateStateWire(
        status = "idle",
        currentVersion = "0.15.0",
    )
}

actual fun createPlatformHostBridge(): HostBridge = IosHostBridge()
