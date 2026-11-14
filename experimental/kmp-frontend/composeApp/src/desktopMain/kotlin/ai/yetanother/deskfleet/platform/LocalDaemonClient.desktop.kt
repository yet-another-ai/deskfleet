package ai.yetanother.deskfleet.platform

import ai.yetanother.deskfleet.transport.ChannelPayload
import ai.yetanother.deskfleet.transport.ChannelState
import ai.yetanother.deskfleet.transport.DeskFleetChannel
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.ByteBuffer
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

private interface IpcBytePipe : AutoCloseable {
    fun readLine(): String?
    fun writeLine(line: String)
}

private class UnixSocketPipe(path: String) : IpcBytePipe {
    private val channel = SocketChannel.open(StandardProtocolFamily.UNIX).apply {
        connect(UnixDomainSocketAddress.of(path))
    }
    private val readBuf = ByteBuffer.allocate(16 * 1024).apply { limit(0) }
    private val lineOut = ByteArrayOutputStream()

    override fun readLine(): String? {
        while (true) {
            while (readBuf.hasRemaining()) {
                val b = readBuf.get()
                if (b == '\n'.code.toByte()) {
                    val str = lineOut.toString(StandardCharsets.UTF_8)
                    lineOut.reset()
                    return str
                }
                lineOut.write(b.toInt())
            }
            readBuf.clear()
            val n = channel.read(readBuf)
            if (n < 0) {
                if (lineOut.size() == 0) return null
                val str = lineOut.toString(StandardCharsets.UTF_8)
                lineOut.reset()
                return str
            }
            readBuf.flip()
        }
    }

    @Synchronized
    override fun writeLine(line: String) {
        val bytes = (line + "\n").toByteArray(StandardCharsets.UTF_8)
        val buf = ByteBuffer.wrap(bytes)
        while (buf.hasRemaining()) {
            channel.write(buf)
        }
    }

    override fun close() {
        runCatching { channel.close() }
    }
}

private class WindowsNamedPipe(pipePath: String) : IpcBytePipe {
    private val raf = RandomAccessFile(pipePath, "rw")
    private val lineOut = ByteArrayOutputStream()

    override fun readLine(): String? {
        while (true) {
            val b = raf.read()
            if (b < 0) {
                if (lineOut.size() == 0) return null
                val str = lineOut.toString(StandardCharsets.UTF_8)
                lineOut.reset()
                return str
            }
            if (b == '\n'.code) {
                val str = lineOut.toString(StandardCharsets.UTF_8)
                lineOut.reset()
                return str
            }
            lineOut.write(b)
        }
    }

    @Synchronized
    override fun writeLine(line: String) {
        raf.write((line + "\n").toByteArray(StandardCharsets.UTF_8))
    }

    override fun close() {
        runCatching { raf.close() }
    }
}

/**
 * Desktop NDJSON IPC client speaking directly to `daemon.json` (`apps/daemon/src/control-client.ts`)
 * over Unix Domain Sockets (`macOS`, `Linux`) or Named Pipes (`Windows`).
 */
internal class LocalDaemonIpcClient private constructor(
    private val scope: CoroutineScope,
    private val pipe: IpcBytePipe,
    private val onDaemonEvent: (suspend (JsonObject) -> Unit)?,
    private val onDisconnected: ((Throwable?) -> Unit)?,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }
    private val nextId = AtomicLong(1L)
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<JsonElement>>()
    private val writeLock = Mutex()
    private val closed = AtomicBoolean(false)
    private var readerJob: Job? = null

    private fun startReader() {
        readerJob = scope.launch(Dispatchers.IO) {
            var disconnectErr: Throwable? = null
            try {
                while (isActive && !closed.get()) {
                    val line = pipe.readLine() ?: break
                    if (line.isBlank()) continue
                    val obj = runCatching { json.parseToJsonElement(line).jsonObject }.getOrNull() ?: continue
                    val evObj = obj["event"] as? JsonObject
                    if (evObj != null) {
                        onDaemonEvent?.invoke(evObj)
                        continue
                    }
                    val id = obj["id"]?.jsonPrimitive?.longOrNull ?: continue
                    val waiter = pending.remove(id) ?: continue
                    val errStr = obj["error"]?.jsonPrimitive?.contentOrNull
                    if (errStr != null) {
                        waiter.completeExceptionally(IllegalStateException(errStr))
                    } else {
                        waiter.complete(obj["result"] ?: JsonNull)
                    }
                }
            } catch (err: Throwable) {
                disconnectErr = err
            } finally {
                closeInternal(disconnectErr)
            }
        }
    }

    suspend fun call(method: String, params: JsonObject = JsonObject(emptyMap())): JsonElement {
        check(!closed.get()) { "Local daemon IPC closed" }
        val id = nextId.getAndIncrement()
        val deferred = CompletableDeferred<JsonElement>()
        pending[id] = deferred
        val req = buildJsonObject {
            put("id", id)
            put("method", method)
            put("params", params)
        }
        try {
            writeLock.withLock {
                withContext(Dispatchers.IO) {
                    pipe.writeLine(json.encodeToString(JsonObject.serializer(), req))
                }
            }
        } catch (err: Throwable) {
            pending.remove(id)
            throw err
        }
        return withTimeout(15_000L) { deferred.await() }
    }

    fun close() {
        closeInternal(null)
    }

    private fun closeInternal(err: Throwable?) {
        if (!closed.compareAndSet(false, true)) return
        pipe.close()
        readerJob?.cancel()
        val ex = err ?: IllegalStateException("Local daemon connection closed")
        pending.values.forEach { it.completeExceptionally(ex) }
        pending.clear()
        onDisconnected?.invoke(err)
    }

    companion object {
        fun defaultDaemonDirectory(): File {
            val envDir = System.getenv("DESKFLEET_DAEMON_DIRECTORY")?.takeIf { it.isNotBlank() }
            if (envDir != null) return File(envDir)
            val home = System.getProperty("user.home").orEmpty()
            return File(home, ".deskfleet")
        }

        suspend fun connect(
            scope: CoroutineScope,
            daemonDir: File = defaultDaemonDirectory(),
            onDaemonEvent: (suspend (JsonObject) -> Unit)? = null,
            onDisconnected: ((Throwable?) -> Unit)? = null,
        ): LocalDaemonIpcClient = withContext(Dispatchers.IO) {
            val discoveryFile = File(daemonDir, "daemon.json")
            require(discoveryFile.isFile) { "daemon.json not found in ${daemonDir.absolutePath}" }
            val json = Json { ignoreUnknownKeys = true }
            val discovery = json.parseToJsonElement(discoveryFile.readText()).jsonObject
            val endpoint = discovery["endpoint"]?.jsonPrimitive?.content ?: error("Missing endpoint in daemon.json")
            val token = discovery["token"]?.jsonPrimitive?.content ?: error("Missing token in daemon.json")
            val isWindowsPipe = endpoint.startsWith("\\\\.\\pipe\\")
            val pipe: IpcBytePipe = if (isWindowsPipe) WindowsNamedPipe(endpoint) else UnixSocketPipe(endpoint)
            val client = LocalDaemonIpcClient(scope, pipe, onDaemonEvent, onDisconnected)
            client.startReader()
            try {
                client.call("hello", buildJsonObject { put("token", token) })
                client
            } catch (err: Throwable) {
                client.close()
                throw err
            }
        }
    }
}

