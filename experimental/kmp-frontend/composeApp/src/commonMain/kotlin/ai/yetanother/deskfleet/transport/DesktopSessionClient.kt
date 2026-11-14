package ai.yetanother.deskfleet.transport

import ai.yetanother.deskfleet.protocol.DesktopDisplayInfo
import ai.yetanother.deskfleet.protocol.MachineScope
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Live WebRTC Remote Desktop media + `"deskfleet-input"` controller (`purpose = "desktop"`).
 * - Negotiates recvonly H.264 video track + `"deskfleet-input"` DataChannel.
 * - Polls decoded BGRA8888 frames from `NativeRtcBridge` for embedded Compose rendering.
 * - Sends normalized pointer `[0, 1]`, button `0..4`, wheel, DOM `KeyboardEvent.code`,
 *   `secureAttention` (`Ctrl+Alt+Del`), and `releaseAll` frames over `"deskfleet-input"`.
 */
class DesktopSessionClient(
    private val scope: CoroutineScope,
    private val central: HttpCentralClient,
    val machineScope: MachineScope,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
    }

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val _latestFrame = MutableStateFlow<DecodedVideoFrame?>(null)
    val latestFrame: StateFlow<DecodedVideoFrame?> = _latestFrame.asStateFlow()

    private val _controlEnabled = MutableStateFlow(true)
    val controlEnabled: StateFlow<Boolean> = _controlEnabled.asStateFlow()

    private val _selectedDisplayId = MutableStateFlow<String?>(null)
    val selectedDisplayId: StateFlow<String?> = _selectedDisplayId.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private var inputChannel: DeskFleetChannel? = null
    private var peerSession: SinglePeerSession? = null
    private var frameLoopJob: Job? = null

    suspend fun startEmbedded(
        peerFactory: WebRtcMachinePeer,
        displayId: String? = null,
        control: Boolean = true,
    ) {
        stop()
        _error.value = null
        _controlEnabled.value = control
        _selectedDisplayId.value = displayId
        try {
            val (ch, session) = peerFactory.openSingleDataChannel(
                purpose = "desktop",
                label = "deskfleet-input",
                videoCodec = "h264",
            )
            inputChannel = ch
            peerSession = session
            central.startPeer(
                session.peerId,
                buildJsonObject {
                    put("control", control)
                    if (!displayId.isNullOrBlank()) put("displayId", displayId)
                },
            )
            _connected.value = true
            frameLoopJob = scope.launch {
                var lastSeq = 0L
                while (isActive) {
                    val frame = session.handle.pollVideoFrame(lastSeq)
                    if (frame != null) {
                        lastSeq = frame.seq
                        _latestFrame.value = frame
                    }
                    delay(16L)
                }
            }
            scope.launch {
                runCatching {
                    withTimeout(10_000L) { ch.ready.await() }
                    sendInputJson(
                        buildJsonObject {
                            put("type", "configure")
                            put("control", control)
                            if (!displayId.isNullOrBlank()) put("displayId", displayId)
                        }
                    )
                }
            }
        } catch (err: Throwable) {
            _error.value = err.message ?: "Failed to start remote desktop"
            stop()
            throw err
        }
    }

    suspend fun setControlEnabled(enabled: Boolean) {
        _controlEnabled.value = enabled
        if (!enabled) releaseAllInputs()
        sendInputJson(
            buildJsonObject {
                put("type", "configure")
                put("control", enabled)
                _selectedDisplayId.value?.let { put("displayId", it) }
            }
        )
    }

    suspend fun selectDisplay(display: DesktopDisplayInfo) {
        _selectedDisplayId.value = display.id
        sendInputJson(
            buildJsonObject {
                put("type", "configure")
                put("control", _controlEnabled.value)
                put("displayId", display.id)
            }
        )
    }

    suspend fun sendPointerMove(nx: Double, ny: Double) {
        if (!_controlEnabled.value) return
        sendInputJson(
            buildJsonObject {
                put("type", "pointerMove")
                put("x", nx.coerceIn(0.0, 1.0))
                put("y", ny.coerceIn(0.0, 1.0))
            }
        )
    }

    suspend fun sendPointerButton(button: Int, pressed: Boolean, nx: Double, ny: Double) {
        if (!_controlEnabled.value) return
        sendInputJson(
            buildJsonObject {
                put("type", "pointerButton")
                put("button", button.coerceIn(0, 4))
                put("pressed", pressed)
                put("x", nx.coerceIn(0.0, 1.0))
                put("y", ny.coerceIn(0.0, 1.0))
            }
        )
    }

    suspend fun sendWheel(deltaX: Double, deltaY: Double) {
        if (!_controlEnabled.value) return
        sendInputJson(
            buildJsonObject {
                put("type", "wheel")
                put("deltaX", deltaX)
                put("deltaY", deltaY)
            }
        )
    }

    suspend fun sendKey(code: String, pressed: Boolean) {
        if (!_controlEnabled.value) return
        sendInputJson(
            buildJsonObject {
                put("type", "key")
                put("code", code)
                put("pressed", pressed)
            }
        )
    }

    suspend fun sendSecureAttention() {
        if (!_controlEnabled.value) return
        sendInputJson(buildJsonObject { put("type", "secureAttention") })
    }

    suspend fun releaseAllInputs() {
        sendInputJson(buildJsonObject { put("type", "releaseAll") })
    }

    private suspend fun sendInputJson(payload: JsonObject) {
        val ch = inputChannel ?: return
        if (ch.state != ChannelState.OPEN) return
        runCatching {
            ch.sendText(json.encodeToString(JsonObject.serializer(), payload))
        }
    }

    fun stop() {
        frameLoopJob?.cancel()
        frameLoopJob = null
        val ch = inputChannel
        inputChannel = null
        peerSession = null
        _connected.value = false
        ch?.close()
    }
}
