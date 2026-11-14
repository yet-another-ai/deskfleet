package ai.yetanother.deskfleet.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

const val DESKFLEET_PROTOCOL_VERSION: Int = 1

@Serializable
data class AuthUser(
    val id: String,
    val email: String,
    val name: String = "",
    val avatarUrl: String? = null,
    val emailVerified: Boolean = true,
    val hasPassword: Boolean = true,
    val siteAdmin: Boolean = false,
    val createdAt: String? = null,
)

@Serializable
data class AuthStartRequest(
    val returnTo: String,
)

@Serializable
data class AuthStartResponse(
    val authorizationUrl: String,
    val loginVerifier: String,
)

@Serializable
data class AuthExchangeRequest(
    val code: String,
    val loginVerifier: String,
)

@Serializable
data class AuthTokenResponse(
    val token: String,
    val user: AuthUser,
)

@Serializable
data class AuthLoginRequest(
    val email: String,
    val password: String,
)

@Serializable
data class AuthRegisterRequest(
    val email: String,
    val name: String = "",
    val password: String? = null,
)

@Serializable
data class AuthDesktopCompleteRequest(
    val returnTo: String,
)

@Serializable
data class AuthDesktopCompleteResponse(
    val redirectUrl: String,
)

@Serializable
data class AuthSessionRecord(
    val id: String,
    val current: Boolean = false,
    val userAgent: String? = null,
    val ipAddress: String? = null,
    val createdAt: String = "",
    val lastActiveAt: String? = null,
)

@Serializable
data class PasskeySummary(
    val id: String,
    val name: String,
    val createdAt: String = "",
    val lastUsedAt: String? = null,
)

@Serializable
data class AccountSecuritySnapshot(
    val hasPassword: Boolean = true,
    val pendingEmail: String? = null,
    val passkeys: List<PasskeySummary> = emptyList(),
    val sessions: List<AuthSessionRecord> = emptyList(),
)

@Serializable
data class TeamSummary(
    val id: String,
    val name: String,
    val slug: String = "",
    val role: String = "member", // "owner" | "admin" | "member"
    val personal: Boolean = false,
    val avatarUrl: String? = null,
    val createdAt: String = "",
)

@Serializable
data class TeamMember(
    val userId: String,
    val email: String,
    val name: String = "",
    val avatarUrl: String? = null,
    val role: String = "member",
    val joinedAt: String = "",
)

@Serializable
data class TeamInvite(
    val id: String,
    val email: String,
    val role: String = "member",
    val token: String? = null,
    val inviteUrl: String? = null,
    val expiresAt: String = "",
    val createdAt: String = "",
)

@Serializable
data class MachineCapabilities(
    val mux: String? = null,
    val muxServer: String? = null,
    val desktop: Boolean = true,
    val terminal: Boolean = true,
    val files: Boolean = true,
    val agents: Boolean = true,
    val windowsDesktopService: Boolean = false,
    val secureAttention: Boolean = false,
    val codecs: List<String> = listOf("h264"),
)

@Serializable
data class MachineAccessPolicy(
    val defaultRole: String = "operate", // "none" | "read" | "operate" | "session" | "full"
    val memberOverrides: Map<String, String> = emptyMap(),
    val agentRemoteAccess: String = "read", // "none" | "read" | "operate" | "session"
)

@Serializable
data class MachineSummary(
    val id: String,
    val teamId: String = "",
    val name: String,
    val os: String = "darwin", // "darwin" | "linux" | "win32"
    val arch: String = "arm64",
    val hostname: String = "",
    val online: Boolean = false,
    val version: String? = null,
    val lastSeenAt: String? = null,
    val access: String = "full",
    val capabilities: Map<String, JsonElement>? = emptyMap(),
    val accessPolicy: MachineAccessPolicy? = null,
) {
    val supportsFixed4Mux: Boolean
        get() {
            val caps = capabilities.orEmpty()
            val m = caps["mux"]?.toString()?.trim('"')
            val s = caps["muxServer"]?.toString()?.trim('"')
            return m == "fixed4-v1" && (s == null || s == "fixed4-v1")
        }
}

@Serializable
data class EnrollmentTokenResponse(
    val enrollmentToken: String,
    val expiresAt: String = "",
    val serverUrl: String = "",
    val command: String = "",
)

@Serializable
data class IceServerWire(
    val urls: List<String> = emptyList(),
    val username: String? = null,
    val credential: String? = null,
)

@Serializable
data class IceCandidateWire(
    val candidate: String,
    val sdpMid: String? = null,
    @SerialName("sdpMLineIndex")
    val sdpMLineIndex: Int? = null,
    val usernameFragment: String? = null,
)

@Serializable
data class PeerAuthorizationWire(
    val peerId: String,
    val serverId: String = "",
    val teamId: String = "",
    val transport: String = "webrtc",
    val purpose: String = "mux",
    val actions: List<String> = emptyList(),
    val issuedAt: String = "",
    val expiresAt: String = "",
)

@Serializable
data class CreatePeerRequest(
    val teamId: String,
    val machineId: String,
    val purpose: String, // "mux" | "agent" | "terminal" | "files" | "ports" | "desktop"
)

@Serializable
data class PeerGrantWire(
    val peerId: String,
    val authorization: PeerAuthorizationWire? = null,
    val iceServers: List<IceServerWire> = emptyList(),
    val relayDeniedReason: String? = null,
)

@Serializable
data class CreateLocalPeerRequest(
    val teamId: String,
    val machineId: String,
    val purpose: String,
)

@Serializable
data class LocalPeerGrantWire(
    val peerId: String,
    val authorization: PeerAuthorizationWire? = null,
    val token: String,
)

@Serializable
data class PeerOfferOptionsWire(
    val codec: String? = null,
    val audio: Boolean? = null,
)

@Serializable
data class OfferPeerRequest(
    val sdp: String,
    val options: PeerOfferOptionsWire? = null,
)

@Serializable
data class OfferPeerResponse(
    val sdp: String,
)

@Serializable
data class CandidatePeerRequest(
    val candidate: IceCandidateWire,
)

@Serializable
data class StartPeerRequest(
    val control: Boolean = true,
    val displayId: String? = null,
    val maxFps: Int? = null,
    val quality: String? = null,
)

@Serializable
data class CentralRpcRequest(
    val method: String,
    val params: JsonElement = JsonObject(emptyMap()),
)

@Serializable
data class CentralErrorPayload(
    val error: String? = null,
    val code: String? = null,
    val reason: String? = null,
    val details: String? = null,
)

class CentralApiException(
    val statusCode: Int,
    override val message: String,
    val code: String? = null,
    val reason: String? = null,
) : Exception(message)
