package ai.yetanother.deskfleet.transport

import ai.yetanother.deskfleet.platform.*
import ai.yetanother.deskfleet.protocol.IceCandidateWire
import ai.yetanother.deskfleet.protocol.NatProbeResultWire
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

actual object NativeRtcBridge {
    actual val isAvailable: Boolean = true

    actual suspend fun createPeer(config: RtcPeerCreateConfig): NativeRtcPeerHandle {
        val cfgJson = bridgeJson.encodeToString(RtcPeerCreateConfig.serializer(), config)
        val peerId = jsRtcCreatePeer(cfgJson)
        return BrowserRtcPeerHandle(peerId)
    }

    actual suspend fun testNat(server: String): NatProbeResultWire {
        val raw = jsRtcProbeNatPromise(server).awaitJsString()
        return parseNatResultJson(raw)
    }

    actual suspend fun requestLocalNetworkAccess(): String = "granted"

    actual suspend fun openLocalNetworkSettings() = Unit
}

private class BrowserRtcPeerHandle(
    private val peerId: Int,
) : NativeRtcPeerHandle {

    override suspend fun createDataChannel(label: String) {
        jsRtcCreateDataChannel(peerId, label)
    }

    override suspend fun createOffer(): String =
        jsRtcCreateOfferPromise(peerId).awaitJsString()

    override suspend fun answerOffer(offerSdp: String): String =
        jsRtcAnswerOfferPromise(peerId, offerSdp).awaitJsString()

    override suspend fun acceptAnswer(answerSdp: String) {
        jsRtcAcceptAnswerPromise(peerId, answerSdp).awaitJsString()
    }

    override suspend fun addIceCandidate(candidate: IceCandidateWire) {
        val candJson = bridgeJson.encodeToString(IceCandidateWire.serializer(), candidate)
        jsRtcAddIceCandidatePromise(peerId, candJson).awaitJsString()
    }

    @OptIn(ExperimentalEncodingApi::class)
    override suspend fun sendBytes(label: String, bytes: ByteArray) {
        jsRtcSendBase64(peerId, label, Base64.encode(bytes))
    }

    override suspend fun sendText(label: String, text: String) {
        jsRtcSendText(peerId, label, text)
    }

    override suspend fun pollEvent(timeoutMs: Long): RtcPeerEvent? {
        val raw = jsRtcPollEventPromise(peerId, timeoutMs.toInt().coerceAtLeast(20)).awaitJsString()
        if (raw.isBlank()) return null
        return parseRtcBridgeEvent(raw)
    }

    @OptIn(ExperimentalEncodingApi::class)
    override fun pollVideoFrame(afterSeq: Long): DecodedVideoFrame? {
        val raw = jsRtcPollVideoFrameJson(peerId, afterSeq.toInt())
        if (raw.isBlank()) return null
        val obj = bridgeJson.parseToJsonElement(raw).jsonObject
        val seq = obj["seq"]?.jsonPrimitive?.longOrNull ?: return null
        val w = obj["width"]?.jsonPrimitive?.intOrNull ?: return null
        val h = obj["height"]?.jsonPrimitive?.intOrNull ?: return null
        val b64 = obj["bgraBase64"]?.jsonPrimitive?.content ?: return null
        return DecodedVideoFrame(
            seq = seq,
            width = w,
            height = h,
            bgraBytes = Base64.decode(b64),
        )
    }

    override fun close() {
        jsRtcClose(peerId)
    }
}

internal actual fun currentTimeMillis(): Long = jsDateNowDouble().toLong()
