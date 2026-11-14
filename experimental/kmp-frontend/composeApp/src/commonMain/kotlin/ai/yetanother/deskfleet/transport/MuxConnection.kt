package ai.yetanother.deskfleet.transport

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Full Kotlin Multiplatform implementation of DeskFleet `fixed4-v1` 4-lane binary multiplexer
 * matching `packages/client/src/mux/connection.ts` wire-for-wire:
 * - Client opens odd stream IDs (`1, 3, 5...`), server opens even stream IDs (`2, 4, 6...`).
 * - 17-byte BE data headers, <=16,367 payload bytes per frame, `131,072`-byte window.
 * - Cross-lane sequence reordering (`terminal`/`agent` + `bulk`) before delivering in `nextReceive` order
 *   and returning consumption `credit` on `deskfleet-mux-control`.
 */
class MuxConnection(
    private val scope: CoroutineScope,
    private val isClient: Boolean = true,
    private val sendPhysical: suspend (lane: MuxLane, bytes: ByteArray) -> Unit,
    private val onAccept: ((MuxLogicalStream) -> Unit)? = null,
    private val onFailed: (Throwable) -> Unit = {},
) {
    private class OutgoingJob(
        val lane: MuxLane,
        val frames: List<ByteArray>,
        var index: Int = 0,
        val done: CompletableDeferred<Unit> = CompletableDeferred(),
    )

    private class IncomingAssembly(
        val total: Int,
        val text: Boolean,
        val lane: MuxLane,
        var offset: Int = 0,
        var cost: Int = 0,
        val chunks: MutableList<ByteArray> = mutableListOf(),
    )

    private inner class StreamEntry(
        val stream: MuxLogicalStream,
        val local: Boolean,
        var nextSend: Long = 0L,
        var nextReceive: Long = 0L,
        var sendCredit: Int = MUX_WINDOW_BYTES,
        var receiveCredit: Int = MUX_WINDOW_BYTES,
        val outgoing: ArrayDeque<OutgoingJob> = ArrayDeque(),
        val incoming: MutableMap<Long, IncomingAssembly> = mutableMapOf(),
        var delivering: Boolean = false,
    )

    private val lock = Mutex()
    private val streams = LinkedHashMap<Long, StreamEntry>()
    private val pumping = mutableSetOf<MuxLane>()
    private val lastServedId = mutableMapOf<MuxLane, Long>()
    private val controlQueue = ArrayDeque<ByteArray>()
    private var controlSending = false
    private var nextLocalId: Long = if (isClient) 1L else 2L
    private var highestRemoteId: Long = 0L
    private var totalBufferedBytes: Int = 0
    private var isClosed: Boolean = false

    suspend fun openStream(purpose: MuxPurpose): MuxLogicalStream {
        val stream = lock.withLock {
            check(!isClosed) { "Mux connection is closed" }
            check(streams.size < MUX_MAX_STREAMS) { "Too many Mux streams" }
            val id = nextLocalId
            nextLocalId += 2L
            val logical = MuxLogicalStream(this, id, purpose)
            streams[id] = StreamEntry(stream = logical, local = true)
            enqueueControlLocked(MuxControlEnvelope(type = "open", id = id, purpose = purpose.wire))
            logical
        }
        kickControlPump()
        return stream
    }

    suspend fun receivePhysical(lane: MuxLane, bytes: ByteArray) {
        try {
            if (lane == MuxLane.CONTROL) {
                val ctrl = decodeMuxControl(bytes)
                handleControl(ctrl)
            } else {
                val frame = decodeMuxFrame(bytes)
                handleData(lane, bytes.size, frame)
            }
        } catch (err: Throwable) {
            failConnection(err)
        }
    }

    private fun isRetiredIdLocked(id: Long): Boolean {
        val localParity = if (isClient) 1L else 0L
        return if (id % 2L == localParity) id < nextLocalId else id <= highestRemoteId
    }

    private suspend fun handleControl(ctrl: MuxControlEnvelope) {
        var acceptedStream: MuxLogicalStream? = null
        var toDeliverId: Long? = null
        var kickAll = false
        var closeCallback: Pair<MuxLogicalStream, Throwable?>? = null

        lock.withLock {
            if (isClosed) return
            if (ctrl.type == "open") {
                val localParity = if (isClient) 1L else 0L
                require(ctrl.id % 2L != localParity && ctrl.id > highestRemoteId) {
                    "Invalid or reused remote Mux stream ID: ${ctrl.id}"
                }
                highestRemoteId = ctrl.id
                val purpose = ctrl.purpose?.let { MuxPurpose.fromWire(it) }
                if (purpose == null || streams.size >= MUX_MAX_STREAMS || onAccept == null) {
                    enqueueControlLocked(
                        MuxControlEnvelope(type = "close", id = ctrl.id, error = "Mux stream is not accepted")
                    )
                } else {
                    val stream = MuxLogicalStream(this, ctrl.id, purpose)
                    streams[ctrl.id] = StreamEntry(stream = stream, local = false)
                    stream.markOpened()
                    acceptedStream = stream
                }
            } else {
                val entry = streams[ctrl.id]
                if (entry == null) {
                    require(isRetiredIdLocked(ctrl.id)) { "Unknown Mux stream ${ctrl.id}" }
                    return
                }
                when (ctrl.type) {
                    "close" -> {
                        val err = ctrl.error?.let { IllegalStateException(it) }
                        finishStreamLocked(entry, err)
                        closeCallback = entry.stream to err
                    }
                    "opened" -> {
                        require(entry.local && entry.stream.state == ChannelState.CONNECTING) {
                            "Unexpected Mux opened response"
                        }
                        entry.stream.markOpened()
                        toDeliverId = ctrl.id
                        kickAll = true
                    }
                    "credit" -> {
                        val delta = ctrl.bytes ?: error("Missing credit bytes")
                        require(delta > 0 && entry.sendCredit + delta <= MUX_WINDOW_BYTES) {
                            "Invalid Mux receive credit"
                        }
                        entry.sendCredit += delta
                        kickAll = true
                    }
                    else -> error("Unknown Mux control type: ${ctrl.type}")
                }
            }
        }

        acceptedStream?.let { stream ->
            try {
                onAccept?.invoke(stream)
                lock.withLock {
                    if (stream.state != ChannelState.CLOSED) {
                        enqueueControlLocked(MuxControlEnvelope(type = "opened", id = stream.id))
                    }
                }
            } catch (err: Throwable) {
                closeStream(stream.id, err)
            }
        }
        closeCallback?.let { (s, e) -> s.notifyClosed(e) }
        kickControlPump()
        toDeliverId?.let { scheduleDeliver(it) }
        if (kickAll) kickAllDataLanes()
    }

    private suspend fun handleData(lane: MuxLane, wireLen: Int, frame: MuxFrame) {
        var shouldDeliver = false
        lock.withLock {
            if (isClosed) return
            val entry = streams[frame.id]
            if (entry == null) {
                require(isRetiredIdLocked(frame.id)) { "Unknown Mux data stream ${frame.id}" }
                return
            }
            require(entry.stream.purpose.allowsLane(lane)) { "Mux data arrived on forbidden lane $lane" }
            require(
                frame.sequence >= entry.nextReceive &&
                    frame.sequence - entry.nextReceive < (MUX_WINDOW_BYTES / MUX_MIN_FRAME_COST)
            ) { "Invalid Mux message sequence ${frame.sequence}" }
            val cost = muxFrameCost(wireLen)
            require(cost <= entry.receiveCredit) { "Mux receive window exceeded" }
            val assembly = entry.incoming.getOrPut(frame.sequence) {
                require(frame.offset == 0) { "Mux message starts at nonzero offset" }
                IncomingAssembly(total = frame.total, text = frame.text, lane = lane)
            }
            require(
                assembly.offset == frame.offset &&
                    assembly.text == frame.text &&
                    assembly.total == frame.total &&
                    assembly.lane == lane &&
                    !(assembly.cost > 0 && assembly.offset == assembly.total)
            ) { "Invalid Mux message fragment" }
            entry.receiveCredit -= cost
            assembly.chunks.add(frame.data)
            assembly.offset += frame.data.size
            assembly.cost += cost
            shouldDeliver = assembly.offset == assembly.total && frame.sequence == entry.nextReceive
        }
        if (shouldDeliver) {
            scheduleDeliver(frame.id)
        }
    }

    internal fun scheduleDeliver(streamId: Long) {
        scope.launch {
            deliverLoop(streamId)
        }
    }

    private suspend fun deliverLoop(streamId: Long) {
        while (true) {
            val nextBatch: Triple<suspend (ChannelPayload) -> Unit, ChannelPayload, Int>? = lock.withLock {
                val entry = streams[streamId] ?: return
                val handler = entry.stream.onMessage
                if (entry.delivering || entry.stream.state != ChannelState.OPEN || handler == null) return
                val msg = entry.incoming[entry.nextReceive]
                if (msg == null || msg.offset != msg.total) return
                entry.delivering = true
                val combined = ByteArray(msg.total)
                var pos = 0
                for (chunk in msg.chunks) {
                    chunk.copyInto(combined, destinationOffset = pos)
                    pos += chunk.size
                }
                msg.chunks.clear()
                val payload = if (msg.text) {
                    ChannelPayload.Text(combined.decodeToString())
                } else {
                    ChannelPayload.Binary(combined)
                }
                Triple(handler, payload, msg.cost)
            }
            val (handler, payload, msgCost) = nextBatch ?: return
            try {
                handler(payload)
            } catch (err: Throwable) {
                lock.withLock { streams[streamId]?.delivering = false }
                closeStream(streamId, err)
                return
            }
            var hasMore = false
            lock.withLock {
                val entry = streams[streamId] ?: return
                entry.delivering = false
                entry.incoming.remove(entry.nextReceive)
                entry.nextReceive += 1L
                entry.receiveCredit += msgCost
                enqueueControlLocked(MuxControlEnvelope(type = "credit", id = streamId, bytes = msgCost))
                val peek = entry.incoming[entry.nextReceive]
                hasMore = peek != null && peek.offset == peek.total && entry.stream.onMessage != null
            }
            kickControlPump()
            if (!hasMore) return
        }
    }

    internal suspend fun sendFromStream(streamId: Long, payload: ChannelPayload, bulk: Boolean) {
        val (targetLane, deferred) = lock.withLock {
            val entry = streams[streamId] ?: error("Mux stream is closed")
            check(entry.stream.state == ChannelState.OPEN) { "Mux stream is not open" }
            val lane = if (bulk) MuxLane.BULK else entry.stream.purpose.defaultLane
            require(entry.stream.purpose.allowsLane(lane)) { "Invalid Mux send lane $lane" }
            val isText = payload is ChannelPayload.Text
            val rawBytes = when (payload) {
                is ChannelPayload.Text -> payload.text.encodeToByteArray()
                is ChannelPayload.Binary -> payload.bytes
            }
            require(rawBytes.size <= MUX_MESSAGE_BYTES) { "Mux message exceeds 64 KiB" }
            val fragmentsCount = maxOf(1, (rawBytes.size + MUX_MAX_PAYLOAD_BYTES - 1) / MUX_MAX_PAYLOAD_BYTES)
            val wireBytes = rawBytes.size + fragmentsCount * MUX_HEADER_BYTES
            check(
                entry.stream.bufferedBytes + wireBytes <= MUX_STREAM_QUEUE_BYTES &&
                    totalBufferedBytes + wireBytes <= MUX_CONNECTION_QUEUE_BYTES &&
                    entry.outgoing.size < 512
            ) { "Mux send queue is full" }
            val seq = entry.nextSend++
            val frames = ArrayList<ByteArray>(fragmentsCount)
            var offset = 0
            do {
                val end = minOf(rawBytes.size, offset + MUX_MAX_PAYLOAD_BYTES)
                val slice = rawBytes.copyOfRange(offset, end)
                frames.add(
                    encodeMuxFrame(
                        MuxFrame(
                            id = streamId,
                            sequence = seq,
                            offset = offset,
                            total = rawBytes.size,
                            text = isText,
                            data = slice,
                        )
                    )
                )
                offset += MUX_MAX_PAYLOAD_BYTES
            } while (offset < rawBytes.size)
            totalBufferedBytes += wireBytes
            entry.stream.bufferedBytes += wireBytes
            val job = OutgoingJob(lane = lane, frames = frames)
            entry.outgoing.addLast(job)
            lane to job.done
        }
        kickDataLane(targetLane)
        deferred.await()
    }

    private fun kickAllDataLanes() {
        kickDataLane(MuxLane.TERMINAL)
        kickDataLane(MuxLane.AGENT)
        kickDataLane(MuxLane.BULK)
    }

    private fun kickDataLane(lane: MuxLane) {
        scope.launch {
            val shouldStart = lock.withLock {
                if (isClosed || pumping.contains(lane)) false
                else {
                    pumping.add(lane)
                    true
                }
            }
            if (!shouldStart) return@launch
            try {
                while (true) {
                    val step: Triple<Long, ByteArray, Int>? = lock.withLock {
                        if (isClosed) null
                        else {
                            val entries = streams.values.toList()
                            if (entries.isEmpty()) null
                            else {
                                val lastIdx = entries.indexOfFirst { it.stream.id == lastServedId[lane] }
                                var chosen: StreamEntry? = null
                                for (delta in 1..entries.size) {
                                    val candidate = entries[(lastIdx + delta).mod(entries.size)]
                                    val head = candidate.outgoing.firstOrNull()
                                    if (
                                        candidate.stream.state == ChannelState.OPEN &&
                                        head != null &&
                                        head.lane == lane &&
                                        candidate.sendCredit >= muxFrameCost(head.frames[head.index].size)
                                    ) {
                                        chosen = candidate
                                        break
                                    }
                                }
                                if (chosen == null) null
                                else {
                                    val head = chosen.outgoing.first()
                                    val frame = head.frames[head.index]
                                    val cost = muxFrameCost(frame.size)
                                    lastServedId[lane] = chosen.stream.id
                                    chosen.sendCredit -= cost
                                    Triple(chosen.stream.id, frame, frame.size)
                                }
                            }
                        }
                    }
                    val (sid, frame, frameLen) = step ?: break
                    sendPhysical(lane, frame)
                    var nextOtherLane: MuxLane? = null
                    lock.withLock {
                        val entry = streams[sid]
                        if (entry != null) {
                            totalBufferedBytes -= frameLen
                            entry.stream.bufferedBytes -= frameLen
                            val head = entry.outgoing.firstOrNull()
                            if (head != null) {
                                head.index += 1
                                if (head.index >= head.frames.size) {
                                    entry.outgoing.removeFirst()
                                    head.done.complete(Unit)
                                    val nextHead = entry.outgoing.firstOrNull()
                                    if (nextHead != null && nextHead.lane != lane) {
                                        nextOtherLane = nextHead.lane
                                    }
                                }
                            }
                        }
                    }
                    nextOtherLane?.let { kickDataLane(it) }
                }
            } catch (err: Throwable) {
                failConnection(err)
            } finally {
                val restart = lock.withLock {
                    pumping.remove(lane)
                    !isClosed && streams.values.any { e ->
                        val h = e.outgoing.firstOrNull()
                        e.stream.state == ChannelState.OPEN &&
                            h != null &&
                            h.lane == lane &&
                            e.sendCredit >= muxFrameCost(h.frames[h.index].size)
                    }
                }
                if (restart) kickDataLane(lane)
            }
        }
    }

    private fun enqueueControlLocked(envelope: MuxControlEnvelope) {
        if (isClosed) return
        controlQueue.addLast(encodeMuxControl(envelope))
    }

    private fun kickControlPump() {
        scope.launch {
            val shouldStart = lock.withLock {
                if (isClosed || controlSending || controlQueue.isEmpty()) false
                else {
                    controlSending = true
                    true
                }
            }
            if (!shouldStart) return@launch
            try {
                while (true) {
                    val frame = lock.withLock {
                        if (isClosed || controlQueue.isEmpty()) null else controlQueue.removeFirst()
                    } ?: break
                    sendPhysical(MuxLane.CONTROL, frame)
                }
            } catch (err: Throwable) {
                failConnection(err)
            } finally {
                val more = lock.withLock {
                    controlSending = false
                    !isClosed && controlQueue.isNotEmpty()
                }
                if (more) kickControlPump()
            }
        }
    }

    fun closeStream(id: Long, reason: Throwable? = null) {
        scope.launch {
            var toNotify: MuxLogicalStream? = null
            lock.withLock {
                val entry = streams[id] ?: return@withLock
                finishStreamLocked(entry, reason)
                toNotify = entry.stream
                enqueueControlLocked(
                    MuxControlEnvelope(
                        type = "close",
                        id = id,
                        error = reason?.message?.take(256),
                    )
                )
            }
            toNotify?.notifyClosed(reason)
            kickControlPump()
            kickAllDataLanes()
        }
    }

    private fun finishStreamLocked(entry: StreamEntry, reason: Throwable?) {
        streams.remove(entry.stream.id)
        totalBufferedBytes -= entry.stream.bufferedBytes
        entry.stream.bufferedBytes = 0
        val ex = reason ?: IllegalStateException("Mux stream is closed")
        while (entry.outgoing.isNotEmpty()) {
            entry.outgoing.removeFirst().done.completeExceptionally(ex)
        }
        entry.incoming.clear()
        entry.stream.markClosedState(ex)
    }

    suspend fun close(reason: Throwable? = null) {
        val closedStreams = lock.withLock {
            if (isClosed) return
            isClosed = true
            val list = streams.values.toList()
            for (entry in list) {
                finishStreamLocked(entry, reason)
            }
            controlQueue.clear()
            list.map { it.stream }
        }
        val ex = reason ?: IllegalStateException("Mux connection closed")
        closedStreams.forEach { it.notifyClosed(ex) }
    }

    private suspend fun failConnection(err: Throwable) {
        close(err)
        onFailed(err)
    }
}

