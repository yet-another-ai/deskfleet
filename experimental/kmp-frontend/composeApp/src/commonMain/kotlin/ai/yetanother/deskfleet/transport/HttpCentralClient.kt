package ai.yetanother.deskfleet.transport

import ai.yetanother.deskfleet.protocol.*
import io.ktor.client.*
import io.ktor.client.plugins.*
import io.ktor.client.plugins.cookies.*
import io.ktor.client.plugins.websocket.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.websocket.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable
data class SavedAccountProfile(
    val serverUrl: String = "http://localhost:8080",
    val token: String? = null,
    val user: AuthUser? = null,
)

sealed interface CentralRealtimeEvent {
    data class ConnectionChanged(val connected: Boolean) : CentralRealtimeEvent
    data object AccountChanged : CentralRealtimeEvent
    data class CatalogChanged(val teamId: String, val machineId: String, val sessionId: String? = null) : CentralRealtimeEvent
    data class MachinesChanged(val teamId: String) : CentralRealtimeEvent
    data class PresenceChanged(val teamId: String, val machineId: String, val online: Boolean) : CentralRealtimeEvent
    data class PeerEvent(val peerId: String, val event: JsonObject) : CentralRealtimeEvent
    data class PeerRevoked(val peerId: String, val reason: String) : CentralRealtimeEvent
}

private const val WS_HEARTBEAT_MS = 20_000L
private const val WS_IDLE_TIMEOUT_MS = 60_000L
private const val WS_RETRY_MIN_MS = 1_000L
private const val WS_RETRY_MAX_MS = 30_000L

fun normalizeServerUrl(input: String): String {
    val trimmed = input.trim().trimEnd('/')
    require(trimmed.startsWith("https://") || trimmed.startsWith("http://localhost") || trimmed.startsWith("http://127.0.0.1") || trimmed.startsWith("http://[::1]")) {
        "Use HTTPS for remote server addresses (HTTP is allowed on localhost / 127.0.0.1)"
    }
    return trimmed
}

/**
 * Full DeskFleet Central Backend client (`apps/server`) matching `packages/client/src/http-central.ts`:
 * - Bearer token + optional Cookie/CSRF session support (for direct in-app sign-in AND browser/deep-link PKCE).
 * - `/api/client/ws` WebSocket signaling with `authenticate`, `ready`, 20s heartbeat, 60s idle watchdog,
 *   close `4401` sign-out, and exponential reconnect backoff `1s..30s`.
 */
