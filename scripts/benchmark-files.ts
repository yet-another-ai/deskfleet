import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { createPeer } from "../crates/node/index.ts"
import { createNativeFileEndpoint } from "../apps/desktop/src/main/files-peer.ts"
import { FilesChannel } from "../apps/daemon/src/files-channel.ts"
import { FILES_CHANNEL } from "../apps/daemon/src/files-protocol.ts"
import { FilesService } from "../apps/daemon/src/files-service.ts"
import type { CentralApi, CentralEvent } from "../packages/client/src/central.ts"
import { FileTransferManager } from "../packages/client/src/file-transfers.ts"
import type { FileTransfer, FileTransferRequest } from "../packages/client/src/files.ts"

const { values } = parseArgs({ options: {
  "size-mib": { type: "string", default: "32" }, rounds: { type: "string", default: "3" },
  implementation: { type: "string" }, label: { type: "string", default: "working-tree" },
  help: { type: "boolean", default: false },
} })
if (values.help) {
  console.log("Usage: mise exec -- node scripts/benchmark-files.ts [--size-mib 32] [--rounds 3] [--label name] [--implementation /absolute/snapshot.mjs]\nMeasures native WebRTC uploads/downloads on this machine after connecting, then verifies SHA-256. File generation, connection setup, and hashing are excluded. JSON lines contain each result and the medians; no throughput threshold is asserted.")
  process.exit(0)
}
const sizeMiB = Number(values["size-mib"]), rounds = Number(values.rounds)
assert.ok(Number.isSafeInteger(sizeMiB) && sizeMiB >= 1 && sizeMiB <= 1024, "--size-mib must be an integer from 1 to 1024")
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 20, "--rounds must be an integer from 1 to 20")

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
  const started = performance.now()
  const result = await complete(await manager!.enqueue(request))
  const seconds = (performance.now() - started) / 1000
  assert.equal(result.transferredBytes, bytes)
  assert.equal(result.totalBytes, bytes)
  assert.equal(await hash(destination), expected, "Transferred file SHA-256 differs")
  const measurement = { direction, round, seconds, mibPerSecond: sizeMiB / seconds, mbPerSecond: bytes / 1_000_000 / seconds }
  results.push(measurement)
  console.log(JSON.stringify({ event: "result", label: values.label, sizeMiB, ...measurement, sha256: expected }))
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

  daemon = await implementation.createPeer({})
  const peer = daemon
  channel = new implementation.FilesChannel(new implementation.FilesService(), data => peer.sendData(implementation.FILES_CHANNEL, Buffer.from(data)), () => {}, error => failures.push(error))
  const receiver = channel
  pumping = (async () => {
    while (!stopped) {
      const event = await peer.nextEvent()
      if (!event || stopped) return
      if (event.kind === "iceCandidate" && event.candidate) {
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
    candidatePeer: async (_id: string, candidate: Parameters<typeof peer.addIceCandidate>[0]) => peer.addIceCandidate(candidate),
    closePeer,
  } as unknown as CentralApi
  const target = { kind: "machine", teamId: "benchmark", machineId: "loopback" } as const
  const remote = implementation.createNativeFileEndpoint(central, target)
  const local = new implementation.FilesService()
  manager = new implementation.FileTransferManager({ endpoint: async value => value.kind === "local" ? local : remote, chooseLocalDirectory: async () => null })
  // Both endpoint creation and the ICE/DTLS/DataChannel handshake finish before timing.
  await manager.list({ kind: "local" }, sourceDirectory)
  await manager.list(target, remoteDirectory)
  console.log(JSON.stringify({ event: "ready", label: values.label, implementation: values.implementation ?? "working-tree", sizeMiB, rounds, node: process.versions.node, platform: process.platform, architecture: process.arch, transport: "native WebRTC loopback", includes: "enqueue through destination commit; excludes setup and hash" }))
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
  console.log(JSON.stringify({ event: "summary", label: values.label, sizeMiB, rounds, uploadMiBPerSecond: median("upload"), downloadMiBPerSecond: median("download") }))
} finally {
  try { await manager?.close() }
  finally {
    try { await closePeer() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}
