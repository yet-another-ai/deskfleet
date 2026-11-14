package ai.yetanother.deskfleet.transport

import ai.yetanother.deskfleet.protocol.FileConflictPolicy
import ai.yetanother.deskfleet.protocol.FileEntry
import ai.yetanother.deskfleet.protocol.FileListing
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

const val FILE_CHUNK_BYTES = 127 * 1024
private const val FILE_WIRE_SLICE_BYTES = 65_535
private const val FILE_MAX_METADATA_BYTES = 8 * 1024 * 1024

class DecodedFileFrame(
    val header: JsonObject,
    val data: ByteArray,
)

/**
 * Exact binary stream frame decoder matching `apps/daemon/src/files-wire.ts`:
 * `[headerLen: u32 BE][dataLen: u32 BE][UTF-8 JSON header][raw binary bytes]`
 */
class FileFrameStreamDecoder(private val json: Json) {
    private val prefix = ByteArray(8)
    private var prefixPos = 0
    private var body: ByteArray? = null
    private var bodyPos = 0
    private var headerLen = 0

    private fun readU32Be(buf: ByteArray, pos: Int): Int =
        ((buf[pos].toInt() and 0xFF) shl 24) or
            ((buf[pos + 1].toInt() and 0xFF) shl 16) or
            ((buf[pos + 2].toInt() and 0xFF) shl 8) or
            (buf[pos + 3].toInt() and 0xFF)

    fun push(chunk: ByteArray): List<DecodedFileFrame> {
        val out = mutableListOf<DecodedFileFrame>()
        var offset = 0
        while (offset < chunk.size) {
            if (body == null) {
                val n = minOf(8 - prefixPos, chunk.size - offset)
                chunk.copyInto(prefix, destinationOffset = prefixPos, startIndex = offset, endIndex = offset + n)
                prefixPos += n
                offset += n
                if (prefixPos < 8) break
                headerLen = readU32Be(prefix, 0)
                val dataLen = readU32Be(prefix, 4)
                require(headerLen in 2..FILE_MAX_METADATA_BYTES && dataLen in 0..FILE_CHUNK_BYTES) {
                    "Invalid file frame lengths ($headerLen, $dataLen)"
                }
                body = ByteArray(headerLen + dataLen)
                bodyPos = 0
            }
            val currentBody = body!!
            val n = minOf(currentBody.size - bodyPos, chunk.size - offset)
            chunk.copyInto(currentBody, destinationOffset = bodyPos, startIndex = offset, endIndex = offset + n)
            bodyPos += n
            offset += n
            if (bodyPos < currentBody.size) continue
            val hdrJson = currentBody.copyOfRange(0, headerLen).decodeToString()
            val hdrObj = json.parseToJsonElement(hdrJson).jsonObject
            val payload = currentBody.copyOfRange(headerLen, currentBody.size)
            out.add(DecodedFileFrame(header = hdrObj, data = payload))
            body = null
            prefixPos = 0
        }
        return out
    }
}

private fun putU32Be(buf: ByteArray, pos: Int, value: Int) {
    buf[pos] = ((value ushr 24) and 0xFF).toByte()
    buf[pos + 1] = ((value ushr 16) and 0xFF).toByte()
    buf[pos + 2] = ((value ushr 8) and 0xFF).toByte()
    buf[pos + 3] = (value and 0xFF).toByte()
}

/**
 * Remote Machine Files RPC client over `deskfleet-files` or `fixed4-v1` `files` (`bulk`) stream.
 */