class MuxLogicalStream(
    private val connection: MuxConnection,
    val id: Long,
    val purpose: MuxPurpose,
) : DeskFleetChannel {
    override var state: ChannelState = ChannelState.CONNECTING
        private set
    override val ready: CompletableDeferred<Unit> = CompletableDeferred()
    internal var bufferedBytes: Int = 0

    private var messageHandler: (suspend (ChannelPayload) -> Unit)? = null
    override var onMessage: (suspend (ChannelPayload) -> Unit)?
        get() = messageHandler
        set(value) {
            messageHandler = value
            if (value != null) connection.scheduleDeliver(id)
        }

    override var onClose: ((Throwable?) -> Unit)? = null

    override suspend fun sendText(text: String, bulk: Boolean) {
        connection.sendFromStream(id, ChannelPayload.Text(text), bulk)
    }

    override suspend fun sendBinary(bytes: ByteArray, bulk: Boolean) {
        connection.sendFromStream(id, ChannelPayload.Binary(bytes), bulk)
    }

    override fun close(reason: Throwable?) {
        connection.closeStream(id, reason)
    }

    internal fun markOpened() {
        if (state == ChannelState.CONNECTING) {
            state = ChannelState.OPEN
            ready.complete(Unit)
            connection.scheduleDeliver(id)
        }
    }

    internal fun markClosedState(err: Throwable) {
        if (state != ChannelState.CLOSED) {
            state = ChannelState.CLOSED
            ready.completeExceptionally(err)
        }
    }

    internal fun notifyClosed(reason: Throwable?) {
        val cb = onClose
        onClose = null
        messageHandler = null
        cb?.invoke(reason)
    }
}
