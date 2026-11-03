import {
  MUX_CONNECTION_QUEUE_BYTES, MUX_FRAME_BYTES, MUX_HEADER_BYTES, MUX_MAX_STREAMS,
  MUX_MESSAGE_BYTES, MUX_STREAM_QUEUE_BYTES, MUX_WINDOW_BYTES,
  decodeMuxControl, decodeMuxFrame, encodeMuxControl, encodeMuxFrame,
  muxDefaultLane, muxFrameCost, muxLaneAllowed, muxPurpose,
  type MuxControl, type MuxDataLane, type MuxLane, type MuxPurpose,
} from "./protocol.ts"

export interface MuxConnectionOptions {
  role: "client" | "server"
  /** Resolves after sending, waiting for physical-channel capacity if necessary. */
  send(lane: MuxLane, bytes: Uint8Array): Promise<void>
  /** Install handlers synchronously. Throwing rejects only this logical stream. */
  accept?(stream: MuxStream): void
  failed(error: Error): void
}
type Data = string | Uint8Array
type Receiver = (data: Data) => void | Promise<void>
interface Outgoing {
  lane: MuxDataLane
  frames: Uint8Array[]
  index: number
  resolve(): void
  reject(error: Error): void
}
interface Incoming {
  chunks: Uint8Array[]
  total: number
  offset: number
  cost: number
  text: boolean
  lane: MuxDataLane
}
interface StreamState {
  stream: MuxStream
  local: boolean
  nextSend: number
  nextReceive: number
  credit: number
  receiveCredit: number
  outgoing: Outgoing[]
  incoming: Map<number, Incoming>
  delivering: boolean
}
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const dataLanes: MuxDataLane[] = ["terminal", "agent", "bulk"]
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error))
const CLOSED = "Mux stream is closed"

/** One logical message channel. Closing it aborts pending data, never its siblings. */
export class MuxStream {
  readonly id: number
  readonly purpose: MuxPurpose
  readonly ready: Promise<void>
  onClose: ((error?: Error) => void) | undefined
  /** Called on decreases; adapters can apply their own low-water threshold. */
  onBufferedAmountLow: (() => void) | undefined
  readonly #connection: MuxConnection
  #receiver: Receiver | undefined
  #state: "connecting" | "open" | "closed" = "connecting"
  #error: Error | undefined
  #buffered = 0
  #resolve!: () => void
  #reject!: (error: Error) => void

