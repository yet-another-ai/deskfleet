package ai.yetanother.deskfleet.platform

import ai.yetanother.deskfleet.protocol.*
import ai.yetanother.deskfleet.transport.*
import io.ktor.http.HttpMethod
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.*

class WebHostBridge : HostBridge {
    override val platform: PlatformProfile = PlatformProfile(
        kind = PlatformKind.WEB,
        osVersion = jsUserAgent(),
        arch = "wasm32",
        hostname = jsHostname(),
    )

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    override fun readPersistedState(fileName: String): String? {
        val raw = jsStorageGet(fileName)
        if (fileName == "account.json") {
            val origin = jsServerOrigin()
            if (raw.isBlank()) {
                return json.encodeToString(SavedAccountProfile.serializer(), SavedAccountProfile(serverUrl = origin))
            }
            val parsed = runCatching { json.decodeFromString(SavedAccountProfile.serializer(), raw) }.getOrNull()
                ?: SavedAccountProfile(serverUrl = origin)
            // Per `apps/web/README.md`: Web backend URL always comes from build/page origin, never stored preference.
            return json.encodeToString(
                SavedAccountProfile.serializer(),
                parsed.copy(serverUrl = origin, token = null),
            )
        }
        return raw.takeIf { it.isNotBlank() }
    }

    override fun writePersistedState(fileName: String, content: String) {
        if (fileName == "account.json") {
            val parsed = runCatching { json.decodeFromString(SavedAccountProfile.serializer(), content) }.getOrNull()
            if (parsed != null) {
                val stripped = parsed.copy(serverUrl = jsServerOrigin(), token = null)
                jsStorageSet(fileName, json.encodeToString(SavedAccountProfile.serializer(), stripped))
                return
            }
        }
        jsStorageSet(fileName, content)
    }

    override val currentWebPath: String
        get() = jsCurrentPath()

    override val supportsBrowserPasskeys: Boolean
        get() = jsPasskeysAvailable()

    override fun consumeUrlFragmentToken(): String? =
        jsConsumeFragmentToken().takeIf { it.isNotBlank() }

    override fun getUrlQueryParam(name: String): String? =
        jsQueryParam(name).takeIf { it.isNotBlank() }

    override fun navigateWebPath(path: String) {
        jsNavigate(path)
    }

    override suspend fun authenticateWithBrowser(central: HttpCentralClient): AuthUser {
        jsNavigate("/auth/login")
        error("Redirecting to /auth/login")
    }

    override suspend fun authenticateWithPasskey(central: HttpCentralClient, purpose: String, email: String?) {
        central.fetchAuthConfig()
        val reqBody = buildJsonObject {
            if (!email.isNullOrBlank()) put("email", email.trim())
        }
        val opts = central.requestJson(HttpMethod.Post, "/api/auth/passkeys/$purpose/options", reqBody).jsonObject
        val ceremonyId = opts["ceremonyId"]?.jsonPrimitive?.content ?: error("Missing ceremonyId")
        val publicKeyJson = json.encodeToString(JsonElement.serializer(), opts["publicKey"] ?: error("Missing publicKey"))
        val credJson = jsAuthenticatePasskeyPromise(publicKeyJson).awaitJsString()
        val credObj = json.parseToJsonElement(credJson)
        val finishBody = buildJsonObject {
            put("ceremonyId", ceremonyId)
            put("credential", credObj)
        }
        central.requestJson(HttpMethod.Post, "/api/auth/passkeys/$purpose", finishBody)
    }

    override suspend fun registerBrowserPasskey(central: HttpCentralClient, name: String) {
        central.fetchAuthConfig()
        val opts = central.requestJson(HttpMethod.Post, "/api/auth/passkeys/register/options", JsonObject(emptyMap())).jsonObject
        val ceremonyId = opts["ceremonyId"]?.jsonPrimitive?.content ?: error("Missing ceremonyId")
        val publicKeyJson = json.encodeToString(JsonElement.serializer(), opts["publicKey"] ?: error("Missing publicKey"))
        val credJson = jsRegisterPasskeyPromise(publicKeyJson).awaitJsString()
        val credObj = json.parseToJsonElement(credJson)
        val finishBody = buildJsonObject {
            put("ceremonyId", ceremonyId)
            put("credential", credObj)
            put("name", name)
        }
        central.requestJson(HttpMethod.Post, "/api/auth/passkeys/register", finishBody)
    }

    override suspend fun queryLocalDaemonStatus(daemonDirOverride: String?): LocalDaemonStatus =
        LocalDaemonStatus(available = false)

    override suspend fun enrollLocalMachine(
        central: HttpCentralClient,
        teamId: String,
        machineName: String?,
        daemonDirOverride: String?,
    ): MachineSummary {
        error("Local daemon enrollment is unavailable in a browser; run `deskfleet-daemon status` on the target host.")
    }

    override suspend fun openLocalDaemonChannel(
        scope: CoroutineScope,
        central: HttpCentralClient,
        machineScope: MachineScope,
        purpose: String,
        daemonDirOverride: String?,
    ): DeskFleetChannel? = null

    override suspend fun listLocalFiles(path: String?): FileListing =
        json.decodeFromString(FileListing.serializer(), jsListLocalFilesJson())

    @OptIn(ExperimentalEncodingApi::class)
    override suspend fun readLocalFileBytes(path: String): ByteArray {
        val b64 = jsReadLocalFileBase64(path)
        return if (b64.isBlank()) ByteArray(0) else Base64.decode(b64)
    }

    @OptIn(ExperimentalEncodingApi::class)
    override suspend fun writeLocalFileBytes(
        directory: String,
        fileName: String,
        bytes: ByteArray,
        conflict: FileConflictPolicy,
    ): String = jsSaveDownloadBase64(fileName, Base64.encode(bytes))

    override fun availableEditors(): List<ExternalEditorApp> = emptyList()
    override fun openInEditor(editorId: String, directoryPath: String): Boolean = false

    override suspend fun launchNativeDesktopViewer(
        scope: CoroutineScope,
        central: HttpCentralClient,
        machineScope: MachineScope,
        title: String,
        control: Boolean,
    ): Boolean = false

    override fun openExternalUrl(url: String) = jsOpenUrl(url)
    override fun copyToClipboard(text: String) = jsCopyText(text)
    override fun readFromClipboard(): String? = jsReadClipboardCached().takeIf { it.isNotEmpty() }
    override fun setKeepAwake(enabled: Boolean) = jsSetKeepAwake(enabled)
    override fun postNotification(title: String, body: String) = jsNotify(title, body)
    override suspend fun checkForUpdates(): UpdateStateWire = UpdateStateWire(status = "idle")
}

actual fun createPlatformHostBridge(): HostBridge = WebHostBridge()
