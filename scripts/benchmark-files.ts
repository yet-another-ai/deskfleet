import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { createPeer, type NativePeer } from "../crates/node/index.ts"
import { createNativeFileEndpoint } from "../apps/desktop/src/main/files-peer.ts"
import { FilesChannel } from "../apps/daemon/src/files-channel.ts"
import { FILES_CHANNEL, type FileEndpoint } from "../apps/daemon/src/files-protocol.ts"
import { FilesService } from "../apps/daemon/src/files-service.ts"
import type { CentralApi, CentralEvent } from "../packages/client/src/central.ts"
import { FileTransferManager } from "../packages/client/src/file-transfers.ts"
import type { FileTransfer, FileTransferRequest } from "../packages/client/src/files.ts"

const { values } = parseArgs({ options: {
  "size-mib": { type: "string", default: "32" }, rounds: { type: "string", default: "3" },
  implementation: { type: "string" }, label: { type: "string", default: "working-tree" },
  transport: { type: "string", default: "native" }, addon: { type: "string" },
  profile: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} })
if (values.help) {
  console.log("Usage: mise exec -- node scripts/benchmark-files.ts [--size-mib 32] [--rounds 3] [--label name] [--transport native|direct] [--addon /absolute/deskfleet.node] [--profile] [--implementation /absolute/snapshot.mjs]\nMeasures native WebRTC uploads/downloads on this machine after connecting, then verifies SHA-256. Direct mode keeps the same transfer manager and separate filesystem endpoints, bypassing WebRTC and wire framing. --addon selects a build without replacing the installed addon. --profile adds process CPU, event-loop, filesystem RPC call latency (including its serialized queue), and native send metrics. File generation, connection setup, and hashing are excluded. JSON lines contain each result and medians; no throughput threshold is asserted.")
  process.exit(0)
}
const sizeMiB = Number(values["size-mib"]), rounds = Number(values.rounds)
assert.ok(Number.isSafeInteger(sizeMiB) && sizeMiB >= 1 && sizeMiB <= 1024, "--size-mib must be an integer from 1 to 1024")
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 20, "--rounds must be an integer from 1 to 20")
assert.ok(values.transport === "native" || values.transport === "direct", "--transport must be native or direct")

interface CallMetric { calls: number; bytes: number; totalCallMs: number; maxCallMs: number; errors: number; backpressure: number }
let metrics: Record<string, CallMetric> = {}
const candidates = new Set<string>()
let loadedAddon: string | undefined
let peerCount = 0
async function profiled<T>(name: string, byteLength: number, call: () => Promise<T>): Promise<T> {
  if (!values.profile) return call()
  const metric = metrics[name] ??= { calls: 0, bytes: 0, totalCallMs: 0, maxCallMs: 0, errors: 0, backpressure: 0 }
  metric.calls++; metric.bytes += byteLength
  const started = performance.now()
  try { return await call() }
  catch (error) {
    metric.errors++
    if (/backpressure|send buffer is full/iu.test(error instanceof Error ? error.message : String(error))) metric.backpressure++
    throw error
  } finally {
    const elapsed = performance.now() - started
    metric.totalCallMs += elapsed; metric.maxCallMs = Math.max(metric.maxCallMs, elapsed)
  }
}
function profileEndpoint(endpoint: FileEndpoint, name: string): FileEndpoint {
  if (!values.profile) return endpoint
  return {
    call: (method, params, data) => profiled(`${name}.${method}`, data?.byteLength ?? 0, () => endpoint.call(method, params, data)),
    close: () => endpoint.close(),
  }
}
// The loader is lazy. Intercept only DeskFleet's addon before either endpoint
// initializes it; both native peers then share the explicitly selected build.
const originalDlopen = process.dlopen
if (values.addon || values.profile) {
  process.dlopen = (module, filename, flags) => {
    if (basename(filename) !== "deskfleet.node") return originalDlopen(module, filename, flags)
    const selected = values.addon ? resolve(values.addon) : filename
    originalDlopen(module, selected, flags)
    loadedAddon = selected
    if (values.profile) {
      const holder = module as { exports: typeof import("../crates/node/bindings.d.ts") }
      const native = holder.exports
      holder.exports = { ...native, async createPeer(config: Parameters<typeof createPeer>[0]): Promise<NativePeer> {
        const peer = await native.createPeer(config ?? {}), name = `peer${++peerCount}`
        const send = peer.sendData.bind(peer)
        const sendData: NativePeer["sendData"] = (label, data) => profiled(`${name}.sendData`, data.byteLength, () => send(label, data))
        return new Proxy(peer, { get(target, key) {
          if (key === "sendData") return sendData
          const value: unknown = Reflect.get(target, key, target)
          return typeof value === "function" ? value.bind(target) : value
        } })
      } }
    }
  }
}

