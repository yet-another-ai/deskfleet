package ai.yetanother.deskfleet.platform

import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.transport.DeskFleetChannel
import ai.yetanother.deskfleet.transport.HttpCentralClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.Serializable

enum class PlatformKind(val wire: String) {
    DARWIN("darwin"),
    LINUX("linux"),
    WIN32("win32"),
    IOS("ios"),
    ANDROID("android"),
    WEB("web"),
}

data class PlatformProfile(
    val kind: PlatformKind,
    val osVersion: String = "",
    val arch: String = "arm64",
    val hostname: String = "localhost",
    val linuxDesktopBackend: String? = null, // "wayland" | "x11" | null
) {
    val isWeb: Boolean get() = kind == PlatformKind.WEB
    val isMobile: Boolean get() = kind == PlatformKind.IOS || kind == PlatformKind.ANDROID
    val isDesktop: Boolean get() = !isMobile && !isWeb
    val suppressBillingPricing: Boolean get() = isMobile
    val hasMacTrafficLights: Boolean get() = kind == PlatformKind.DARWIN
    val hasRightWindowControlsInset: Boolean get() = kind == PlatformKind.LINUX || kind == PlatformKind.WIN32
    val supportsLocalDaemon: Boolean get() = isDesktop
    val supportsNativeDesktopViewer: Boolean get() = isDesktop
    val supportsHoverTooltips: Boolean get() = !isMobile
    val supportsTrayResidency: Boolean get() = isDesktop
    val supportsLaunchAtStartup: Boolean get() = isDesktop
    val supportsWorktreeSettings: Boolean get() = isDesktop
    val usesCookieSessionOnly: Boolean get() = isWeb
    val locksServerUrlToOrigin: Boolean get() = isWeb

    fun onboardingSteps(localAgent: Boolean = true): List<String> = when (kind) {
        PlatformKind.DARWIN -> if (localAgent) {
            listOf("localNetwork", "fullDiskAccess", "screenCapture", "accessibility")
        } else {
            listOf("localNetwork")
        }
        PlatformKind.WIN32 -> if (localAgent) listOf("windowsDesktopService") else emptyList()
        PlatformKind.LINUX -> if (localAgent && linuxDesktopBackend == "wayland") {
            listOf("screenCapture", "accessibility")
        } else {
            emptyList()
        }
        PlatformKind.IOS, PlatformKind.ANDROID, PlatformKind.WEB -> emptyList()
    }
}

@Serializable
data class LocalDaemonRegistration(
    val configured: Boolean = false,
    val connected: Boolean = false,
    val revoked: Boolean = false,
    val serverUrl: String? = null,
    val teamId: String? = null,
    val machineId: String? = null,
    val originId: String = "",
    val localMachineId: String = "",
    val machineName: String = "",
)

@Serializable
data class LocalDaemonStatus(
    val available: Boolean = false,
    val daemonDirectory: String = "",
    val machineName: String = "",
    val registrations: List<LocalDaemonRegistration> = emptyList(),
    val error: String? = null,
)

data class ExternalEditorApp(
    val id: String,
    val label: String,
    val command: String,
)

interface HostBridge {
    val platform: PlatformProfile

    fun readPersistedState(fileName: String): String?
    fun writePersistedState(fileName: String, content: String)

    /** Opens browser / ASWebAuthenticationSession / Custom Tab PKCE login and exchanges code for Bearer token. */
    suspend fun authenticateWithBrowser(central: HttpCentralClient): AuthUser

    /** Queries the local DeskFleet daemon via `daemon.json` IPC (`darwin`/`linux` Unix socket, `win32` named pipe). */
    suspend fun queryLocalDaemonStatus(daemonDirOverride: String? = null): LocalDaemonStatus

    /** Prepares identity & enrolls this local machine into `teamId`, then configures the local daemon. */
    suspend fun enrollLocalMachine(
        central: HttpCentralClient,
        teamId: String,
        machineName: String? = null,
        daemonDirOverride: String? = null,
    ): MachineSummary

    /** Opens a zero-hop local IPC channel (`POST /api/peers/local` + `localOpen`/`localSend`/`localAck`) when eligible. */
    suspend fun openLocalDaemonChannel(
        scope: CoroutineScope,
        central: HttpCentralClient,
        machineScope: MachineScope,
        purpose: String, // "agent" | "terminal"
        daemonDirOverride: String? = null,
    ): DeskFleetChannel?

    suspend fun listLocalFiles(path: String? = null): FileListing
    suspend fun readLocalFileBytes(path: String): ByteArray
    suspend fun writeLocalFileBytes(
        directory: String,
        fileName: String,
        bytes: ByteArray,
        conflict: FileConflictPolicy = FileConflictPolicy.RENAME,
    ): String

    fun availableEditors(): List<ExternalEditorApp>
    fun openInEditor(editorId: String, directoryPath: String): Boolean

    suspend fun launchNativeDesktopViewer(
        scope: CoroutineScope,
        central: HttpCentralClient,
        machineScope: MachineScope,
        title: String,
        control: Boolean = true,
    ): Boolean

    fun openExternalUrl(url: String)
    fun copyToClipboard(text: String)
    fun readFromClipboard(): String?
    fun setKeepAwake(enabled: Boolean)
    fun postNotification(title: String, body: String)
    suspend fun checkForUpdates(): UpdateStateWire

    // Web-specific routing & WebAuthn Passkey capabilities (no-op defaults on non-Web hosts)
    val currentWebPath: String get() = "/"
    val supportsBrowserPasskeys: Boolean get() = false
    fun consumeUrlFragmentToken(): String? = null
    fun getUrlQueryParam(name: String): String? = null
    fun navigateWebPath(path: String) = openExternalUrl(path)
    suspend fun authenticateWithPasskey(central: HttpCentralClient, purpose: String = "login", email: String? = null) {
        throw UnsupportedOperationException("Passkey authentication requires a WebAuthn browser host")
    }
    suspend fun registerBrowserPasskey(central: HttpCentralClient, name: String) {
        throw UnsupportedOperationException("Passkey registration requires a WebAuthn browser host")
    }
}

expect fun createPlatformHostBridge(): HostBridge
