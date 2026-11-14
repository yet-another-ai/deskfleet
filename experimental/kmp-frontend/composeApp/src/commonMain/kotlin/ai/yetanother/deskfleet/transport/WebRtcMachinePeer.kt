package ai.yetanother.deskfleet.transport

import ai.yetanother.deskfleet.protocol.IceCandidateWire
import ai.yetanother.deskfleet.protocol.MachineScope
import ai.yetanother.deskfleet.protocol.PeerOfferOptionsWire
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Establishes either a 4-lane `fixed4-v1` multiplexed WebRTC PeerConnection (`purpose = "mux"`)
 * or a single-purpose WebRTC DataChannel PeerConnection (`"agent"`, `"terminal"`, `"files"`, `"desktop"`),
 * qualified by `(teamId, machineId)` (`MachineScope`).
 */
class WebRtcMachinePeer(
    private val scope: CoroutineScope,
    private val central: HttpCentralClient,
    val machineScope: MachineScope,
) {
    private var muxPeerId: String? = null
    private var muxRtcHandle: NativeRtcPeerHandle? = null
    private var muxConnection: MuxConnection? = null
    private var muxPumpJob: Job? = null
    private var muxEventSubJob: Job? = null
    private val openLanes = mutableSetOf<MuxLane>()
    private var muxReadyDeferred: CompletableDeferred<MuxConnection>? = null

    suspend fun openMuxStream(purpose: MuxPurpose): DeskFleetChannel {
        val mux = ensureMuxConnected()
        val stream = mux.openStream(purpose)
        withTimeout(15_000L) {
            stream.ready.await()
        }
        return stream
    }

    private suspend fun ensureMuxConnected(): MuxConnection {
        muxConnection?.let { return it }
        muxReadyDeferred?.let { return it.await() }
        val deferred = CompletableDeferred<MuxConnection>()
        muxReadyDeferred = deferred
        try {
            val grant = central.createPeer(machineScope.teamId, machineScope.machineId, "mux")
            val peerId = grant.peerId
            muxPeerId = peerId
            val handle = NativeRtcBridge.createPeer(
                RtcPeerCreateConfig(
                    iceServers = grant.iceServers,
                    relayOnly = false,
                    videoCodec = null,
                )
            )
            muxRtcHandle = handle
            for (lane in MuxLane.entries) {
                handle.createDataChannel(lane.label)
            }
            val lanesReady = CompletableDeferred<Unit>()
            openLanes.clear()
            val mux = MuxConnection(
                scope = scope,
                isClient = true,
                sendPhysical = { lane, bytes ->
                    // CRITICAL: All 4 Mux physical lanes MUST use binary WebRTC frames!
                    handle.sendBytes(lane.label, bytes)
                },
                onFailed = { err ->
                    closeMux(err)
                },
            )
            muxConnection = mux

            val iceGate = IceCandidateGate(handle)
            muxEventSubJob = scope.launch {
                central.events.collect { ev ->
                    when (ev) {
                        is CentralRealtimeEvent.PeerEvent -> if (ev.peerId == peerId) {
                            iceGate.onSignalingEvent(ev.event)
                        }
                        is CentralRealtimeEvent.PeerRevoked -> if (ev.peerId == peerId) {
                            closeMux(IllegalStateException("Peer revoked: ${ev.reason}"))
                        }
                        else -> Unit
                    }
                }
            }

            muxPumpJob = scope.launch {
                while (isActive) {
                    val ev = handle.pollEvent(250L) ?: continue
                    when (ev) {
                        is RtcPeerEvent.IceCandidate -> {
                            val cand = ev.candidate
                            if (cand != null && cand.candidate.isNotBlank()) {
                                runCatching { central.candidatePeer(peerId, cand) }
                            }
                        }
                        is RtcPeerEvent.DataChannelOpen -> {
                            MuxLane.fromLabel(ev.label)?.let { lane ->
                                openLanes.add(lane)
                                if (openLanes.size == MuxLane.entries.size && !lanesReady.isCompleted) {
                                    lanesReady.complete(Unit)
                                }
                            }
                        }
                        is RtcPeerEvent.Data -> {
                            val lane = MuxLane.fromLabel(ev.label)
                            if (lane != null) {
                                mux.receivePhysical(lane, ev.bytes)
                            }
                        }
                        is RtcPeerEvent.StateChanged -> {
                            if (ev.state == "failed" || ev.state == "closed") {
                                val err = IllegalStateException("WebRTC peer ${ev.state}")
                                if (!lanesReady.isCompleted) lanesReady.completeExceptionally(err)
                                closeMux(err)
                                break
                            }
                        }
                        is RtcPeerEvent.Error -> {
                            val err = IllegalStateException(ev.message)
                            if (!lanesReady.isCompleted) lanesReady.completeExceptionally(err)
                        }
                        RtcPeerEvent.Closed -> break
                        is RtcPeerEvent.DataChannelClosed -> {
                            if (MuxLane.fromLabel(ev.label) != null) {
                                closeMux(IllegalStateException("Mux lane closed: ${ev.label}"))
                                break
                            }
                        }
                    }
                }
            }

            val offerSdp = handle.createOffer()
            val answer = central.offerPeer(peerId, offerSdp)
            iceGate.acceptRemoteAnswer(answer.sdp)
            withTimeout(20_000L) {
                lanesReady.await()
            }
            deferred.complete(mux)
            return mux
        } catch (err: Throwable) {
            deferred.completeExceptionally(err)
            closeMux(err)
            throw err
        } finally {
            muxReadyDeferred = null
        }
    }

    /** Fallback single-purpose WebRTC DataChannel (`deskfleet-acp`, `deskfleet-terminal`, `deskfleet-files`). */
    suspend fun openSingleDataChannel(
        purpose: String,
        label: String,
        videoCodec: String? = null,
    ): Pair<DeskFleetChannel, SinglePeerSession> {
        val grant = central.createPeer(machineScope.teamId, machineScope.machineId, purpose)
        val peerId = grant.peerId
        val handle = NativeRtcBridge.createPeer(
            RtcPeerCreateConfig(
                iceServers = grant.iceServers,
                relayOnly = false,
                videoCodec = videoCodec,
            )
        )
        handle.createDataChannel(label)
        val channel = RawRtcDataChannel(handle, label)
        val session = SinglePeerSession(peerId, handle)
        val iceGate = IceCandidateGate(handle)
        session.wsJob = scope.launch {
            central.events.collect { ev ->
                if (ev is CentralRealtimeEvent.PeerEvent && ev.peerId == peerId) {
                    iceGate.onSignalingEvent(ev.event)
                } else if (ev is CentralRealtimeEvent.PeerRevoked && ev.peerId == peerId) {
                    channel.close(IllegalStateException(ev.reason))
                }
            }
        }
        session.pumpJob = scope.launch {
            while (isActive) {
                val ev = handle.pollEvent(250L) ?: continue
                when (ev) {
                    is RtcPeerEvent.IceCandidate -> {
                        ev.candidate?.takeIf { it.candidate.isNotBlank() }?.let { cand ->
                            runCatching { central.candidatePeer(peerId, cand) }
                        }
                    }
                    is RtcPeerEvent.DataChannelOpen -> if (ev.label == label) channel.markOpen()
                    is RtcPeerEvent.DataChannelClosed -> if (ev.label == label) {
                        channel.notifyRemoteClose(null)
                        break
                    }
                    is RtcPeerEvent.Data -> if (ev.label == label) {
                        val payload = if (ev.isString) {
                            ChannelPayload.Text(ev.bytes.decodeToString())
                        } else {
                            ChannelPayload.Binary(ev.bytes)
                        }
                        channel.deliver(payload)
                    }
                    is RtcPeerEvent.StateChanged -> if (ev.state == "failed" || ev.state == "closed") {
                        channel.notifyRemoteClose(IllegalStateException("Peer ${ev.state}"))
                        break
                    }
                    RtcPeerEvent.Closed -> break
                    else -> Unit
                }
            }
        }
        val offerSdp = handle.createOffer()
        val options = videoCodec?.let { PeerOfferOptionsWire(codec = it, audio = false) }
        val answer = central.offerPeer(peerId, offerSdp, options)
        iceGate.acceptRemoteAnswer(answer.sdp)
        channel.onCleanup = {
            session.wsJob?.cancel()
            session.pumpJob?.cancel()
            handle.close()
            scope.launch { central.closePeer(peerId) }
        }
        return channel to session
    }

    private suspend fun handleSignalingPeerEvent(handle: NativeRtcPeerHandle, event: JsonObject) {
        val kind = event["kind"]?.jsonPrimitive?.content ?: event["type"]?.jsonPrimitive?.content
        if (kind == "candidate" || event.containsKey("candidate")) {
            val candObj = (event["candidate"] as? JsonObject) ?: event
            val rawStr = candObj["candidate"]?.jsonPrimitive?.content.orEmpty()
            if (rawStr.isNotBlank()) {
                handle.addIceCandidate(
                    IceCandidateWire(
                        candidate = rawStr,
                        sdpMid = candObj["sdpMid"]?.jsonPrimitive?.content,
                        sdpMLineIndex = candObj["sdpMLineIndex"]?.jsonPrimitive?.intOrNull
                            ?: candObj["sdpMlineIndex"]?.jsonPrimitive?.intOrNull,
                        usernameFragment = candObj["usernameFragment"]?.jsonPrimitive?.content,
                    )
                )
            }
        }
    }

    fun closeMux(reason: Throwable? = null) {
        val pid = muxPeerId
        muxPeerId = null
        muxPumpJob?.cancel()
        muxPumpJob = null
        muxEventSubJob?.cancel()
        muxEventSubJob = null
        val oldMux = muxConnection
        muxConnection = null
        val oldHandle = muxRtcHandle
        muxRtcHandle = null
        scope.launch {
            oldMux?.close(reason)
            oldHandle?.close()
            if (pid != null) central.closePeer(pid)
        }
    }
}