/**
 * Direct Local Daemon IPC `DeskFleetChannel` (`localOpen` / `localSend` / `localAck` / `localClose`),
 * matching `apps/desktop/src/main/local-channels-controller.ts`!
 */
internal class LocalDaemonChannel(
    private val scope: CoroutineScope,
    private val peerId: String,
    private val onCleanupPeer: suspend () -> Unit,
) : DeskFleetChannel {
    override var state: ChannelState = ChannelState.CONNECTING
        private set
    override val ready: CompletableDeferred<Unit> = CompletableDeferred()
    override var onMessage: (suspend (ChannelPayload) -> Unit)? = null
    override var onClose: ((Throwable?) -> Unit)? = null

    internal var ipcClient: LocalDaemonIpcClient? = null

    internal fun markOpen() {
        if (state == ChannelState.CONNECTING) {
            state = ChannelState.OPEN
            ready.complete(Unit)
        }
    }

    internal suspend fun handleDaemonEvent(ev: JsonObject) {
        val evPeer = ev["peerId"]?.jsonPrimitive?.contentOrNull ?: return
        if (evPeer != peerId) return
        when (ev["kind"]?.jsonPrimitive?.contentOrNull) {
            "localChannelMessage" -> {
                val seq = ev["sequence"]?.jsonPrimitive?.longOrNull ?: 0L
                val isStr = ev["isString"]?.jsonPrimitive?.booleanOrNull ?: false
                val dataStr = ev["data"]?.jsonPrimitive?.content.orEmpty()
                val payload = if (isStr) {
                    ChannelPayload.Text(dataStr)
                } else {
                    ChannelPayload.Binary(Base64.getDecoder().decode(dataStr))
                }
                // Acknowledge asynchronously within the daemon's 5s local window without blocking the socket reader!
                scope.launch {
                    runCatching {
                        ipcClient?.call(
                            "localAck",
                            buildJsonObject {
                                put("peerId", peerId)
                                put("sequence", seq)
                            },
                        )
                    }
                }
                onMessage?.invoke(payload)
            }
            "localChannelClosed" -> {
                val err = ev["error"]?.jsonPrimitive?.contentOrNull?.let { IllegalStateException(it) }
                close(err)
            }
        }
    }

    override suspend fun sendText(text: String, bulk: Boolean) {
        val client = ipcClient ?: error("Local channel closed")
        client.call(
            "localSend",
            buildJsonObject {
                put("peerId", peerId)
                put("data", text)
                put("isString", true)
            },
        )
    }

    override suspend fun sendBinary(bytes: ByteArray, bulk: Boolean) {
        val client = ipcClient ?: error("Local channel closed")
        val b64 = Base64.getEncoder().encodeToString(bytes)
        client.call(
            "localSend",
            buildJsonObject {
                put("peerId", peerId)
                put("data", b64)
                put("isString", false)
            },
        )
    }

    override fun close(reason: Throwable?) {
        if (state == ChannelState.CLOSED) return
        state = ChannelState.CLOSED
        ready.completeExceptionally(reason ?: IllegalStateException("Local channel closed"))
        val client = ipcClient
        ipcClient = null
        scope.launch {
            runCatching {
                client?.call("localClose", buildJsonObject { put("peerId", peerId) })
            }
            client?.close()
            onCleanupPeer()
        }
        onClose?.invoke(reason)
        onClose = null
    }
}