// A bundled snapshot permits before/after measurements with the exact same harness.
const current = { createPeer, createNativeFileEndpoint, FilesChannel, FilesService, FileTransferManager, FILES_CHANNEL }
const implementation = values.implementation
  ? await import(pathToFileURL(resolve(values.implementation)).href) as typeof current : current
const bytes = sizeMiB * 1024 * 1024
const directory = await mkdtemp(join(tmpdir(), "deskfleet-files-benchmark-"))
const sourceDirectory = join(directory, "source"), remoteDirectory = join(directory, "remote"), backDirectory = join(directory, "back")
const listeners = new Set<(event: CentralEvent) => void>()
const failures: unknown[] = []
let stopped = false
let daemon: Awaited<ReturnType<typeof createPeer>> | undefined
let channel: FilesChannel | undefined
let pumping: Promise<void> | undefined
let manager: FileTransferManager | undefined
const results: Array<{ direction: "upload" | "download"; round: number; seconds: number; mibPerSecond: number; mbPerSecond: number }> = []

async function hash(path: string): Promise<string> {
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest("hex")
}
async function closePeer(): Promise<void> {
  if (stopped) return
  stopped = true
  await Promise.all([channel?.close(), daemon?.close()])
  await pumping
}
async function complete(id: string): Promise<FileTransfer> {
  return new Promise((resolveTransfer, reject) => {
    let unsubscribe = () => {}
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Transfer benchmark timed out")) }, 5 * 60_000)
    const inspect = (jobs: FileTransfer[]) => {
      const job = jobs.find(value => value.id === id)
      if (!job || ["queued", "preparing", "transferring"].includes(job.state)) return
      clearTimeout(timer); unsubscribe()
      if (job.state === "completed") resolveTransfer(job)
      else reject(new Error(`Transfer ${job.state}: ${job.error}`))
    }
    unsubscribe = manager!.onChanged(inspect)
    void manager!.transfers().then(inspect, error => { clearTimeout(timer); unsubscribe(); reject(error) })
  })
}
async function measure(direction: "upload" | "download", round: number, request: FileTransferRequest, destination: string, expected: string): Promise<void> {
  metrics = {}
  const cpuBefore = process.cpuUsage(), loopBefore = performance.eventLoopUtilization()
  const delay = values.profile ? monitorEventLoopDelay({ resolution: 10 }) : undefined
  delay?.enable()
  const started = performance.now()
  let result: FileTransfer
  try { result = await complete(await manager!.enqueue(request)) }
  finally { delay?.disable() }
  const seconds = (performance.now() - started) / 1000
  const cpu = process.cpuUsage(cpuBefore), loop = performance.eventLoopUtilization(loopBefore)
  const profile = values.profile ? {
    cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
    cpuCoreEquivalent: (cpu.user + cpu.system) / (seconds * 1_000_000),
    eventLoopUtilization: loop.utilization, eventLoopActiveMs: loop.active, eventLoopIdleMs: loop.idle,
    eventLoopDelayMeanMs: Number.isFinite(delay!.mean) ? delay!.mean / 1_000_000 : null,
    eventLoopDelayP99Ms: delay!.percentile(99) / 1_000_000, eventLoopDelayMaxMs: delay!.max / 1_000_000,
    calls: metrics,
  } : undefined
  assert.equal(result.transferredBytes, bytes)
  assert.equal(result.totalBytes, bytes)
  assert.equal(await hash(destination), expected, "Transferred file SHA-256 differs")
  const measurement = { direction, round, seconds, mibPerSecond: sizeMiB / seconds, mbPerSecond: bytes / 1_000_000 / seconds }
  results.push(measurement)
  console.log(JSON.stringify({ event: "result", label: values.label, transport: values.transport, sizeMiB, ...measurement, sha256: expected, profile }))
}

