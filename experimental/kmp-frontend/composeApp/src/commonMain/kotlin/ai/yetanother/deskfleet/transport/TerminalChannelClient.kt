package ai.yetanother.deskfleet.transport

import ai.yetanother.deskfleet.protocol.TerminalSummary
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

sealed interface TerminalStreamEvent {
    data class Reset(val terminalId: String) : TerminalStreamEvent
    data class Ready(val terminalId: String) : TerminalStreamEvent
    data class Output(val terminalId: String, val rawBytes: ByteArray, val offset: Long) : TerminalStreamEvent
    data class Exited(val terminalId: String, val exitCode: Int?) : TerminalStreamEvent
    data class HungUp(val terminalId: String) : TerminalStreamEvent
    data class StreamError(val terminalId: String, val message: String) : TerminalStreamEvent
}

/**
 * Terminal DataChannel client (`deskfleet-terminal` or `fixed4-v1` `terminal` stream).
 * CRITICAL WIRE RULES (`apps/daemon/src/terminal-protocol.ts`):
 * - Every frame MUST be UTF-8 TEXT (`sendText`, `text = true` in Mux), one JSON object per frame (NOT NDJSON).
 * - Immediately send `{"ack":{"sessionId":...,"offset":event.offset}}` after consuming each `output` chunk
 *   so the 1 MiB replay window never stalls before emitting `ready`!
 */
class TerminalChannelClient(
    private val scope: CoroutineScope,
    private val channel: DeskFleetChannel,
    private val onEvent: suspend (TerminalStreamEvent) -> Unit,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
    }
    private val pendingLock = Mutex()
    private val pendingCalls = mutableMapOf<Long, CompletableDeferred<JsonElement>>()
    private var nextId = 1L

    init {
        channel.onMessage = { payload ->
            val raw = when (payload) {
                is ChannelPayload.Text -> payload.text
                is ChannelPayload.Binary -> payload.bytes.decodeToString()
            }
            handleFrame(raw)
        }
        channel.onClose = { err ->
            scope.launch {
                val list = pendingLock.withLock {
                    val copy = pendingCalls.values.toList()
                    pendingCalls.clear()
                    copy
                }
                val ex = err ?: IllegalStateException("Terminal channel closed")
                list.forEach { it.completeExceptionally(ex) }
            }
        }
    }

    private suspend fun call(method: String, params: JsonObject): JsonElement {
        channel.ready.await()
        val (id, def) = pendingLock.withLock {
            val reqId = nextId++
            val d = CompletableDeferred<JsonElement>()
            pendingCalls[reqId] = d
            reqId to d
        }
        val frame = buildJsonObject {
            put("id", id)
            put("method", method)
            put("params", params)
        }
        try {
            channel.sendText(json.encodeToString(JsonObject.serializer(), frame))
        } catch (err: Throwable) {
            pendingLock.withLock { pendingCalls.remove(id) }
            throw err
        }
        return def.await()
    }

    @OptIn(ExperimentalEncodingApi::class)
    private suspend fun handleFrame(raw: String) {
        val obj = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        val evObj = obj["event"] as? JsonObject
        if (evObj != null) {
            val sid = evObj["sessionId"]?.jsonPrimitive?.content.orEmpty()
            when (evObj["kind"]?.jsonPrimitive?.content) {
                "reset" -> onEvent(TerminalStreamEvent.Reset(sid))
                "ready" -> onEvent(TerminalStreamEvent.Ready(sid))
                "hungup" -> onEvent(TerminalStreamEvent.HungUp(sid))
                "output" -> {
                    val b64 = evObj["data"]?.jsonPrimitive?.content.orEmpty()
                    val offset = evObj["offset"]?.jsonPrimitive?.longOrNull ?: 0L
                    val bytes = if (b64.isEmpty()) ByteArray(0) else Base64.decode(b64)
                    onEvent(TerminalStreamEvent.Output(sid, bytes, offset))
                    // Mandatory cumulative-offset ACK so daemon replay window advances!
                    sendAck(sid, offset)
                }
                "exit" -> {
                    val code = evObj["exitCode"]?.jsonPrimitive?.intOrNull
                    onEvent(TerminalStreamEvent.Exited(sid, code))
                }
                "error" -> {
                    val msg = evObj["error"]?.jsonPrimitive?.content ?: "Terminal error"
                    onEvent(TerminalStreamEvent.StreamError(sid, msg))
                }
            }
            return
        }
        val id = obj["id"]?.jsonPrimitive?.longOrNull ?: return
        val waiter = pendingLock.withLock { pendingCalls.remove(id) } ?: return
        val errText = obj["error"]?.jsonPrimitive?.contentOrNull
        if (errText != null) {
            waiter.completeExceptionally(IllegalStateException(errText))
        } else {
            waiter.complete(obj["result"] ?: JsonNull)
        }
    }

    private suspend fun sendAck(terminalId: String, offset: Long) {
        val ack = buildJsonObject {
            put("ack", buildJsonObject {
                put("sessionId", terminalId)
                put("offset", offset)
            })
        }
        runCatching {
            channel.sendText(json.encodeToString(JsonObject.serializer(), ack))
        }
    }

    suspend fun attach(terminalId: String): TerminalSummary {
        val res = call("attach", buildJsonObject { put("sessionId", terminalId) })
        return json.decodeFromJsonElement(TerminalSummary.serializer(), res)
    }

    suspend fun detach(terminalId: String) {
        runCatching { call("detach", buildJsonObject { put("sessionId", terminalId) }) }
    }

    @OptIn(ExperimentalEncodingApi::class)
    suspend fun sendInput(terminalId: String, data: String) {
        call(
            "input",
            buildJsonObject {
                put("sessionId", terminalId)
                put("data", Base64.encode(data.encodeToByteArray()))
            },
        )
    }

    suspend fun resize(terminalId: String, cols: Int, rows: Int) {
        call(
            "resize",
            buildJsonObject {
                put("sessionId", terminalId)
                put("cols", cols)
                put("rows", rows)
            },
        )
    }

    fun close() {
        channel.close()
    }
}