  constructor(connection: MuxConnection, id: number, purpose: MuxPurpose) {
    this.#connection = connection; this.id = id; this.purpose = purpose
    this.ready = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject })
    // A view can close before its asynchronous transport adapter observes ready.
    void this.ready.catch(() => {})
  }
  get state(): "connecting" | "open" | "closed" { return this.#state }
  get error(): Error | undefined { return this.#error }
  get bufferedAmount(): number { return this.#buffered }
  get onData(): Receiver | undefined { return this.#receiver }
  set onData(receiver: Receiver | undefined) { this.#receiver = receiver; this.#connection.deliver(this.id) }
  send(data: Data, lane?: MuxDataLane): Promise<void> { return this.#connection.send(this.id, data, lane) }
  close(error?: Error): void { this.#connection.closeStream(this.id, error) }

  /** @internal */ opened(): void {
    if (this.#state !== "connecting") return
    this.#state = "open"; this.#resolve(); this.#connection.deliver(this.id)
  }
  /** @internal */ buffered(delta: number): void {
    this.#buffered += delta
    if (delta < 0) this.onBufferedAmountLow?.()
  }
  /** @internal */ closed(error?: Error): void {
    if (this.#state === "closed") return
    this.#state = "closed"; this.#error = error; this.#buffered = 0; this.#reject(error ?? new Error(CLOSED))
    this.#receiver = undefined
    try { this.onClose?.(error) } catch { /* A consumer's cleanup cannot retain sibling streams. */ }
    finally { this.onClose = undefined; this.onBufferedAmountLow = undefined }
  }
}

/** Four physical lanes, bounded logical streams, and consumption-based receive credit. */
export class MuxConnection {
  readonly #options: MuxConnectionOptions
  readonly #streams = new Map<number, StreamState>()
  readonly #pumping = new Set<MuxDataLane>()
  readonly #last = new Map<MuxDataLane, number>()
  readonly #control: Uint8Array[] = []
  #controlBytes = 0
  #controlSending = false
  #nextId: number
  #remoteId = 0
  #buffered = 0
  #closed = false

  constructor(options: MuxConnectionOptions) {
    this.#options = options
    this.#nextId = options.role === "client" ? 1 : 2
  }
  get closed(): boolean { return this.#closed }
  get streamCount(): number { return this.#streams.size }
  get bufferedAmount(): number { return this.#buffered }

  open(purpose: MuxPurpose): MuxStream {
    if (this.#closed) throw new Error("Mux connection is closed")
    if (!muxPurpose(purpose)) throw new Error("Unsupported Mux stream purpose")
    if (this.#streams.size >= MUX_MAX_STREAMS) throw new Error("Too many Mux streams")
    if (this.#nextId > 0xffffffff) throw new Error("Mux stream IDs exhausted")
    const id = this.#nextId; this.#nextId += 2
    const stream = this.#add(id, purpose, true)
    this.#enqueueControl({ type: "open", id, purpose })
    return stream
  }

  #add(id: number, purpose: MuxPurpose, local: boolean): MuxStream {
    const stream = new MuxStream(this, id, purpose)
    this.#streams.set(id, { stream, local, nextSend: 0, nextReceive: 0, credit: MUX_WINDOW_BYTES,
      receiveCredit: MUX_WINDOW_BYTES, outgoing: [], incoming: new Map(), delivering: false })
    return stream
  }

  receive(lane: MuxLane, bytes: Uint8Array): void {
    if (this.#closed) return
    try {
      if (lane === "control") this.#receiveControl(decodeMuxControl(bytes))
      else if (dataLanes.includes(lane)) this.#receiveData(lane, bytes)
      else throw new Error("Unknown Mux lane")
    } catch (error) { this.#fail(errorOf(error)) }
  }

  #retired(id: number): boolean {
    const local = id % 2 === (this.#options.role === "client" ? 1 : 0)
    return local ? id < this.#nextId : id <= this.#remoteId
  }

  #receiveControl(value: MuxControl): void {
    if (value.type === "open") {
      if (value.id % 2 === this.#nextId % 2 || value.id <= this.#remoteId) throw new Error("Invalid or reused remote Mux stream ID")
      this.#remoteId = value.id
      if (this.#streams.size >= MUX_MAX_STREAMS || !this.#options.accept) {
        this.#enqueueControl({ type: "close", id: value.id, error: "Mux stream is not accepted" }); return
      }
      const stream = this.#add(value.id, value.purpose, false)
      stream.opened()
      try { this.#options.accept(stream) }
      catch (error) { stream.close(errorOf(error)); return }
      if (stream.state !== "closed") this.#enqueueControl({ type: "opened", id: value.id })
      return
    }
    const state = this.#streams.get(value.id)
    if (!state) {
      if (this.#retired(value.id)) return
      throw new Error("Unknown Mux stream")
    }
    if (value.type === "close") { this.#finish(state, value.error ? new Error(value.error) : undefined); return }
    if (value.type === "opened") {
      if (!state.local || state.stream.state !== "connecting") throw new Error("Unexpected Mux opened response")
      state.stream.opened(); this.#kickAll(); return
    }
    if (state.credit + value.bytes > MUX_WINDOW_BYTES) throw new Error("Invalid Mux receive credit")
    state.credit += value.bytes
    this.#kickAll()
  }

  #receiveData(lane: MuxDataLane, bytes: Uint8Array): void {
    const frame = decodeMuxFrame(bytes)
    const state = this.#streams.get(frame.id)
    if (!state) {
      if (this.#retired(frame.id)) return
      throw new Error("Unknown Mux data stream")
    }
    if (!muxLaneAllowed(state.stream.purpose, lane)) throw new Error("Mux data arrived on the wrong lane")
    if (frame.sequence < state.nextReceive || frame.sequence - state.nextReceive >= MUX_WINDOW_BYTES / 1024) throw new Error("Invalid Mux message sequence")
    const cost = muxFrameCost(bytes.length)
    if (cost > state.receiveCredit) throw new Error("Mux receive window exceeded")
    let message = state.incoming.get(frame.sequence)
    if (!message) {
      if (frame.offset !== 0) throw new Error("Mux message starts at a nonzero offset")
      // Retain received fragments only: a peer's advertised total never causes
      // an allocation before those bytes fit within its receive credit.
      message = { chunks: [], total: frame.total, offset: 0, cost: 0, text: frame.text, lane }
      state.incoming.set(frame.sequence, message)
    }
    if (message.offset !== frame.offset || message.text !== frame.text || message.total !== frame.total || message.lane !== lane || message.cost > 0 && message.offset === message.total) throw new Error("Invalid Mux message fragment")
    state.receiveCredit -= cost
    message.chunks.push(frame.data.slice()); message.offset += frame.data.length; message.cost += cost
    this.deliver(frame.id)
  }

  /** @internal: called by the receiver setter as well as network delivery. */
  deliver(id: number): void {
    const state = this.#streams.get(id)
    if (!state || state.delivering || state.stream.state !== "open" || !state.stream.onData) return
    state.delivering = true
    void (async () => {
      while (this.#streams.get(id) === state && state.stream.onData) {
        const message = state.incoming.get(state.nextReceive)
        if (!message || message.offset !== message.total) break
        const data = new Uint8Array(message.total)
        let offset = 0
        for (const chunk of message.chunks) { data.set(chunk, offset); offset += chunk.length }
        message.chunks = []
        await state.stream.onData(message.text ? decoder.decode(data) : data)
        if (this.#streams.get(id) !== state) return
        state.incoming.delete(state.nextReceive++)
        state.receiveCredit += message.cost
        this.#enqueueControl({ type: "credit", id, bytes: message.cost })
      }
    })().catch(error => this.closeStream(id, errorOf(error))).finally(() => {
      state.delivering = false
      const next = state.incoming.get(state.nextReceive)
      if (next && next.offset === next.total && this.#streams.get(id) === state) this.deliver(id)
    })
  }

  /** @internal: sends preserve message boundaries and per-stream order across lanes. */
  send(id: number, data: Data, lane?: MuxDataLane): Promise<void> {
    const state = this.#streams.get(id)
    if (!state || state.stream.state !== "open") return Promise.reject(new Error(CLOSED))
    lane ??= muxDefaultLane(state.stream.purpose)
    if (!muxLaneAllowed(state.stream.purpose, lane)) return Promise.reject(new Error("Invalid Mux send lane"))
    const bytes = typeof data === "string" ? encoder.encode(data) : data
    if (bytes.length > MUX_MESSAGE_BYTES) return Promise.reject(new Error("Mux message exceeds 64 KiB"))
    if (state.nextSend > 0xffffffff) return Promise.reject(new Error("Mux message sequences exhausted"))
    const fragments = Math.max(1, Math.ceil(bytes.length / (MUX_FRAME_BYTES - MUX_HEADER_BYTES)))
    const size = bytes.length + fragments * MUX_HEADER_BYTES
    if (state.stream.bufferedAmount + size > MUX_STREAM_QUEUE_BYTES || this.#buffered + size > MUX_CONNECTION_QUEUE_BYTES || state.outgoing.length >= 512) return Promise.reject(new Error("Mux send queue is full"))
    const frames: Uint8Array[] = [], sequence = state.nextSend++
    for (let offset = 0; offset < bytes.length || frames.length === 0; offset += MUX_FRAME_BYTES - MUX_HEADER_BYTES) {
      frames.push(encodeMuxFrame({ id, sequence, offset, total: bytes.length, text: typeof data === "string", data: bytes.subarray(offset, offset + MUX_FRAME_BYTES - MUX_HEADER_BYTES) }))
    }
    this.#buffered += size; state.stream.buffered(size)
    const promise = new Promise<void>((resolve, reject) => { state.outgoing.push({ lane, frames, index: 0, resolve, reject }) })
    this.#kick(lane)
    return promise
  }

  #kickAll(): void { for (const lane of dataLanes) this.#kick(lane) }
  #kick(lane: MuxDataLane): void {
    if (this.#closed || this.#pumping.has(lane)) return
    this.#pumping.add(lane)
    queueMicrotask(() => { void this.#pump(lane).catch(error => this.#fail(errorOf(error))).finally(() => {
      this.#pumping.delete(lane)
      if (!this.#closed && this.#next(lane)) this.#kick(lane)
    }) })
  }

  #next(lane: MuxDataLane): StreamState | undefined {
    const states = [...this.#streams.values()]
    const last = states.findIndex(state => state.stream.id === this.#last.get(lane))
    for (let offset = 1; offset <= states.length; offset++) {
      const state = states[(last + offset) % states.length]!
      const job = state.outgoing[0]
      if (state.stream.state === "open" && job?.lane === lane && state.credit >= muxFrameCost(job.frames[job.index]!.length)) return state
    }
    return undefined
  }

  async #pump(lane: MuxDataLane): Promise<void> {
    for (;;) {
      if (this.#closed) return
      const state = this.#next(lane)
      if (!state) return
      const job = state.outgoing[0]!, frame = job.frames[job.index]!
      this.#last.set(lane, state.stream.id)
      state.credit -= muxFrameCost(frame.length)
      await this.#options.send(lane, frame)
      if (this.#streams.get(state.stream.id) !== state) continue
      this.#buffered -= frame.length; state.stream.buffered(-frame.length)
      job.index++
      if (job.index === job.frames.length) {
        state.outgoing.shift(); job.resolve()
        // No later message can spend this stream's credit before its predecessor
        // is completely sent, even when it uses a different physical lane.
        const nextLane = state.outgoing[0]?.lane
        if (nextLane && nextLane !== lane) this.#kick(nextLane)
      }
    }
  }

  #enqueueControl(value: MuxControl): void {
    if (this.#closed) return
    const bytes = encodeMuxControl(value)
    if (this.#controlBytes + bytes.length > 64 * 1024) { this.#fail(new Error("Mux control queue is full")); return }
    this.#controlBytes += bytes.length; this.#control.push(bytes)
    this.#flushControl()
  }

  #flushControl(): void {
    if (this.#closed) return
    if (this.#controlSending) return
    this.#controlSending = true
    void (async () => {
      while (!this.#closed && this.#control.length) {
        const frame = this.#control[0]!
        await this.#options.send("control", frame)
        if (this.#closed) return
        this.#control.shift(); this.#controlBytes -= frame.length
      }
    })().catch(error => this.#fail(errorOf(error))).finally(() => {
      this.#controlSending = false
      if (this.#control.length && !this.#closed) this.#flushControl()
    })
  }

  /** @internal */ closeStream(id: number, error?: Error): void {
    const state = this.#streams.get(id)
    if (!state) return
    this.#finish(state, error)
    this.#enqueueControl({ type: "close", id, ...(error ? { error: error.message.slice(0, 256) } : {}) })
    this.#kickAll()
  }

  #finish(state: StreamState, error?: Error): void {
    this.#streams.delete(state.stream.id)
    this.#buffered -= state.stream.bufferedAmount
    for (const job of state.outgoing) job.reject(error ?? new Error(CLOSED))
    state.outgoing = []; state.incoming.clear()
    state.stream.closed(error)
  }

  close(error?: Error): void {
    if (this.#closed) return
    this.#closed = true
    for (const state of this.#streams.values()) this.#finish(state, error)
    this.#control.length = 0; this.#controlBytes = 0
  }

  #fail(error: Error): void {
    if (this.#closed) return
    this.close(error); this.#options.failed(error)
  }
}
