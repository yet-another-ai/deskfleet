import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cpus } from "node:os"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs } from "node:util"
import { createPeer, type IceCandidate, type NativePeer, type PeerConfig } from "../crates/node/index.ts"

const { values } = parseArgs({ options: {
  "size-mib": { type: "string", default: "32" }, rounds: { type: "string", default: "3" },
  "chunk-kib": { type: "string", default: "16" }, window: { type: "string", default: "1" },
  "retry-ms": { type: "string", default: "10" }, addon: { type: "string" },
  label: { type: "string", default: "working-tree" }, help: { type: "boolean", default: false },
} })
if (values.help) {
  console.log("Usage: mise exec -- node scripts/benchmark-webrtc.ts [--size-mib 32] [--rounds 3] [--chunk-kib 16] [--window 1] [--retry-ms 10] [--addon /absolute/deskfleet.node] [--label name]\nMeasures same-host native WebRTC DataChannel delivery in both directions, without disk or the file RPC protocol. SDP and host ICE candidates are exchanged directly with no STUN/TURN. Timing includes receiver copies into a preallocated buffer; setup, allocation, and SHA-256 verification are excluded. The window bounds outstanding send calls, not total transport buffering. JSON lines include throughput, CPU, event-loop delay, send-call latency, and backpressure retries.")
  process.exit(0)
}
function integer(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  assert.ok(Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum, `${name} must be an integer from ${minimum} to ${maximum}`)
  return parsed
}
const sizeMiB = integer(values["size-mib"], "--size-mib", 1, 1024)
const rounds = integer(values.rounds, "--rounds", 1, 20)
const chunkBytes = integer(values["chunk-kib"], "--chunk-kib", 1, 64) * 1024
const window = integer(values.window, "--window", 1, 64)
const retryMs = integer(values["retry-ms"], "--retry-ms", 0, 1000)
const bytes = sizeMiB * 1024 * 1024
const chunkCount = Math.ceil(bytes / chunkBytes)
const label = "deskfleet-benchmark"
const addon = values.addon ? resolve(values.addon) : undefined
let makePeer: (config: PeerConfig) => Promise<NativePeer> = createPeer
if (addon) {
  const module = { exports: {} as typeof import("../crates/node/bindings.d.ts") }
  process.dlopen(module, addon)
  makePeer = module.exports.createPeer
}
const source = Buffer.allocUnsafe(bytes)
let seed = 0x9e3779b9
for (let offset = 0; offset < bytes; offset += 4) {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  source.writeUInt32LE(seed >>> 0, offset)
}
// An offset in every message verifies delivery even with concurrent send calls.
for (let offset = 0; offset < bytes; offset += chunkBytes) source.writeUInt32LE(offset, offset)
const expected = createHash("sha256").update(source).digest("hex")
const destination = Buffer.allocUnsafe(bytes)
const received = new Uint8Array(chunkCount)
const receiveGapDurations = new Float64Array(Math.max(0, chunkCount - 1))
interface ReceiveGap { gapMs: number; startedAtMs: number; receivedBytesBefore: number }
interface BackpressureStreak {
  worker: number; packet: number; startedAtMs: number; elapsedMs: number
  retries: number; receivedBytesStart: number; receivedBytesEnd: number
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const failed = deferred<never>()
void failed.promise.catch(() => {})
const peers: NativePeer[] = []
const pumps: Promise<void>[] = []
const candidates: IceCandidate[][] = [[], []]
const readyForCandidates = [false, false]
const opened = [deferred<void>(), deferred<void>()]
const delays = monitorEventLoopDelay({ resolution: 10 })
let stopping = false
let receiverIndex = -1
let receivedBytes = 0
let receivedAt = 0
let receiveStartedAt = 0, firstReceiveAt = 0, lastReceiveAt = 0, receiveGapCount = 0
let longestReceiveGaps: ReceiveGap[] = []
let done = deferred<void>()
const results: Array<{ direction: string; round: number; mibPerSecond: number }> = []

async function bounded<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, failed.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation} timed out after ${milliseconds} ms`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
async function pump(index: number): Promise<void> {
  const peer = peers[index]!, remote = peers[1 - index]!
  while (!stopping) {
    const event = await peer.nextEvent()
    if (stopping) return
    if (!event) throw new Error(`Peer ${index} closed`)
    if (event.kind === "iceCandidate" && event.candidate) {
      candidates[1 - index]!.push(event.candidate)
      console.log(JSON.stringify({ event: "candidate", peer: index, candidate: event.candidate.candidate }))
      if (readyForCandidates[1 - index]) await remote.addIceCandidate(event.candidate)
    } else if (event.kind === "dataChannelOpen" && event.label === label) opened[index]!.resolve()
    else if (event.kind === "data" && event.label === label) {
      const now = performance.now()
      if (lastReceiveAt) {
        const gapMs = now - lastReceiveAt
        receiveGapDurations[receiveGapCount++] = gapMs
        if (longestReceiveGaps.length < 10 || gapMs > longestReceiveGaps.at(-1)!.gapMs) {
          longestReceiveGaps.push({ gapMs, startedAtMs: lastReceiveAt - receiveStartedAt, receivedBytesBefore: receivedBytes })
          longestReceiveGaps.sort((a, b) => b.gapMs - a.gapMs)
          if (longestReceiveGaps.length > 10) longestReceiveGaps.pop()
        }
      } else firstReceiveAt = now
      lastReceiveAt = now
      assert.equal(index, receiverIndex, "Data arrived outside the active receiving peer")
      assert.equal(event.isString, false)
      const data = event.data!
      assert.ok(data.length >= 4)
      const offset = data.readUInt32LE(0), packet = offset / chunkBytes
      assert.ok(Number.isSafeInteger(packet) && packet < chunkCount, "Invalid packet offset")
      assert.equal(received[packet], 0, "Duplicate packet")
      assert.equal(data.length, Math.min(chunkBytes, bytes - offset), "Unexpected packet length")
      received[packet] = 1
      data.copy(destination, offset)
      receivedBytes += data.length
      if (receivedBytes === bytes) { receivedAt = performance.now(); done.resolve() }
    } else if (event.kind === "error" || event.kind === "dataChannelClosed" || ["failed", "closed"].includes(event.state ?? "")) {
      throw new Error(event.error ?? `Peer ${index}: ${event.kind} ${event.state ?? ""}`)
    }
  }
}
function percentile(values: ArrayLike<number>, fraction: number): number {
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0
}
async function measure(senderIndex: number, round: number): Promise<void> {
  const direction = senderIndex === 0 ? "a-to-b" : "b-to-a"
  const peer = peers[senderIndex]!
  receiverIndex = 1 - senderIndex
  receivedBytes = 0; receivedAt = 0; received.fill(0)
  firstReceiveAt = 0; lastReceiveAt = 0; receiveGapCount = 0; longestReceiveGaps = []
  done = deferred<void>()
  let next = 0, retries = 0, retryWaitMs = 0, sendCalls = 0, streakCount = 0
  const callDurations: number[] = []
  const longestBackpressureStreaks: BackpressureStreak[] = []
  delays.reset()
  const cpu = process.cpuUsage(), utilization = performance.eventLoopUtilization()
  const started = performance.now()
  receiveStartedAt = started
  const sending = Promise.all(Array.from({ length: window }, async (_, worker) => {
    for (;;) {
      const packet = next++
      if (packet >= chunkCount) return
      const offset = packet * chunkBytes, data = source.subarray(offset, Math.min(offset + chunkBytes, bytes))
      const deadline = performance.now() + 10_000
      let streak: BackpressureStreak | undefined
      for (;;) {
        if (stopping) throw new Error("Benchmark stopped")
        const callStarted = performance.now()
        sendCalls++
        try {
          await peer.sendData(label, data)
          const now = performance.now()
          callDurations.push(now - callStarted)
          if (streak) {
            streak.elapsedMs = now - started - streak.startedAtMs
            streak.receivedBytesEnd = receivedBytes
            streakCount++
            if (longestBackpressureStreaks.length < 10 || streak.elapsedMs > longestBackpressureStreaks.at(-1)!.elapsedMs) {
              longestBackpressureStreaks.push(streak)
              longestBackpressureStreaks.sort((a, b) => b.elapsedMs - a.elapsedMs)
              if (longestBackpressureStreaks.length > 10) longestBackpressureStreaks.pop()
            }
          }
          break
        }
        catch (error) {
          callDurations.push(performance.now() - callStarted)
          if (!/backpressure|send buffer is full/iu.test(String(error)) || performance.now() >= deadline) throw error
          retries++
          const waitStarted = performance.now()
          streak ??= { worker, packet, startedAtMs: waitStarted - started, elapsedMs: 0, retries: 0, receivedBytesStart: receivedBytes, receivedBytesEnd: receivedBytes }
          streak.retries++
          await delay(retryMs)
          retryWaitMs += performance.now() - waitStarted
        }
      }
    }
  }))
  await bounded(sending, 5 * 60_000, `${direction} send`)
  const sentAt = performance.now()
  await bounded(done.promise, 5 * 60_000, `${direction} receive`)
  const elapsedMs = Math.max(sentAt, receivedAt) - started
  const cpuDelta = process.cpuUsage(cpu), loopDelta = performance.eventLoopUtilization(utilization)
  const eventLoopDelay = { p50Ms: delays.percentile(50) / 1e6, p99Ms: delays.percentile(99) / 1e6, maxMs: delays.max / 1e6 }
  // Content verification is outside the timed interval.
  assert.equal(receivedBytes, bytes)
  assert.equal(createHash("sha256").update(destination).digest("hex"), expected, "Received content differs")
  callDurations.sort((a, b) => a - b)
  const sortedReceiveGaps = receiveGapDurations.subarray(0, receiveGapCount).sort()
  const measurement = { direction, round, mibPerSecond: sizeMiB * 1000 / elapsedMs }
  results.push(measurement)
  console.log(JSON.stringify({ event: "result", label: values.label, sizeMiB, chunkBytes, window, retryMs, ...measurement,
    seconds: elapsedMs / 1000, sendSeconds: (sentAt - started) / 1000, receiveSeconds: (receivedAt - started) / 1000,
    receiveTailMs: Math.max(0, receivedAt - sentAt), packets: chunkCount, sendCalls, backpressureRetries: retries, retryWaitMs,
    receiveGaps: { firstMessageMs: firstReceiveAt - started, count: receiveGapCount,
      p99Ms: percentile(sortedReceiveGaps, .99), maxMs: sortedReceiveGaps.at(-1) ?? 0, longest: longestReceiveGaps },
    backpressureStreaks: { count: streakCount, longest: longestBackpressureStreaks },
    sendCallMs: { p50: percentile(callDurations, .5), p99: percentile(callDurations, .99), max: callDurations.at(-1) },
    cpuMs: { user: cpuDelta.user / 1000, system: cpuDelta.system / 1000 },
    cpuCores: (cpuDelta.user + cpuDelta.system) / 1000 / elapsedMs, eventLoopUtilization: loopDelta.utilization,
    eventLoopDelay, sha256: expected,
  }))
  receiverIndex = -1
}

try {
  peers.push(await makePeer({ iceServers: [] }))
  peers.push(await makePeer({ iceServers: [] }))
  for (let index = 0; index < peers.length; index++) {
    pumps.push(pump(index).catch(error => { if (!stopping) failed.reject(error) }))
  }
  await peers[0]!.createDataChannel(label)
  const offer = await peers[0]!.createOffer()
  const answer = await peers[1]!.answerOffer(offer)
  readyForCandidates[1] = true
  for (const candidate of candidates[1]!.splice(0)) await peers[1]!.addIceCandidate(candidate)
  await peers[0]!.acceptAnswer(answer)
  readyForCandidates[0] = true
  for (const candidate of candidates[0]!.splice(0)) await peers[0]!.addIceCandidate(candidate)
  await bounded(Promise.all(opened.map(value => value.promise)), 30_000, "DataChannel connection")
  delays.enable()
  console.log(JSON.stringify({ event: "ready", label: values.label, addon: addon ?? "crates/node/deskfleet.node", sizeMiB, rounds,
    chunkBytes, window, retryMs, node: process.versions.node, platform: process.platform, architecture: process.arch,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, transport: "native WebRTC same-host, no STUN/TURN",
    includes: "send through receipt and receiver memory copy; excludes setup, allocation, SHA-256", integrity: "packet offsets, lengths, duplicates, and SHA-256",
  }))
  for (let round = 1; round <= rounds; round++) {
    await measure(0, round)
    await measure(1, round)
  }
  const median = (direction: string) => {
    const rates = results.filter(result => result.direction === direction).map(result => result.mibPerSecond).sort((a, b) => a - b)
    const middle = Math.floor(rates.length / 2)
    return rates.length % 2 ? rates[middle]! : (rates[middle - 1]! + rates[middle]!) / 2
  }
  console.log(JSON.stringify({ event: "summary", label: values.label, sizeMiB, rounds, chunkBytes, window, retryMs,
    aToBMiBPerSecond: median("a-to-b"), bToAMiBPerSecond: median("b-to-a"),
  }))
} finally {
  stopping = true
  delays.disable()
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([Promise.allSettled(peers.map(peer => peer.close())).then(() => Promise.all(pumps)), new Promise<never>((_, reject) => {
      closeTimer = setTimeout(() => reject(new Error("Peer cleanup timed out")), 10_000)
    })])
  } finally { clearTimeout(closeTimer) }
}
