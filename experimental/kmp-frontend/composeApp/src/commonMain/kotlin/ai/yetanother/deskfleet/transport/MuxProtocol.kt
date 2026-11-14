package ai.yetanother.deskfleet.transport

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

const val MUX_CAPABILITY_VERSION = "fixed4-v1"
const val MUX_FRAME_BYTES = 16 * 1024
const val MUX_MESSAGE_BYTES = 64 * 1024
const val MUX_HEADER_BYTES = 17
const val MUX_MAX_PAYLOAD_BYTES = MUX_FRAME_BYTES - MUX_HEADER_BYTES // 16,367
const val MUX_MIN_FRAME_COST = 1024
const val MUX_WINDOW_BYTES = 128 * 1024
const val MUX_STREAM_QUEUE_BYTES = 512 * 1024
const val MUX_CONNECTION_QUEUE_BYTES = 8 * 1024 * 1024
const val MUX_MAX_STREAMS = 128

enum class MuxLane(val label: String) {
    CONTROL("deskfleet-mux-control"),
    TERMINAL("deskfleet-mux-terminal"),
    AGENT("deskfleet-mux-agent"),
    BULK("deskfleet-mux-bulk"),
    ;

    companion object {
        fun fromLabel(label: String): MuxLane? = entries.firstOrNull { it.label == label }
    }
}

enum class MuxPurpose(val wire: String) {
    TERMINAL("terminal"),
    AGENT("agent"),
    FILES("files"),
    PORTS("ports"),
    ;

    val defaultLane: MuxLane
        get() = when (this) {
            TERMINAL -> MuxLane.TERMINAL
            AGENT -> MuxLane.AGENT
            FILES, PORTS -> MuxLane.BULK
        }

    fun allowsLane(lane: MuxLane): Boolean = when (this) {
        TERMINAL -> lane == MuxLane.TERMINAL || lane == MuxLane.BULK
        AGENT -> lane == MuxLane.AGENT || lane == MuxLane.BULK
        FILES, PORTS -> lane == MuxLane.BULK
    }

    companion object {
        fun fromWire(wire: String): MuxPurpose? = entries.firstOrNull { it.wire == wire }
    }
}

@Serializable
data class MuxControlEnvelope(
    val type: String, // "open" | "opened" | "credit" | "close"
    val id: Long,
    val purpose: String? = null,
    val bytes: Int? = null,
    val error: String? = null,
)

class MuxFrame(
    val id: Long,
    val sequence: Long,
    val offset: Int,
    val total: Int,
    val text: Boolean,
    val data: ByteArray,
)

fun muxFrameCost(wireByteLength: Int): Int = maxOf(MUX_MIN_FRAME_COST, wireByteLength)

private val muxJson = Json {
    ignoreUnknownKeys = false
    encodeDefaults = false
}

fun encodeMuxControl(control: MuxControlEnvelope): ByteArray {
    val bytes = muxJson.encodeToString(MuxControlEnvelope.serializer(), control).encodeToByteArray()
    require(bytes.size <= 1024) { "Mux control frame exceeds 1024 bytes" }
    return bytes
}

fun decodeMuxControl(bytes: ByteArray): MuxControlEnvelope {
    require(bytes.size in 2..1024) { "Invalid Mux control frame length: ${bytes.size}" }
    val decoded = muxJson.decodeFromString(MuxControlEnvelope.serializer(), bytes.decodeToString())
    require(decoded.id in 1L..0xFFFFFFFFL) { "Invalid Mux stream id: ${decoded.id}" }
    return decoded
}

private fun putU32Be(buf: ByteArray, pos: Int, value: Long) {
    buf[pos] = ((value ushr 24) and 0xFF).toByte()
    buf[pos + 1] = ((value ushr 16) and 0xFF).toByte()
    buf[pos + 2] = ((value ushr 8) and 0xFF).toByte()
    buf[pos + 3] = (value and 0xFF).toByte()
}

private fun getU32Be(buf: ByteArray, pos: Int): Long =
    ((buf[pos].toLong() and 0xFFL) shl 24) or
        ((buf[pos + 1].toLong() and 0xFFL) shl 16) or
        ((buf[pos + 2].toLong() and 0xFFL) shl 8) or
        (buf[pos + 3].toLong() and 0xFFL)

fun encodeMuxFrame(frame: MuxFrame): ByteArray {
    require(frame.id in 1L..0xFFFFFFFFL) { "Invalid Mux stream ID" }
    require(frame.sequence in 0L..0xFFFFFFFFL) { "Invalid Mux sequence" }
    require(frame.total in 0..MUX_MESSAGE_BYTES) { "Invalid Mux total" }
    require(frame.data.size <= MUX_MAX_PAYLOAD_BYTES) { "Mux frame payload exceeds limit" }
    val out = ByteArray(MUX_HEADER_BYTES + frame.data.size)
    putU32Be(out, 0, frame.id)
    putU32Be(out, 4, frame.sequence)
    putU32Be(out, 8, frame.offset.toLong())
    putU32Be(out, 12, frame.total.toLong())
    out[16] = if (frame.text) 1 else 0
    frame.data.copyInto(out, destinationOffset = MUX_HEADER_BYTES)
    return out
}

fun decodeMuxFrame(bytes: ByteArray): MuxFrame {
    require(bytes.size in MUX_HEADER_BYTES..MUX_FRAME_BYTES) { "Mux frame out of bounds: ${bytes.size}" }
    val id = getU32Be(bytes, 0)
    val sequence = getU32Be(bytes, 4)
    val offset = getU32Be(bytes, 8).toInt()
    val total = getU32Be(bytes, 12).toInt()
    val flag = bytes[16].toInt() and 0xFF
    require(id >= 1L && (flag == 0 || flag == 1)) { "Invalid Mux frame header" }
    val payloadLen = bytes.size - MUX_HEADER_BYTES
    require(total <= MUX_MESSAGE_BYTES && offset <= total && offset + payloadLen <= total) {
        "Invalid Mux fragment bounds"
    }
    require(!(total > 0 && payloadLen == 0)) { "Empty non-zero Mux fragment" }
    val payload = bytes.copyOfRange(MUX_HEADER_BYTES, bytes.size)
    return MuxFrame(
        id = id,
        sequence = sequence,
        offset = offset,
        total = total,
        text = flag == 1,
        data = payload,
    )
}