try {
  await Promise.all([mkdir(sourceDirectory), mkdir(remoteDirectory), mkdir(backDirectory)])
  const source = join(sourceDirectory, "payload.bin")
  const output = await open(source, "wx")
  try {
    // A fixed pseudorandom block gives repeated runs identical file contents.
    const block = Buffer.allocUnsafe(1024 * 1024)
    let seed = 0x9e3779b9
    for (let offset = 0; offset < block.length; offset += 4) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
      block.writeUInt32LE(seed >>> 0, offset)
    }
    for (let offset = 0; offset < bytes; offset += block.length) await output.writeFile(block)
  } finally { await output.close() }
  const expected = await hash(source)

  const target = { kind: "machine", teamId: "benchmark", machineId: "loopback" } as const
  const remoteService = profileEndpoint(new implementation.FilesService(), "remoteService")
  let remote: FileEndpoint = remoteService
  if (values.transport === "native") {
    daemon = await implementation.createPeer({})
    const peer = daemon
    channel = new implementation.FilesChannel(remoteService, data => peer.sendData(implementation.FILES_CHANNEL, Buffer.from(data.buffer, data.byteOffset, data.byteLength)), () => {}, error => failures.push(error))
    const receiver = channel
    pumping = (async () => {
      while (!stopped) {
        const event = await peer.nextEvent()
        if (!event || stopped) return
        if (event.kind === "iceCandidate" && event.candidate) {
          candidates.add(event.candidate.candidate)
          const candidate = { kind: "iceCandidate" as const, candidate: event.candidate }
          for (const listener of listeners) listener({ type: "peerEvent", peerId: "benchmark-files", event: candidate })
        } else if (event.kind === "data" && event.label === implementation.FILES_CHANNEL) receiver.receive(event.data!, event.isString)
        else if (event.kind === "error") throw new Error(event.error)
      }
    })().catch(error => { if (!stopped) failures.push(error) })
    const central = {
      async createPeer(_team: string, _machine: string, purpose: string) {
        assert.equal(purpose, "files")
        return { peerId: "benchmark-files", authorization: { expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }, iceServers: [] }
      },
      onEvent(listener: (event: CentralEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      offerPeer: async (_id: string, sdp: string) => ({ sdp: await peer.answerOffer(sdp) }),
      candidatePeer: async (_id: string, candidate: Parameters<typeof peer.addIceCandidate>[0]) => {
        candidates.add(candidate.candidate)
        return peer.addIceCandidate(candidate)
      },
      closePeer,
    } as unknown as CentralApi
    remote = implementation.createNativeFileEndpoint(central, target)
  }
  const local = profileEndpoint(new implementation.FilesService(), "localService")
  manager = new implementation.FileTransferManager({ endpoint: async value => value.kind === "local" ? local : remote, chooseLocalDirectory: async () => null })
  // Both endpoint creation and the ICE/DTLS/DataChannel handshake finish before timing.
  await manager.list({ kind: "local" }, sourceDirectory)
  await manager.list(target, remoteDirectory)
  console.log(JSON.stringify({ event: "ready", label: values.label, implementation: values.implementation ?? "working-tree", sizeMiB, rounds, node: process.versions.node, platform: process.platform, architecture: process.arch, transport: values.transport, addon: loadedAddon ?? values.addon ?? "installed", nativePeers: values.profile ? peerCount : undefined, candidates: values.profile ? [...candidates] : undefined, includes: "enqueue through destination commit; excludes setup and hash", callLatency: values.profile ? "includes FilesService queue wait; totals overlap and are not CPU time" : undefined }))
  for (let round = 1; round <= rounds; round++) {
    const uploaded = join(remoteDirectory, String(round)), downloaded = join(backDirectory, String(round))
    await Promise.all([mkdir(uploaded), mkdir(downloaded)])
    await measure("upload", round, { source: { target: { kind: "local" }, path: source }, destination: { target, path: uploaded }, kind: "file" }, join(uploaded, "payload.bin"), expected)
    await measure("download", round, { source: { target, path: join(uploaded, "payload.bin") }, destination: { target: { kind: "local" }, path: downloaded }, kind: "file" }, join(downloaded, "payload.bin"), expected)
  }
  assert.deepEqual(failures, [])
  const median = (direction: "upload" | "download") => {
    const rates = results.filter(result => result.direction === direction).map(result => result.mibPerSecond).sort((a, b) => a - b)
    const middle = Math.floor(rates.length / 2)
    return rates.length % 2 ? rates[middle]! : (rates[middle - 1]! + rates[middle]!) / 2
  }
  console.log(JSON.stringify({ event: "summary", label: values.label, transport: values.transport, sizeMiB, rounds, uploadMiBPerSecond: median("upload"), downloadMiBPerSecond: median("download") }))
} finally {
  try { await manager?.close() }
  finally {
    try { await closePeer() }
    finally { process.dlopen = originalDlopen; await rm(directory, { recursive: true, force: true }) }
  }
}
