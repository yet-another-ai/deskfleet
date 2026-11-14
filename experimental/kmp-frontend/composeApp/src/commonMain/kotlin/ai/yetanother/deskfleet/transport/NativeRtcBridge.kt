package ai.yetanother.deskfleet.transport

import ai.yetanother.deskfleet.protocol.IceCandidateWire
import ai.yetanother.deskfleet.protocol.IceServerWire
import ai.yetanother.deskfleet.protocol.NatProbeResultWire
import kotlinx.serialization.Serializable

@Serializable
data class RtcPeerCreateConfig(
    val iceServers: List<IceServerWire> = emptyList(),
    val relayOnly: Boolean = false,
    val videoCodec: String? = null,
)

class DecodedVideoFrame(
    val seq: Long,
    val width: Int,
    val height: Int,
    val bgraBytes: ByteArray,
)

sealed interface RtcPeerEvent {
    data class IceCandidate(val candidate: IceCandidateWire?) : RtcPeerEvent
    data class StateChanged(val state: String) : RtcPeerEvent
    data class DataChannelOpen(val label: String) : RtcPeerEvent
    data class DataChannelClosed(val label: String) : RtcPeerEvent
    data class Data(val label: String, val bytes: ByteArray, val isString: Boolean) : RtcPeerEvent
    data class Error(val message: String, val reason: String? = null) : RtcPeerEvent
    data object Closed : RtcPeerEvent
}

interface NativeRtcPeerHandle {
    suspend fun createDataChannel(label: String)
    suspend fun createOffer(): String
    suspend fun answerOffer(offerSdp: String): String
    suspend fun acceptAnswer(answerSdp: String)
    suspend fun addIceCandidate(candidate: IceCandidateWire)
    suspend fun sendBytes(label: String, bytes: ByteArray)
    suspend fun sendText(label: String, text: String)
    suspend fun pollEvent(timeoutMs: Long = 250L): RtcPeerEvent?
    fun pollVideoFrame(afterSeq: Long): DecodedVideoFrame?
    fun close()
}

expect object NativeRtcBridge {
    val isAvailable: Boolean
    suspend fun createPeer(config: RtcPeerCreateConfig): NativeRtcPeerHandle
    suspend fun testNat(server: String): NatProbeResultWire
    suspend fun requestLocalNetworkAccess(): String
    suspend fun openLocalNetworkSettings()
}
