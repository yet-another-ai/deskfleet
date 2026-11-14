package ai.yetanother.deskfleet.transport

import ai.yetanother.deskfleet.protocol.IceCandidateWire
import ai.yetanother.deskfleet.protocol.NatProbeResultWire
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal val bridgeJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
}

@OptIn(ExperimentalEncodingApi::class)
internal fun parseRtcBridgeEvent(rawJson: String): RtcPeerEvent {
    val obj = bridgeJson.parseToJsonElement(rawJson).jsonObject
    return when (obj["type"]?.jsonPrimitive?.content) {
        "iceCandidate" -> {
            val candEl = obj["candidate"]
            val cand = if (candEl == null || candEl.toString() == "null") {
                null
            } else {
                val co = candEl.jsonObject
                IceCandidateWire(
                    candidate = co["candidate"]?.jsonPrimitive?.content.orEmpty(),
                    sdpMid = co["sdpMid"]?.jsonPrimitive?.content,
                    sdpMLineIndex = co["sdpMLineIndex"]?.jsonPrimitive?.intOrNull
                        ?: co["sdpMlineIndex"]?.jsonPrimitive?.intOrNull,
                    usernameFragment = co["usernameFragment"]?.jsonPrimitive?.content,
                )
            }
            RtcPeerEvent.IceCandidate(cand)
        }
        "stateChanged" -> RtcPeerEvent.StateChanged(obj["state"]?.jsonPrimitive?.content ?: "new")
        "dataChannelOpen" -> RtcPeerEvent.DataChannelOpen(obj["label"]?.jsonPrimitive?.content.orEmpty())
        "dataChannelClosed" -> RtcPeerEvent.DataChannelClosed(obj["label"]?.jsonPrimitive?.content.orEmpty())
        "data" -> {
            val label = obj["label"]?.jsonPrimitive?.content.orEmpty()
            val b64 = obj["dataBase64"]?.jsonPrimitive?.content.orEmpty()
            val isStr = obj["isString"]?.jsonPrimitive?.booleanOrNull ?: false
            val bytes = if (b64.isEmpty()) ByteArray(0) else Base64.decode(b64)
            RtcPeerEvent.Data(label = label, bytes = bytes, isString = isStr)
        }
        "error" -> RtcPeerEvent.Error(
            message = obj["message"]?.jsonPrimitive?.content ?: "Peer error",
            reason = obj["reason"]?.jsonPrimitive?.content,
        )
        else -> RtcPeerEvent.Closed
    }
}

internal fun parseNatResultJson(rawJson: String): NatProbeResultWire =
    bridgeJson.decodeFromString(NatProbeResultWire.serializer(), rawJson)
