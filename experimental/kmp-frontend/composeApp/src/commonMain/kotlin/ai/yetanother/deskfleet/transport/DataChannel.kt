package ai.yetanother.deskfleet.transport

import kotlinx.coroutines.CompletableDeferred

enum class ChannelState {
    CONNECTING,
    OPEN,
    CLOSED,
}

sealed interface ChannelPayload {
    data class Text(val text: String) : ChannelPayload
    data class Binary(val bytes: ByteArray) : ChannelPayload
}

/**
 * Unified message channel carried over Local Daemon IPC (`localOpen`/`localSend`/`localAck`),
 * `fixed4-v1` WebRTC Mux (`MuxStream`), or single-purpose WebRTC DataChannels.
 */
interface DeskFleetChannel {
    val state: ChannelState
    val ready: CompletableDeferred<Unit>
    var onMessage: (suspend (ChannelPayload) -> Unit)?
    var onClose: ((Throwable?) -> Unit)?
    suspend fun sendText(text: String, bulk: Boolean = false)
    suspend fun sendBinary(bytes: ByteArray, bulk: Boolean = false)
    fun close(reason: Throwable? = null)
}
