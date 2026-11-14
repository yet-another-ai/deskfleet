package ai.yetanother.deskfleet.transport

import ai.yetanother.deskfleet.protocol.IceCandidateWire
import ai.yetanother.deskfleet.protocol.NatProbeResultWire
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private class JniRtcPeerHandle(
    private val handle: Long,
) : NativeRtcPeerHandle {
    private val closed = AtomicBoolean(false)

    override suspend fun createDataChannel(label: String) = withContext(Dispatchers.IO) {
        NativeBridgeJni.peerCreateDataChannel(handle, label)
        Unit
    }

    override suspend fun createOffer(): String = withContext(Dispatchers.IO) {
        NativeBridgeJni.peerCreateOffer(handle)
    }

    override suspend fun answerOffer(offerSdp: String): String = withContext(Dispatchers.IO) {
        NativeBridgeJni.peerAnswerOffer(handle, offerSdp)
    }

    override suspend fun acceptAnswer(answerSdp: String) = withContext(Dispatchers.IO) {
        NativeBridgeJni.peerAcceptAnswer(handle, answerSdp)
        Unit
    }

    override suspend fun addIceCandidate(candidate: IceCandidateWire) = withContext(Dispatchers.IO) {
        val json = bridgeJson.encodeToString(IceCandidateWire.serializer(), candidate)
        NativeBridgeJni.peerAddIceCandidate(handle, json)
        Unit
    }

    override suspend fun sendBytes(label: String, bytes: ByteArray) = withContext(Dispatchers.IO) {
        NativeBridgeJni.peerSendBytes(handle, label, bytes)
        Unit
    }

    override suspend fun sendText(label: String, text: String) = withContext(Dispatchers.IO) {
        NativeBridgeJni.peerSendText(handle, label, text)
        Unit
    }

    override suspend fun pollEvent(timeoutMs: Long): RtcPeerEvent? = withContext(Dispatchers.IO) {
        if (closed.get()) return@withContext RtcPeerEvent.Closed
        val raw = NativeBridgeJni.peerPollEvent(handle, timeoutMs) ?: return@withContext null
        parseRtcBridgeEvent(raw)
    }

    override fun pollVideoFrame(afterSeq: Long): DecodedVideoFrame? {
        if (closed.get()) return null
        val meta = LongArray(3)
        val bytes = NativeBridgeJni.peerPollVideoFrame(handle, afterSeq, meta) ?: return null
        return DecodedVideoFrame(
            seq = meta[0],
            width = meta[1].toInt(),
            height = meta[2].toInt(),
            bgraBytes = bytes,
        )
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) {
            runCatching { NativeBridgeJni.peerClose(handle) }
        }
    }
}

actual object NativeRtcBridge {
    actual val isAvailable: Boolean
        get() = NativeBridgeJni.loaded

    actual suspend fun createPeer(config: RtcPeerCreateConfig): NativeRtcPeerHandle =
        withContext(Dispatchers.IO) {
            check(NativeBridgeJni.loaded) { "Native WebRTC bridge library is not loaded" }
            val json = bridgeJson.encodeToString(RtcPeerCreateConfig.serializer(), config)
            val handle = NativeBridgeJni.peerCreate(json)
            check(handle != 0L) { "Failed to create native WebRTC peer" }
            JniRtcPeerHandle(handle)
        }

    actual suspend fun testNat(server: String): NatProbeResultWire = withContext(Dispatchers.IO) {
        check(NativeBridgeJni.loaded) { "Native WebRTC bridge library is not loaded" }
        parseNatResultJson(NativeBridgeJni.testNat(server))
    }

    actual suspend fun requestLocalNetworkAccess(): String = withContext(Dispatchers.IO) {
        if (!NativeBridgeJni.loaded) "not-required" else NativeBridgeJni.requestLocalNetwork()
    }

    actual suspend fun openLocalNetworkSettings() = withContext(Dispatchers.IO) {
        if (NativeBridgeJni.loaded) {
            NativeBridgeJni.openLocalNetworkSettings()
        }
    }
}
