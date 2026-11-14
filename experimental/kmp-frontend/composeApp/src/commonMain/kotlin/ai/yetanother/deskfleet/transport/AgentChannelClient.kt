package ai.yetanother.deskfleet.transport

import ai.yetanother.deskfleet.protocol.DESKFLEET_PROTOCOL_VERSION
import ai.yetanother.deskfleet.protocol.JsonRpcRequest
import ai.yetanother.deskfleet.protocol.JsonRpcResponse
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

private const val ACP_NDJSON_SLICE_BYTES = 16 * 1024

/**
 * ACP Agent DataChannel client (`deskfleet-acp` or `fixed4-v1` `agent` stream).
 * CRITICAL WIRE RULE:
 * - Every outgoing message MUST be sent as BINARY (`sendBinary`, `text = false` in Mux)
 *   containing UTF-8 NDJSON (`\n`-terminated) sliced into `<= 16 KiB` chunks!
 * - First RPC after channel open MUST be `initialize { protocolVersion: 1 }`.
 */
class AgentChannelClient(
    private val scope: CoroutineScope,
    private val channel: DeskFleetChannel,
    private val onNotification: suspend (method: String, params: JsonObject) -> Unit,
    private val onServerRequest: suspend (id: JsonElement, method: String, params: JsonObject) -> JsonElement,
    private val onDisconnected: (Throwable?) -> Unit = {},
) {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
        explicitNulls = false
    }
    private val writeLock = Mutex()
    private val pendingLock = Mutex()
    private val pendingCalls = mutableMapOf<Long, CompletableDeferred<JsonElement>>()
    private var nextRpcId = 1L
    private var lineBuffer = StringBuilder()
    private var initialized = false

    init {
        channel.onMessage = { payload ->
            val chunkText = when (payload) {
                is ChannelPayload.Binary -> payload.bytes.decodeToString()
                is ChannelPayload.Text -> payload.text
            }
            processIncomingChunk(chunkText)
        }
        channel.onClose = { err ->
            scope.launch {
                failAllPending(err ?: IllegalStateException("Agent channel closed"))
                onDisconnected(err)
            }
        }
    }

    suspend fun initializeIfNeeded(): JsonElement {
        if (initialized) return JsonObject(emptyMap())
        channel.ready.await()
        val res = call(
            "initialize",
            buildJsonObject {
                put("protocolVersion", DESKFLEET_PROTOCOL_VERSION)
                put("clientCapabilities", buildJsonObject {
                    put("terminal", true)
                    put("fs", buildJsonObject {
                        put("readTextFile", true)
                        put("writeTextFile", true)
                    })
                })
            },
        )
        initialized = true
        return res
    }

    suspend fun call(method: String, params: JsonElement = JsonObject(emptyMap()), bulk: Boolean = false): JsonElement {
        channel.ready.await()
        val (id, deferred) = pendingLock.withLock {
            val rpcId = nextRpcId++
            val def = CompletableDeferred<JsonElement>()
            pendingCalls[rpcId] = def
            rpcId to def
        }
        val req = JsonRpcRequest(id = id, method = method, params = params)
        val lineBytes = (json.encodeToString(JsonRpcRequest.serializer(), req) + "\n").encodeToByteArray()
        try {
            sendBinaryNdjsonSlices(lineBytes, bulk)
        } catch (err: Throwable) {
            pendingLock.withLock { pendingCalls.remove(id) }
            throw err
        }
        return deferred.await()
    }

    private suspend fun sendRawJsonLine(obj: JsonObject) {
        val lineBytes = (json.encodeToString(JsonObject.serializer(), obj) + "\n").encodeToByteArray()
        sendBinaryNdjsonSlices(lineBytes, bulk = false)
    }

    private suspend fun sendBinaryNdjsonSlices(bytes: ByteArray, bulk: Boolean) {
        writeLock.withLock {
            var offset = 0
            while (offset < bytes.size) {
                val end = minOf(bytes.size, offset + ACP_NDJSON_SLICE_BYTES)
                channel.sendBinary(bytes.copyOfRange(offset, end), bulk = bulk)
                offset = end
            }
        }
    }

    private suspend fun processIncomingChunk(chunk: String) {
        lineBuffer.append(chunk)
        while (true) {
            val nl = lineBuffer.indexOf('\n')
            if (nl < 0) break
            val line = lineBuffer.substring(0, nl).trim()
            lineBuffer.deleteRange(0, nl + 1)
            if (line.isEmpty()) continue
            val obj = runCatching { json.parseToJsonElement(line).jsonObject }.getOrNull() ?: continue
            val hasMethod = obj.containsKey("method")
            val hasId = obj.containsKey("id") && obj["id"] !is JsonNull
            if (hasMethod && hasId) {
                // Server-initiated JSON-RPC request (e.g., `session/request_permission`)
                val reqId = obj["id"]!!
                val method = obj["method"]!!.jsonPrimitive.content
                val params = obj["params"] as? JsonObject ?: JsonObject(emptyMap())
                scope.launch {
                    try {
                        val replyValue = onServerRequest(reqId, method, params)
                        sendRawJsonLine(
                            buildJsonObject {
                                put("jsonrpc", "2.0")
                                put("id", reqId)
                                put("result", replyValue)
                            }
                        )
                    } catch (err: Throwable) {
                        sendRawJsonLine(
                            buildJsonObject {
                                put("jsonrpc", "2.0")
                                put("id", reqId)
                                put("error", buildJsonObject {
                                    put("code", -32000)
                                    put("message", err.message ?: "Request handler error")
                                })
                            }
                        )
                    }
                }
            } else if (hasMethod) {
                // Notification (e.g., `session/update`, `_deskfleet/session/event`)
                val method = obj["method"]!!.jsonPrimitive.content
                val params = obj["params"] as? JsonObject ?: JsonObject(emptyMap())
                onNotification(method, params)
            } else if (hasId) {
                // Response to client call
                val resp = runCatching { json.decodeFromJsonElement(JsonRpcResponse.serializer(), obj) }.getOrNull()
                val rpcId = resp?.id ?: obj["id"]?.jsonPrimitive?.longOrNull ?: continue
                val waiter = pendingLock.withLock { pendingCalls.remove(rpcId) } ?: continue
                if (resp?.error != null) {
                    waiter.completeExceptionally(IllegalStateException(resp.error.message))
                } else {
                    waiter.complete(resp?.result ?: JsonNull)
                }
            }
        }
    }

    private suspend fun failAllPending(err: Throwable) {
        val waiters = pendingLock.withLock {
            val list = pendingCalls.values.toList()
            pendingCalls.clear()
            list
        }
        waiters.forEach { it.completeExceptionally(err) }
    }

    // --- High-level DeskFleet ACP Session helpers (`apps/daemon/src/agent-protocol.ts`) ---

    suspend fun createSession(
        operationId: String,
        provider: String,
        context: String = "worktree",
        workspaceId: String? = null,
        title: String? = null,
        cwd: String? = null,
        baseBranch: String? = null,
        model: String? = null,
        reasoningEffort: String? = null,
        mode: String? = null,
    ): JsonObject {
        initializeIfNeeded()
        val res = call(
            "_deskfleet/session/create",
            buildJsonObject {
                put("operationId", operationId)
                put("provider", provider)
                put("context", context)
                if (!workspaceId.isNullOrBlank()) put("workspaceId", workspaceId)
                if (!title.isNullOrBlank()) put("title", title)
                if (!cwd.isNullOrBlank()) put("cwd", cwd)
                if (!baseBranch.isNullOrBlank()) put("baseBranch", baseBranch)
                if (!model.isNullOrBlank()) put("model", model)
                if (!reasoningEffort.isNullOrBlank()) put("reasoningEffort", reasoningEffort)
                if (!mode.isNullOrBlank()) put("mode", mode)
            },
        )
        return res as? JsonObject ?: JsonObject(emptyMap())
    }

    suspend fun subscribeSession(sessionId: String): JsonObject {
        initializeIfNeeded()
        val res = call(
            "_deskfleet/session/subscribe",
            buildJsonObject {
                put("sessionId", sessionId)
            },
        )
        return res as? JsonObject ?: JsonObject(emptyMap())
    }

    suspend fun sessionHistory(sessionId: String, afterSeq: String = "0", limit: Int = 200): JsonArray {
        initializeIfNeeded()
        val res = call(
            "_deskfleet/session/history",
            buildJsonObject {
                put("sessionId", sessionId)
                put("afterSeq", afterSeq)
                put("limit", limit)
            },
        )
        return res as? JsonArray ?: JsonArray(emptyList())
    }

    suspend fun attendSession(sessionId: String) {
        initializeIfNeeded()
        runCatching { call("_deskfleet/session/attend", buildJsonObject { put("sessionId", sessionId) }) }
    }

    suspend fun leaveSession(sessionId: String) {
        initializeIfNeeded()
        runCatching { call("_deskfleet/session/leave", buildJsonObject { put("sessionId", sessionId) }) }
    }

    suspend fun renameSession(sessionId: String, operationId: String, title: String): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/session/rename",
            buildJsonObject {
                put("sessionId", sessionId)
                put("operationId", operationId)
                put("title", title)
            },
        )
    }

    suspend fun archiveSession(sessionId: String, operationId: String): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/session/archive",
            buildJsonObject {
                put("sessionId", sessionId)
                put("operationId", operationId)
            },
        )
    }

    suspend fun restoreSession(sessionId: String, operationId: String): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/session/restore",
            buildJsonObject {
                put("sessionId", sessionId)
                put("operationId", operationId)
            },
        )
    }

    suspend fun deleteSession(sessionId: String, operationId: String): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/session/delete",
            buildJsonObject {
                put("sessionId", sessionId)
                put("operationId", operationId)
            },
        )
    }

    suspend fun forkSession(sessionId: String, operationId: String, context: String = "worktree", title: String? = null): JsonObject {
        initializeIfNeeded()
        val res = call(
            "_deskfleet/session/fork",
            buildJsonObject {
                put("sessionId", sessionId)
                put("operationId", operationId)
                put("context", context)
                if (!title.isNullOrBlank()) put("title", title)
            },
        )
        return res as? JsonObject ?: JsonObject(emptyMap())
    }

    suspend fun configureSession(
        sessionId: String,
        operationId: String,
        model: String? = null,
        reasoningEffort: String? = null,
        mode: String? = null,
    ): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/session/configure",
            buildJsonObject {
                put("sessionId", sessionId)
                put("operationId", operationId)
                if (!model.isNullOrBlank()) put("model", model)
                if (!reasoningEffort.isNullOrBlank()) put("reasoningEffort", reasoningEffort)
                if (!mode.isNullOrBlank()) put("mode", mode)
            },
        )
    }

    suspend fun submitPrompt(
        sessionId: String,
        operationId: String,
        blocks: List<JsonObject>,
        steer: Boolean = false,
        turnId: String? = null,
    ): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/input/submit",
            buildJsonObject {
                put("sessionId", sessionId)
                put("operationId", operationId)
                put("content", JsonArray(blocks))
                put("delivery", if (steer) "steer" else "backlog")
                if (!turnId.isNullOrBlank()) put("turnId", turnId)
            },
        )
    }

    suspend fun cancelTurn(sessionId: String, operationId: String, turnId: String): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/turn/cancel",
            buildJsonObject {
                put("sessionId", sessionId)
                put("operationId", operationId)
                put("turnId", turnId)
            },
        )
    }

    suspend fun stopSession(sessionId: String, operationId: String): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/session/stop",
            buildJsonObject {
                put("sessionId", sessionId)
                put("operationId", operationId)
            },
        )
    }

    suspend fun withdrawQueuedInput(sessionId: String, operationId: String, inputId: String): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/input/withdraw",
            buildJsonObject {
                put("sessionId", sessionId)
                put("operationId", operationId)
                put("inputId", inputId)
            },
        )
    }

    suspend fun respondPermission(sessionId: String, operationId: String, permissionId: String, optionId: String): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/permission/respond",
            buildJsonObject {
                put("sessionId", sessionId)
                put("operationId", operationId)
                put("permissionId", permissionId)
                put("optionId", optionId)
            },
        )
    }

    suspend fun respondElicitation(sessionId: String, operationId: String, elicitationId: String, action: String, content: JsonObject? = null): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/elicitation/respond",
            buildJsonObject {
                put("sessionId", sessionId)
                put("operationId", operationId)
                put("elicitationId", elicitationId)
                put("response", buildJsonObject {
                    put("action", action) // "accept" | "decline" | "cancel"
                    if (content != null) put("content", content)
                })
            },
        )
    }

    suspend fun queryGitStatus(sessionId: String, force: Boolean = false): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/git/status",
            buildJsonObject {
                put("sessionId", sessionId)
                if (force) put("force", true)
            },
            bulk = true,
        )
    }

    suspend fun queryGitDiff(sessionId: String, repoRoot: String, path: String): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/git/diff",
            buildJsonObject {
                put("sessionId", sessionId)
                put("repository", repoRoot)
                put("path", path)
            },
            bulk = true,
        )
    }

    suspend fun queryCompletions(sessionId: String, prefix: String, trigger: String): JsonElement {
        initializeIfNeeded()
        return call(
            "_deskfleet/composer/references",
            buildJsonObject {
                put("sessionId", sessionId)
                put("query", prefix)
                put("trigger", trigger)
            },
        )
    }

    fun close() {
        channel.close()
    }
}