class HttpCentralClient(
    private val scope: CoroutineScope,
    initialAccount: SavedAccountProfile,
    private val cookieOnlyMode: Boolean = false,
    private val persistAccount: suspend (SavedAccountProfile) -> Unit = {},
) {
    val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
        explicitNulls = false
    }

    private val cookieStorage = AcceptAllCookiesStorage()
    private val http = HttpClient {
        install(HttpCookies) {
            storage = cookieStorage
        }
        install(WebSockets)
        install(HttpTimeout) {
            requestTimeoutMillis = 30_000L
            connectTimeoutMillis = 10_000L
            socketTimeoutMillis = 30_000L
        }
    }
    private val bearerHttp = HttpClient {
        install(WebSockets)
        install(HttpTimeout) {
            requestTimeoutMillis = 30_000L
            connectTimeoutMillis = 10_000L
            socketTimeoutMillis = 30_000L
        }
    }

    private val _account = MutableStateFlow(
        initialAccount.copy(serverUrl = runCatching { normalizeServerUrl(initialAccount.serverUrl) }.getOrDefault("http://localhost:8080"))
    )
    val account: StateFlow<SavedAccountProfile> = _account.asStateFlow()

    private val _wsConnected = MutableStateFlow(false)
    val wsConnected: StateFlow<Boolean> = _wsConnected.asStateFlow()

    private val _siteAdmin = MutableStateFlow(false)
    val siteAdmin: StateFlow<Boolean> = _siteAdmin.asStateFlow()

    private val _events = MutableSharedFlow<CentralRealtimeEvent>(extraBufferCapacity = 128)
    val events: SharedFlow<CentralRealtimeEvent> = _events.asSharedFlow()

    private var csrfToken: String? = null
    private var cookieAuthenticated: Boolean = false
    private var wsJob: Job? = null

    val currentServerUrl: String get() = _account.value.serverUrl
    val isSignedIn: Boolean get() = !_account.value.token.isNullOrBlank() || (cookieAuthenticated && _account.value.user != null)

    suspend fun setServerUrl(url: String) {
        val normalized = normalizeServerUrl(url)
        if (normalized == _account.value.serverUrl) return
        stopRealtime()
        csrfToken = null
        cookieAuthenticated = false
        val updated = SavedAccountProfile(serverUrl = normalized)
        _account.value = updated
        persistAccount(updated)
        _events.tryEmit(CentralRealtimeEvent.AccountChanged)
    }

    suspend fun requestJson(
        method: HttpMethod,
        path: String,
        body: JsonElement? = null,
        extraHeaders: Map<String, String> = emptyMap(),
    ): JsonElement {
        if ((cookieOnlyMode || cookieAuthenticated) && method != HttpMethod.Get && method != HttpMethod.Head && csrfToken == null) {
            fetchAuthConfig()
        }
        val base = _account.value.serverUrl
        val token = _account.value.token
        val activeClient = if (!token.isNullOrBlank()) bearerHttp else http
        val response: HttpResponse = activeClient.request("$base$path") {
            this.method = method
            header(HttpHeaders.Accept, ContentType.Application.Json.toString())
            if (!token.isNullOrBlank()) {
                header(HttpHeaders.Authorization, "Bearer $token")
            } else {
                if (!cookieOnlyMode) header(HttpHeaders.Origin, base)
                csrfToken?.let { header("X-CSRF-Token", it) }
            }
            extraHeaders.forEach { (k, v) -> header(k, v) }
            if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(json.encodeToString(JsonElement.serializer(), body))
            }
        }
        val text = response.bodyAsText()
        if (!response.status.isSuccess()) {
            val rawObj = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()
            val nestedErr = rawObj?.get("error") as? JsonObject
            val parsedErr = runCatching {
                json.decodeFromString(CentralErrorPayload.serializer(), text)
            }.getOrNull()
            val msg = nestedErr?.get("message")?.jsonPrimitive?.contentOrNull
                ?: parsedErr?.error
                ?: parsedErr?.details
                ?: text.ifBlank { "HTTP ${response.status.value}" }
            val code = nestedErr?.get("code")?.jsonPrimitive?.contentOrNull ?: parsedErr?.code
            val reason = nestedErr?.get("reason")?.jsonPrimitive?.contentOrNull ?: parsedErr?.reason
            throw CentralApiException(
                statusCode = response.status.value,
                message = msg,
                code = code,
                reason = reason,
            )
        }
        if (text.isBlank()) return JsonNull
        val parsed = runCatching { json.parseToJsonElement(text) }.getOrElse { JsonPrimitive(text) }
        if (parsed is JsonObject) {
            parsed["csrfToken"]?.jsonPrimitive?.contentOrNull?.let { csrfToken = it }
        }
        return parsed
    }

    suspend inline fun <reified T> requestTyped(
        method: HttpMethod,
        path: String,
        body: JsonElement? = null,
    ): T {
        val element = requestJson(method, path, body)
        return json.decodeFromJsonElement(element)
    }

    suspend fun fetchAuthConfig(): JsonObject {
        val el = requestJson(HttpMethod.Get, "/api/auth/config")
        return el as? JsonObject ?: JsonObject(emptyMap())
    }

    suspend fun refreshStatus(): AuthUser? {
        if (_account.value.token.isNullOrBlank() && !cookieAuthenticated && !cookieOnlyMode) return null
        return try {
            val obj = requestJson(HttpMethod.Get, "/api/me").jsonObject
            val user = json.decodeFromJsonElement(AuthUser.serializer(), obj["user"] ?: return null)
            if (cookieOnlyMode) cookieAuthenticated = true
            _siteAdmin.value = obj["siteAdmin"]?.jsonPrimitive?.booleanOrNull == true
            val next = _account.value.copy(user = user)
            _account.value = next
            persistAccount(next)
            ensureRealtimeRunning()
            user
        } catch (err: CentralApiException) {
            if (err.statusCode == 401) {
                clearSession()
                null
            } else {
                throw err
            }
        }
    }

    /** Primary PKCE authorization start (`http://127.0.0.1:<port>/auth/callback` or `ai.yetanother.deskfleet://auth/callback`). */
    suspend fun startBrowserLogin(returnTo: String): AuthStartResponse {
        val req = json.encodeToJsonElement(AuthStartRequest.serializer(), AuthStartRequest(returnTo))
        return requestTyped(HttpMethod.Post, "/api/auth/start", req)
    }

    /** Exchanges `#loginCode=...` from callback URL into a persistent Bearer token. */
    suspend fun exchangeLoginCode(code: String, loginVerifier: String): AuthUser {
        val req = json.encodeToJsonElement(
            AuthExchangeRequest.serializer(),
            AuthExchangeRequest(code = code, loginVerifier = loginVerifier),
        )
        val res: AuthTokenResponse = requestTyped(HttpMethod.Post, "/api/auth/exchange", req)
        val next = _account.value.copy(token = res.token, user = res.user)
        _account.value = next
        persistAccount(next)
        refreshStatus()
        ensureRealtimeRunning()
        _events.tryEmit(CentralRealtimeEvent.AccountChanged)
        return res.user
    }

    /**
     * Direct in-app email + password login against `/api/auth/login`!
     * Automatically upgrades the authenticated session cookie into a first-class Bearer token
     * via `/api/auth/start` + `/api/auth/desktop/complete` + `/api/auth/exchange` when available,
     * or falls back to cookie+CSRF mode seamlessly.
     */
    suspend fun signInWithPassword(email: String, password: String): AuthUser {
        fetchAuthConfig()
        val body = buildJsonObject {
            put("email", email.trim())
            put("password", password)
        }
        val loginObj = requestJson(HttpMethod.Post, "/api/auth/login", body)
        cookieAuthenticated = true
        // Try upgrading cookie session to a stateless Bearer token via desktop PKCE completion:
        val upgraded = if (cookieOnlyMode) null else runCatching {
            val callbackUri = "http://127.0.0.1:49152/auth/callback"
            val started = startBrowserLogin(callbackUri)
            val attempt = started.authorizationUrl
                .substringAfter("attempt=", "")
                .substringBefore("&")
                .substringBefore("#")
            val completeBody = buildJsonObject {
                put("attempt", attempt)
            }
            val completeRes = requestJson(HttpMethod.Post, "/api/auth/desktop/complete", completeBody).jsonObject
            val returnedUrl = (completeRes["returnTo"] ?: completeRes["redirectUrl"])?.jsonPrimitive?.content.orEmpty()
            val code = returnedUrl
                .substringAfter("loginCode=", "")
                .substringBefore("&")
            if (code.isNotEmpty()) {
                exchangeLoginCode(code, started.loginVerifier)
            } else {
                null
            }
        }.getOrNull()
        if (upgraded != null) return upgraded

        val directToken = if (cookieOnlyMode) null else (loginObj as? JsonObject)?.get("token")?.jsonPrimitive?.contentOrNull
        val userEl = (loginObj as? JsonObject)?.get("user") ?: loginObj
        val user = runCatching { json.decodeFromJsonElement(AuthUser.serializer(), userEl) }.getOrNull()
            ?: refreshStatus()
            ?: error("Sign-in succeeded without user profile")
        val next = _account.value.copy(token = directToken ?: _account.value.token, user = user)
        _account.value = next
        persistAccount(next)
        ensureRealtimeRunning()
        _events.tryEmit(CentralRealtimeEvent.AccountChanged)
        return user
    }

    suspend fun registerAccount(name: String, email: String, password: String?): JsonObject {
        fetchAuthConfig()
        val body = buildJsonObject {
            put("email", email.trim())
            if (name.isNotBlank()) put("name", name.trim())
            if (!password.isNullOrEmpty()) put("password", password)
        }
        val res = requestJson(HttpMethod.Post, "/api/auth/register", body)
        return res as? JsonObject ?: JsonObject(emptyMap())
    }

    suspend fun requestPasswordRecovery(email: String) {
        fetchAuthConfig()
        requestJson(HttpMethod.Post, "/api/auth/password-reset", buildJsonObject { put("email", email.trim()) })
    }

    suspend fun logout() {
        runCatching { requestJson(HttpMethod.Post, "/api/auth/logout", JsonObject(emptyMap())) }
        clearSession()
    }

    private suspend fun clearSession() {
        stopRealtime()
        cookieAuthenticated = false
        csrfToken = null
        _siteAdmin.value = false
        val cleared = SavedAccountProfile(serverUrl = _account.value.serverUrl)
        _account.value = cleared
        persistAccount(cleared)
        _events.tryEmit(CentralRealtimeEvent.AccountChanged)
    }

    // --- Teams, Machines & Catalog ---

    suspend fun listTeams(): List<TeamSummary> = requestTyped(HttpMethod.Get, "/api/teams")

    suspend fun createTeam(name: String): TeamSummary =
        requestTyped(HttpMethod.Post, "/api/teams", buildJsonObject { put("name", name.trim()) })

    suspend fun renameTeam(teamId: String, name: String): TeamSummary =
        requestTyped(HttpMethod.Patch, "/api/teams/${teamId.encodeURLPathPart()}", buildJsonObject { put("name", name.trim()) })

    suspend fun listMembers(teamId: String): List<TeamMember> =
        requestTyped(HttpMethod.Get, "/api/teams/${teamId.encodeURLPathPart()}/members")

    suspend fun inviteMember(teamId: String, email: String, role: String): JsonObject =
        requestJson(
            HttpMethod.Post,
            "/api/teams/${teamId.encodeURLPathPart()}/invites",
            buildJsonObject {
                put("email", email.trim())
                put("role", role)
            },
        ).jsonObject

    suspend fun acceptInvite(token: String): TeamSummary =
        requestTyped(HttpMethod.Post, "/api/invites/accept", buildJsonObject { put("token", token.trim()) })

    suspend fun setMemberRole(teamId: String, userId: String, role: String) {
        requestJson(
            HttpMethod.Patch,
            "/api/teams/${teamId.encodeURLPathPart()}/members/${userId.encodeURLPathPart()}",
            buildJsonObject { put("role", role) },
        )
    }

    suspend fun removeMember(teamId: String, userId: String) {
        requestJson(HttpMethod.Delete, "/api/teams/${teamId.encodeURLPathPart()}/members/${userId.encodeURLPathPart()}")
    }

    suspend fun transferOwnership(teamId: String, userId: String) {
        requestJson(
            HttpMethod.Post,
            "/api/teams/${teamId.encodeURLPathPart()}/ownership",
            buildJsonObject { put("userId", userId) },
        )
    }

    suspend fun listMachines(teamId: String): List<MachineSummary> =
        requestTyped<List<MachineSummary>>(HttpMethod.Get, "/api/teams/${teamId.encodeURLPathPart()}/machines")
            .map { if (it.teamId.isBlank()) it.copy(teamId = teamId) else it }

    suspend fun renameMachine(teamId: String, machineId: String, name: String): MachineSummary =
        requestTyped(
            HttpMethod.Patch,
            "/api/teams/${teamId.encodeURLPathPart()}/machines/${machineId.encodeURLPathPart()}",
            buildJsonObject { put("name", name.trim()) },
        )

    suspend fun removeMachine(teamId: String, machineId: String) {
        requestJson(
            HttpMethod.Delete,
            "/api/teams/${teamId.encodeURLPathPart()}/machines/${machineId.encodeURLPathPart()}",
        )
    }

    suspend fun enrollMachine(
        teamId: String,
        name: String,
        originId: String,
        localMachineId: String,
        identityToken: String,
    ): Pair<MachineSummary, String> {
        val res = requestJson(
            HttpMethod.Post,
            "/api/teams/${teamId.encodeURLPathPart()}/machines",
            buildJsonObject {
                put("name", name)
                put("originId", originId)
                put("localMachineId", localMachineId)
                put("identityToken", identityToken)
            },
        ).jsonObject
        val machine = json.decodeFromJsonElement(MachineSummary.serializer(), res["machine"]!!)
        val token = res["token"]!!.jsonPrimitive.content
        return machine.copy(teamId = teamId) to token
    }

    suspend fun fetchCatalogRaw(teamId: String, machineId: String): JsonObject =
        requestJson(
            HttpMethod.Get,
            "/api/teams/${teamId.encodeURLPathPart()}/machines/${machineId.encodeURLPathPart()}/catalog",
        ).jsonObject

    suspend fun fetchSessionsRaw(teamId: String, machineId: String): List<JsonObject> {
        val all = mutableListOf<JsonObject>()
        var after = "0"
        while (true) {
            val page = requestJson(
                HttpMethod.Get,
                "/api/teams/${teamId.encodeURLPathPart()}/machines/${machineId.encodeURLPathPart()}/sessions?after=${after.encodeURLParameter()}&limit=200",
            ).jsonObject
            val arr = page["sessions"]?.jsonArray.orEmpty()
            arr.mapNotNullTo(all) { it as? JsonObject }
            val next = page["nextCursor"]?.jsonPrimitive?.contentOrNull
            if (next.isNullOrBlank()) break
            after = next
        }
        return all
    }

    suspend fun fetchSessionSnapshotRaw(teamId: String, machineId: String, sessionId: String): JsonObject =
        requestJson(
            HttpMethod.Get,
            "/api/teams/${teamId.encodeURLPathPart()}/machines/${machineId.encodeURLPathPart()}/sessions/${sessionId.encodeURLPathPart()}",
        ).jsonObject

    suspend fun fetchSessionEventsRaw(
        teamId: String,
        machineId: String,
        sessionId: String,
        after: String = "0",
        limit: Int = 500,
    ): JsonObject =
        requestJson(
            HttpMethod.Get,
            "/api/teams/${teamId.encodeURLPathPart()}/machines/${machineId.encodeURLPathPart()}/sessions/${sessionId.encodeURLPathPart()}/events?after=${after.encodeURLParameter()}&limit=$limit",
        ).jsonObject

    suspend fun rpc(teamId: String, machineId: String, method: String, params: JsonElement = JsonObject(emptyMap())): JsonElement {
        val req = buildJsonObject {
            put("method", method)
            put("params", params)
        }
        return requestJson(
            HttpMethod.Post,
            "/api/teams/${teamId.encodeURLPathPart()}/machines/${machineId.encodeURLPathPart()}/rpc",
            req,
        )
    }

    // --- Peer & Local Peer Signaling ---

    suspend fun createPeer(teamId: String, machineId: String, purpose: String): PeerGrantWire =
        requestTyped(
            HttpMethod.Post,
            "/api/peers",
            json.encodeToJsonElement(CreatePeerRequest.serializer(), CreatePeerRequest(teamId, machineId, purpose)),
        )

    suspend fun createLocalPeer(teamId: String, machineId: String, purpose: String): LocalPeerGrantWire =
        requestTyped(
            HttpMethod.Post,
            "/api/peers/local",
            json.encodeToJsonElement(CreateLocalPeerRequest.serializer(), CreateLocalPeerRequest(teamId, machineId, purpose)),
        )

    suspend fun offerPeer(peerId: String, sdp: String, options: PeerOfferOptionsWire? = null): OfferPeerResponse =
        requestTyped(
            HttpMethod.Post,
            "/api/peers/${peerId.encodeURLPathPart()}/offer",
            json.encodeToJsonElement(OfferPeerRequest.serializer(), OfferPeerRequest(sdp = sdp, options = options)),
        )

    suspend fun startPeer(peerId: String, options: JsonObject) {
        requestJson(HttpMethod.Post, "/api/peers/${peerId.encodeURLPathPart()}/start", options)
    }

    suspend fun candidatePeer(peerId: String, candidate: IceCandidateWire) {
        requestJson(
            HttpMethod.Post,
            "/api/peers/${peerId.encodeURLPathPart()}/candidate",
            json.encodeToJsonElement(CandidatePeerRequest.serializer(), CandidatePeerRequest(candidate)),
        )
    }

    suspend fun closePeer(peerId: String) {
        runCatching { requestJson(HttpMethod.Delete, "/api/peers/${peerId.encodeURLPathPart()}") }
    }

    // --- Billing, AI Usage, Search, Schedules & Admin ---

    suspend fun billing(teamId: String): TeamBillingWire =
        requestTyped(HttpMethod.Get, "/api/teams/${teamId.encodeURLPathPart()}/billing")

    suspend fun billingCheckoutUrl(teamId: String, plan: String, requestId: String, interval: String = "month"): String {
        val res = requestJson(
            HttpMethod.Post,
            "/api/teams/${teamId.encodeURLPathPart()}/billing/checkout",
            buildJsonObject {
                put("plan", plan)
                put("requestId", requestId)
                put("interval", interval)
            },
        ).jsonObject
        return res["url"]?.jsonPrimitive?.content ?: error("Missing checkout URL")
    }

    suspend fun billingPortalUrl(teamId: String): String {
        val res = requestJson(
            HttpMethod.Post,
            "/api/teams/${teamId.encodeURLPathPart()}/billing/portal",
            JsonObject(emptyMap()),
        ).jsonObject
        return res["url"]?.jsonPrimitive?.content ?: error("Missing billing portal URL")
    }

    suspend fun aiUsage(teamId: String, period: String, timeZone: String): TeamAiUsageWire =
        requestTyped(
            HttpMethod.Get,
            "/api/teams/${teamId.encodeURLPathPart()}/ai-usage?period=${period.encodeURLParameter()}&timeZone=${timeZone.encodeURLParameter()}",
        )

    suspend fun aiUsageSessions(teamId: String, date: String, timeZone: String): TeamAiUsageSessionsWire =
        requestTyped(
            HttpMethod.Get,
            "/api/teams/${teamId.encodeURLPathPart()}/ai-usage/sessions?date=${date.encodeURLParameter()}&timeZone=${timeZone.encodeURLParameter()}",
        )

    suspend fun search(teamId: String, query: String, kind: String = "all", cursor: String? = null, limit: Int = 30): SearchPageWire {
        val qs = buildString {
            append("q=").append(query.encodeURLParameter())
            append("&kind=").append(kind.encodeURLParameter())
            append("&limit=").append(limit)
            if (!cursor.isNullOrBlank()) append("&cursor=").append(cursor.encodeURLParameter())
        }
        return requestTyped(HttpMethod.Get, "/api/teams/${teamId.encodeURLPathPart()}/search?$qs")
    }

    suspend fun scheduleSnapshot(teamId: String, machineId: String): List<ScheduledTaskWire> {
        val obj = requestJson(
            HttpMethod.Get,
            "/api/teams/${teamId.encodeURLPathPart()}/machines/${machineId.encodeURLPathPart()}/schedules",
        ).jsonObject
        return obj["tasks"]?.let { json.decodeFromJsonElement<List<ScheduledTaskWire>>(it) }.orEmpty()
    }

    suspend fun reauthenticateWithPassword(password: String) {
        requestJson(HttpMethod.Post, "/api/auth/reauthenticate", buildJsonObject { put("password", password) })
    }

    suspend fun sendReauthEmailCode(): JsonObject =
        requestJson(HttpMethod.Post, "/api/auth/reauthenticate/email", JsonObject(emptyMap())).jsonObject

    suspend fun verifyReauthEmailCode(challengeId: String, code: String) {
        requestJson(
            HttpMethod.Post,
            "/api/auth/reauthenticate/email/verify",
            buildJsonObject {
                put("challengeId", challengeId)
                put("code", code.trim())
            },
        )
    }

    suspend fun adminBillingTeams(search: String = "", cursor: String? = null): AdminTeamBillingPageWire {
        val qs = buildString {
            append("limit=20")
            if (search.isNotBlank()) append("&search=").append(search.trim().encodeURLParameter())
            if (!cursor.isNullOrBlank()) append("&cursor=").append(cursor.encodeURLParameter())
        }
        return requestTyped(HttpMethod.Get, "/api/admin/teams?$qs")
    }

    suspend fun adminSetManualGrant(teamId: String, plan: String?, expiresAtEpochMs: Long?, reason: String) {
        requestJson(
            HttpMethod.Put,
            "/api/admin/teams/${teamId.encodeURLPathPart()}/grant",
            buildJsonObject {
                put("plan", plan?.let { JsonPrimitive(it) } ?: JsonNull)
                put("expiresAt", expiresAtEpochMs?.let { JsonPrimitive(it) } ?: JsonNull)
                put("reason", reason.trim())
            },
        )
    }

    suspend fun adminUsers(query: String = ""): JsonArray {
        val el = requestJson(HttpMethod.Get, "/api/admin/users?query=${query.encodeURLParameter()}")
        return el as? JsonArray ?: JsonArray(emptyList())
    }

    suspend fun adminSetUserDisabled(userId: String, disabled: Boolean) {
        requestJson(
            HttpMethod.Patch,
            "/api/admin/users/${userId.encodeURLPathPart()}/disabled",
            buildJsonObject { put("disabled", disabled) },
        )
    }

    suspend fun adminSiteSettings(): JsonObject =
        requestJson(HttpMethod.Get, "/api/admin/site-settings").jsonObject

    suspend fun adminUpdateSiteSettings(patch: JsonObject): JsonObject =
        requestJson(HttpMethod.Patch, "/api/admin/site-settings", patch).jsonObject

    // --- Realtime `/api/client/ws` Loop ---

    fun ensureRealtimeRunning() {
        if (!isSignedIn || wsJob?.isActive == true) return
        wsJob = scope.launch {
            var retryDelay = WS_RETRY_MIN_MS
            while (isActive && isSignedIn) {
                val base = _account.value.serverUrl
                val wsUrl = when {
                    base.startsWith("https://") -> "wss://" + base.removePrefix("https://") + "/api/client/ws"
                    else -> "ws://" + base.removePrefix("http://") + "/api/client/ws"
                }
                var signOut4401 = false
                try {
                    val token = _account.value.token
                    val wsClient = if (!token.isNullOrBlank()) bearerHttp else http
                    wsClient.webSocket(urlString = wsUrl, request = {
                        if (token.isNullOrBlank() && !cookieOnlyMode) {
                            header(HttpHeaders.Origin, base)
                        }
                    }) {
                        if (!token.isNullOrBlank()) {
                            val authMsg = buildJsonObject {
                                put("type", "authenticate")
                                put("token", token)
                            }
                            send(Frame.Text(json.encodeToString(JsonObject.serializer(), authMsg)))
                        }
                        var lastReceived = currentTimeMillis()
                        val pinger = launch {
                            while (isActive) {
                                delay(WS_HEARTBEAT_MS)
                                if (currentTimeMillis() - lastReceived > WS_IDLE_TIMEOUT_MS) {
                                    close(CloseReason(CloseReason.Codes.GOING_AWAY, "idle timeout"))
                                    break
                                }
                                send(Frame.Text("""{"type":"ping"}"""))
                            }
                        }
                        try {
                            for (frame in incoming) {
                                lastReceived = currentTimeMillis()
                                if (frame is Frame.Text) {
                                    val obj = runCatching { json.parseToJsonElement(frame.readText()).jsonObject }.getOrNull()
                                        ?: continue
                                    when (obj["type"]?.jsonPrimitive?.contentOrNull) {
                                        "ready" -> {
                                            retryDelay = WS_RETRY_MIN_MS
                                            if (!_wsConnected.value) {
                                                _wsConnected.value = true
                                                _events.tryEmit(CentralRealtimeEvent.ConnectionChanged(true))
                                            }
                                        }
                                        "ping" -> send(Frame.Text("""{"type":"pong"}"""))
                                        "pong" -> Unit
                                        "catalogChanged" -> {
                                            val tid = obj["teamId"]?.jsonPrimitive?.contentOrNull.orEmpty()
                                            val mid = obj["machineId"]?.jsonPrimitive?.contentOrNull.orEmpty()
                                            val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull
                                            _events.tryEmit(CentralRealtimeEvent.CatalogChanged(tid, mid, sid))
                                        }
                                        "machinesChanged" -> {
                                            val tid = obj["teamId"]?.jsonPrimitive?.contentOrNull.orEmpty()
                                            _events.tryEmit(CentralRealtimeEvent.MachinesChanged(tid))
                                        }
                                        "presence" -> {
                                            val tid = obj["teamId"]?.jsonPrimitive?.contentOrNull.orEmpty()
                                            val mid = obj["machineId"]?.jsonPrimitive?.contentOrNull.orEmpty()
                                            val online = obj["online"]?.jsonPrimitive?.booleanOrNull ?: false
                                            _events.tryEmit(CentralRealtimeEvent.PresenceChanged(tid, mid, online))
                                        }
                                        "peerEvent" -> {
                                            val pid = obj["peerId"]?.jsonPrimitive?.contentOrNull.orEmpty()
                                            val ev = obj["event"] as? JsonObject ?: JsonObject(emptyMap())
                                            _events.tryEmit(CentralRealtimeEvent.PeerEvent(pid, ev))
                                        }
                                        "peerRevoked" -> {
                                            val pid = obj["peerId"]?.jsonPrimitive?.contentOrNull.orEmpty()
                                            val reason = obj["reason"]?.jsonPrimitive?.contentOrNull.orEmpty()
                                            _events.tryEmit(CentralRealtimeEvent.PeerRevoked(pid, reason))
                                        }
                                    }
                                }
                            }
                            val reason = closeReason.await()
                            if (reason?.code?.toInt() == 4401 || reason?.code?.toInt() == 4403) {
                                signOut4401 = true
                            }
                        } finally {
                            pinger.cancel()
                        }
                    }
                } catch (_: CancellationException) {
                    throw CancellationException()
                } catch (_: Throwable) {
                    // Transient network failure; reconnect with exponential backoff.
                } finally {
                    if (_wsConnected.value) {
                        _wsConnected.value = false
                        _events.tryEmit(CentralRealtimeEvent.ConnectionChanged(false))
                    }
                }
                if (signOut4401) {
                    clearSession()
                    break
                }
                delay(retryDelay)
                retryDelay = (retryDelay * 2).coerceAtMost(WS_RETRY_MAX_MS)
            }
        }
    }

    fun stopRealtime() {
        wsJob?.cancel()
        wsJob = null
        if (_wsConnected.value) {
            _wsConnected.value = false
            _events.tryEmit(CentralRealtimeEvent.ConnectionChanged(false))
        }
    }

    fun close() {
        stopRealtime()
        bearerHttp.close()
        http.close()
    }
}

internal expect fun currentTimeMillis(): Long