private class IceCandidateGate(
    private val handle: NativeRtcPeerHandle,
) {
    private val mutex = Mutex()
    private var remoteReady = false
    private val pending = mutableListOf<IceCandidateWire>()

    suspend fun onSignalingEvent(event: JsonObject) {
        val kind = event["kind"]?.jsonPrimitive?.content ?: event["type"]?.jsonPrimitive?.content
        if (kind == "candidate" || event.containsKey("candidate")) {
            val candObj = (event["candidate"] as? JsonObject) ?: event
            val rawStr = candObj["candidate"]?.jsonPrimitive?.content.orEmpty()
            if (rawStr.isNotBlank()) {
                val cand = IceCandidateWire(
                    candidate = rawStr,
                    sdpMid = candObj["sdpMid"]?.jsonPrimitive?.content,
                    sdpMLineIndex = candObj["sdpMLineIndex"]?.jsonPrimitive?.intOrNull
                        ?: candObj["sdpMlineIndex"]?.jsonPrimitive?.intOrNull,
                    usernameFragment = candObj["usernameFragment"]?.jsonPrimitive?.content,
                )
                mutex.withLock {
                    if (remoteReady) {
                        runCatching { handle.addIceCandidate(cand) }
                    } else {
                        pending.add(cand)
                    }
                }
            }
        }
    }

    suspend fun acceptRemoteAnswer(sdp: String) {
        mutex.withLock {
            handle.acceptAnswer(sdp)
            remoteReady = true
            val snapshot = pending.toList()
            pending.clear()
            for (cand in snapshot) {
                runCatching { handle.addIceCandidate(cand) }
            }
        }
    }
}

