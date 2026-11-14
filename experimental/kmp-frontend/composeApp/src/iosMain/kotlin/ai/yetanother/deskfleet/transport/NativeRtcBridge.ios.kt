@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package ai.yetanother.deskfleet.transport

import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_last_error
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_open_local_network_settings
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_peer_accept_answer
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_peer_add_ice_candidate
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_peer_answer_offer
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_peer_close
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_peer_copy_video_frame
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_peer_create
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_peer_create_data_channel
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_peer_create_offer
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_peer_poll_event
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_peer_send_bytes
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_peer_send_text
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_request_local_network
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_string_free
import ai.yetanother.deskfleet.bridge.cinterop.deskfleet_kmp_test_nat
import ai.yetanother.deskfleet.protocol.IceCandidateWire
import ai.yetanother.deskfleet.protocol.NatProbeResultWire
import kotlin.concurrent.AtomicInt
import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.CPointer
import kotlinx.cinterop.UByteVar
import kotlinx.cinterop.UIntVar
import kotlinx.cinterop.ULongVar
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.toKString
import kotlinx.cinterop.usePinned
import kotlinx.cinterop.value
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.withContext

private fun takeOwnedCString(ptr: CPointer<ByteVar>?): String? {
    if (ptr == null) return null
    return try {
        ptr.toKString()
    } finally {
        deskfleet_kmp_string_free(ptr)
    }
}

private fun takeBridgeError(fallback: String): IllegalStateException =
    IllegalStateException(takeOwnedCString(deskfleet_kmp_last_error()) ?: fallback)

private class CInteropRtcPeerHandle(
    private val handle: ULong,
) : NativeRtcPeerHandle {
    private val closed = AtomicInt(0)
    private var frameBuffer = ByteArray(1920 * 1080 * 4)

    override suspend fun createDataChannel(label: String) = withContext(Dispatchers.IO) {
        if (!deskfleet_kmp_peer_create_data_channel(handle, label)) {
            throw takeBridgeError("createDataChannel failed")
        }
    }

    override suspend fun createOffer(): String = withContext(Dispatchers.IO) {
        takeOwnedCString(deskfleet_kmp_peer_create_offer(handle))
            ?: throw takeBridgeError("createOffer failed")
    }

    override suspend fun answerOffer(offerSdp: String): String = withContext(Dispatchers.IO) {
        takeOwnedCString(deskfleet_kmp_peer_answer_offer(handle, offerSdp))
            ?: throw takeBridgeError("answerOffer failed")
    }

    override suspend fun acceptAnswer(answerSdp: String) = withContext(Dispatchers.IO) {
        if (!deskfleet_kmp_peer_accept_answer(handle, answerSdp)) {
            throw takeBridgeError("acceptAnswer failed")
        }
    }

    override suspend fun addIceCandidate(candidate: IceCandidateWire) = withContext(Dispatchers.IO) {
        val json = bridgeJson.encodeToString(IceCandidateWire.serializer(), candidate)
        if (!deskfleet_kmp_peer_add_ice_candidate(handle, json)) {
            throw takeBridgeError("addIceCandidate failed")
        }
    }

    override suspend fun sendBytes(label: String, bytes: ByteArray) = withContext(Dispatchers.IO) {
        val ok = if (bytes.isEmpty()) {
            deskfleet_kmp_peer_send_bytes(handle, label, null, 0u)
        } else {
            bytes.usePinned { pinned ->
                deskfleet_kmp_peer_send_bytes(
                    handle,
                    label,
                    pinned.addressOf(0).reinterpret<UByteVar>(),
                    bytes.size.toULong(),
                )
            }
        }
        if (!ok) throw takeBridgeError("sendBytes failed")
    }

    override suspend fun sendText(label: String, text: String) = withContext(Dispatchers.IO) {
        if (!deskfleet_kmp_peer_send_text(handle, label, text)) {
            throw takeBridgeError("sendText failed")
        }
    }

    override suspend fun pollEvent(timeoutMs: Long): RtcPeerEvent? = withContext(Dispatchers.IO) {
        if (closed.value != 0) return@withContext RtcPeerEvent.Closed
        val raw = takeOwnedCString(deskfleet_kmp_peer_poll_event(handle, timeoutMs.coerceAtLeast(0L).toULong()))
            ?: return@withContext null
        parseRtcBridgeEvent(raw)
    }

    override fun pollVideoFrame(afterSeq: Long): DecodedVideoFrame? {
        if (closed.value != 0) return null
        return memScoped {
            val w = alloc<UIntVar>()
            val h = alloc<UIntVar>()
            val s = alloc<ULongVar>()
            var code = frameBuffer.usePinned { pinned ->
                deskfleet_kmp_peer_copy_video_frame(
                    handle,
                    afterSeq.coerceAtLeast(0L).toULong(),
                    pinned.addressOf(0).reinterpret<UByteVar>(),
                    frameBuffer.size.toULong(),
                    w.ptr,
                    h.ptr,
                    s.ptr,
                )
            }
            if (code == 0) return@memScoped null
            val needed = w.value.toInt() * h.value.toInt() * 4
            if (code == -1 && needed > 0) {
                frameBuffer = ByteArray(needed)
                code = frameBuffer.usePinned { pinned ->
                    deskfleet_kmp_peer_copy_video_frame(
                        handle,
                        afterSeq.coerceAtLeast(0L).toULong(),
                        pinned.addressOf(0).reinterpret<UByteVar>(),
                        frameBuffer.size.toULong(),
                        w.ptr,
                        h.ptr,
                        s.ptr,
                    )
                }
            }
            if (code != 1) return@memScoped null
            DecodedVideoFrame(
                seq = s.value.toLong(),
                width = w.value.toInt(),
                height = h.value.toInt(),
                bgraBytes = frameBuffer.copyOf(needed),
            )
        }
    }

    override fun close() {
        if (closed.compareAndSet(0, 1)) {
            deskfleet_kmp_peer_close(handle)
        }
    }
}

actual object NativeRtcBridge {
    actual val isAvailable: Boolean = true

    actual suspend fun createPeer(config: RtcPeerCreateConfig): NativeRtcPeerHandle =
        withContext(Dispatchers.IO) {
            val json = bridgeJson.encodeToString(RtcPeerCreateConfig.serializer(), config)
            val handle = deskfleet_kmp_peer_create(json)
            if (handle == 0uL) throw takeBridgeError("Failed to create native WebRTC peer")
            CInteropRtcPeerHandle(handle)
        }

    actual suspend fun testNat(server: String): NatProbeResultWire = withContext(Dispatchers.IO) {
        val raw = takeOwnedCString(deskfleet_kmp_test_nat(server))
            ?: throw takeBridgeError("NAT test failed")
        parseNatResultJson(raw)
    }

    actual suspend fun requestLocalNetworkAccess(): String = withContext(Dispatchers.IO) {
        takeOwnedCString(deskfleet_kmp_request_local_network()) ?: "not-required"
    }

    actual suspend fun openLocalNetworkSettings() = withContext(Dispatchers.IO) {
        deskfleet_kmp_open_local_network_settings()
        Unit
    }
}