class FilesChannelClient(
    private val scope: CoroutineScope,
    private val channel: DeskFleetChannel,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
    }
    private val decoder = FileFrameStreamDecoder(json)
    private val writeLock = Mutex()
    private val pendingLock = Mutex()
    private val pending = mutableMapOf<Long, CompletableDeferred<Pair<JsonElement, ByteArray>>>()
    private var nextId = 1L

    init {
        channel.onMessage = { payload ->
            val bytes = when (payload) {
                is ChannelPayload.Binary -> payload.bytes
                is ChannelPayload.Text -> payload.text.encodeToByteArray()
            }
            val frames = decoder.push(bytes)
            for (frame in frames) {
                val id = frame.header["id"]?.jsonPrimitive?.longOrNull ?: continue
                val waiter = pendingLock.withLock { pending.remove(id) } ?: continue
                val errObj = frame.header["error"] as? JsonObject
                if (errObj != null) {
                    val msg = errObj["message"]?.jsonPrimitive?.content ?: "File RPC error"
                    waiter.completeExceptionally(IllegalStateException(msg))
                } else {
                    waiter.complete((frame.header["value"] ?: JsonNull) to frame.data)
                }
            }
        }
        channel.onClose = { err ->
            scope.launch {
                val list = pendingLock.withLock {
                    val copy = pending.values.toList()
                    pending.clear()
                    copy
                }
                val ex = err ?: IllegalStateException("Files channel closed")
                list.forEach { it.completeExceptionally(ex) }
            }
        }
    }

    suspend fun callRaw(
        method: String,
        params: JsonObject,
        data: ByteArray = ByteArray(0),
    ): Pair<JsonElement, ByteArray> {
        channel.ready.await()
        val (id, def) = pendingLock.withLock {
            val reqId = nextId++
            val d = CompletableDeferred<Pair<JsonElement, ByteArray>>()
            pending[reqId] = d
            reqId to d
        }
        val headerObj = buildJsonObject {
            put("id", id)
            put("method", method)
            put("params", params)
        }
        val headerBytes = json.encodeToString(JsonObject.serializer(), headerObj).encodeToByteArray()
        val fullFrame = ByteArray(8 + headerBytes.size + data.size)
        putU32Be(fullFrame, 0, headerBytes.size)
        putU32Be(fullFrame, 4, data.size)
        headerBytes.copyInto(fullFrame, destinationOffset = 8)
        if (data.isNotEmpty()) {
            data.copyInto(fullFrame, destinationOffset = 8 + headerBytes.size)
        }
        try {
            writeLock.withLock {
                var offset = 0
                while (offset < fullFrame.size) {
                    val end = minOf(fullFrame.size, offset + FILE_WIRE_SLICE_BYTES)
                    channel.sendBinary(fullFrame.copyOfRange(offset, end), bulk = true)
                    offset = end
                }
            }
        } catch (err: Throwable) {
            pendingLock.withLock { pending.remove(id) }
            throw err
        }
        return def.await()
    }

    suspend fun list(path: String? = null): FileListing {
        val (value, _) = callRaw(
            "list",
            buildJsonObject {
                if (!path.isNullOrBlank()) put("path", path)
            },
        )
        val obj = value.jsonObject
        val entries = obj["entries"]?.jsonArray.orEmpty().map { el ->
            val eo = el.jsonObject
            val name = eo["name"]?.jsonPrimitive?.content.orEmpty()
            FileEntry(
                name = name,
                path = eo["path"]?.jsonPrimitive?.content.orEmpty(),
                kind = eo["kind"]?.jsonPrimitive?.content ?: "file",
                size = eo["size"]?.jsonPrimitive?.longOrNull ?: 0L,
                modifiedAt = eo["modifiedAt"]?.jsonPrimitive?.contentOrNull,
                hidden = name.startsWith("."),
            )
        }
        val roots = obj["roots"]?.jsonArray.orEmpty().mapNotNull { r ->
            (r as? JsonObject)?.get("path")?.jsonPrimitive?.contentOrNull
                ?: (r as? JsonPrimitive)?.contentOrNull
        }
        return FileListing(
            path = obj["path"]?.jsonPrimitive?.content.orEmpty(),
            parent = obj["parentPath"]?.jsonPrimitive?.contentOrNull,
            roots = roots,
            homeDirectory = obj["homePath"]?.jsonPrimitive?.contentOrNull,
            entries = entries,
        )
    }

    suspend fun readAllBytes(
        remotePath: String,
        totalSizeHint: Long? = null,
        onProgress: (transferred: Long, total: Long?) -> Unit = { _, _ -> },
    ): ByteArray {
        val (openVal, _) = callRaw("openRead", buildJsonObject { put("path", remotePath) })
        val readId = openVal.jsonObject["readId"]?.jsonPrimitive?.content ?: error("Missing readId")
        val chunks = mutableListOf<ByteArray>()
        var offset = 0L
        try {
            while (true) {
                val (_, bytes) = callRaw(
                    "read",
                    buildJsonObject {
                        put("path", remotePath)
                        put("readId", readId)
                        put("offset", offset)
                        put("length", FILE_CHUNK_BYTES)
                    },
                )
                if (bytes.isEmpty()) break
                chunks.add(bytes)
                offset += bytes.size
                onProgress(offset, totalSizeHint)
                if (bytes.size < FILE_CHUNK_BYTES) break
            }
        } finally {
            runCatching { callRaw("closeRead", buildJsonObject { put("readId", readId) }) }
        }
        val combined = ByteArray(offset.toInt())
        var pos = 0
        for (c in chunks) {
            c.copyInto(combined, destinationOffset = pos)
            pos += c.size
        }
        return combined
    }

    suspend fun uploadFileBytes(
        destinationDirectory: String,
        fileName: String,
        bytes: ByteArray,
        conflict: FileConflictPolicy = FileConflictPolicy.RENAME,
        onProgress: (transferred: Long, total: Long) -> Unit = { _, _ -> },
    ): String {
        val (beginVal, _) = callRaw(
            "begin",
            buildJsonObject {
                put("directory", destinationDirectory)
                put("name", fileName)
                put("kind", "file")
                put("conflict", conflict.wire)
            },
        )
        val beginObj = beginVal.jsonObject
        val transferId = beginObj["transferId"]?.jsonPrimitive?.content ?: error("Missing transferId")
        if (beginObj["skipped"]?.jsonPrimitive?.booleanOrNull == true) {
            return "$destinationDirectory/$fileName"
        }
        try {
            var offset = 0
            while (offset < bytes.size) {
                val end = minOf(bytes.size, offset + FILE_CHUNK_BYTES)
                val slice = bytes.copyOfRange(offset, end)
                callRaw(
                    "write",
                    buildJsonObject {
                        put("transferId", transferId)
                        put("path", "")
                        put("offset", offset)
                    },
                    data = slice,
                )
                offset = end
                onProgress(offset.toLong(), bytes.size.toLong())
            }
            callRaw(
                "finish",
                buildJsonObject {
                    put("transferId", transferId)
                    put("path", "")
                    put("size", bytes.size)
                },
            )
            val (commitVal, _) = callRaw("commit", buildJsonObject { put("transferId", transferId) })
            return commitVal.jsonObject["path"]?.jsonPrimitive?.content ?: "$destinationDirectory/$fileName"
        } catch (err: Throwable) {
            runCatching { callRaw("abort", buildJsonObject { put("transferId", transferId) }) }
            throw err
        }
    }

    fun close() {
        channel.close()
    }
}