class SinglePeerSession(
    val peerId: String,
    val handle: NativeRtcPeerHandle,
) {
    internal var wsJob: Job? = null
    internal var pumpJob: Job? = null
}

private class RawRtcDataChannel(
    private val handle: NativeRtcPeerHandle,
    private val label: String,
) : DeskFleetChannel {
    override var state: ChannelState = ChannelState.CONNECTING
        private set
    override val ready: CompletableDeferred<Unit> = CompletableDeferred()
    override var onMessage: (suspend (ChannelPayload) -> Unit)? = null
    override var onClose: ((Throwable?) -> Unit)? = null
    var onCleanup: (() -> Unit)? = null

    override suspend fun sendText(text: String, bulk: Boolean) {
        handle.sendText(label, text)
    }

    override suspend fun sendBinary(bytes: ByteArray, bulk: Boolean) {
        handle.sendBytes(label, bytes)
    }

    override fun close(reason: Throwable?) {
        if (state == ChannelState.CLOSED) return
        state = ChannelState.CLOSED
        ready.completeExceptionally(reason ?: IllegalStateException("Channel closed"))
        onCleanup?.invoke()
        onCleanup = null
        onClose?.invoke(reason)
        onClose = null
    }

    fun markOpen() {
        if (state == ChannelState.CONNECTING) {
            state = ChannelState.OPEN
            ready.complete(Unit)
        }
    }

    suspend fun deliver(payload: ChannelPayload) {
        onMessage?.invoke(payload)
    }

    fun notifyRemoteClose(reason: Throwable?) {
        close(reason)
    }
}
