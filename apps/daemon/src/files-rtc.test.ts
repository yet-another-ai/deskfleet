import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createPeer } from "@deskfleet/native"
import type { CentralApi, CentralEvent } from "../../../packages/client/src/central.ts"
import { FileTransferManager } from "../../../packages/client/src/file-transfers.ts"
import type { FileTransfer } from "../../../packages/client/src/files.ts"
import { createNativeFileEndpoint } from "../../desktop/src/main/files-peer.ts"
import { FilesChannel } from "./files-channel.ts"
import { FILES_CHANNEL } from "./files-protocol.ts"
import { FilesService } from "./files-service.ts"

test("native file peers copy folders both ways and read session-relative images over real WebRTC", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-files-rtc-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const localPath = join(directory, "local"), remotePath = join(directory, "remote"), backPath = join(directory, "back")
  await Promise.all([mkdir(join(localPath, "assets", "empty"), { recursive: true }), mkdir(remotePath), mkdir(backPath)])
  const bytes = Buffer.from(Array.from({ length: 100_003 }, (_, index) => index % 251))
  await writeFile(join(localPath, "assets", "image.png"), bytes)
  await writeFile(join(localPath, "assets", "zero.txt"), "")

  const daemon = await createPeer({})
  const service = new FilesService(async sessionId => { assert.equal(sessionId, "session"); return remotePath })
  const listeners = new Set<(event: CentralEvent) => void>()
  const errors: unknown[] = []
  let closed = false
  const channel = new FilesChannel(service, data => daemon.sendData(FILES_CHANNEL, Buffer.from(data)), () => {}, error => errors.push(error))
  const pumping = (async () => {
    while (!closed) {
      const event = await daemon.nextEvent()
      if (!event || closed) return
      if (event.kind === "iceCandidate" && event.candidate) {
        const candidate = { kind: "iceCandidate" as const, candidate: event.candidate }
        for (const listener of listeners) listener({ type: "peerEvent", peerId: "files", event: candidate })
      } else if (event.kind === "data" && event.label === FILES_CHANNEL) channel.receive(event.data!, event.isString)
      else if (event.kind === "error") throw new Error(event.error)
    }
  })().catch(error => { if (!closed) errors.push(error) })
  const central = {
    async createPeer(_team: string, _machine: string, purpose: string) {
      assert.equal(purpose, "files")
      return { peerId: "files", authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [] }
    },
    onEvent(listener: (event: CentralEvent) => void) { listeners.add(listener); return () => listeners.delete(listener) },
    offerPeer: async (_id: string, sdp: string) => ({ sdp: await daemon.answerOffer(sdp) }),
    candidatePeer: async (_id: string, candidate: Parameters<typeof daemon.addIceCandidate>[0]) => daemon.addIceCandidate(candidate),
    async closePeer() { closed = true; await Promise.all([channel.close(), daemon.close()]); await pumping },
  } as unknown as CentralApi
  const target = { kind: "machine", teamId: "1", machineId: "2" } as const
  const remote = createNativeFileEndpoint(central, target)
  const local = new FilesService()
  const manager = new FileTransferManager({ endpoint: async value => value.kind === "local" ? local : remote, chooseLocalDirectory: async () => null })
  t.after(async () => { await manager.close(); await central.closePeer("files") })

  async function complete(id: string): Promise<FileTransfer> {
    return new Promise((resolve, reject) => {
      const unsubscribe = manager.onChanged(jobs => {
        const job = jobs.find(value => value.id === id)
        if (!job || ["queued", "preparing", "transferring"].includes(job.state)) return
        unsubscribe()
        if (job.state === "completed") resolve(job)
        else reject(new Error(`Transfer ${job.state}: ${job.error}`))
      })
    })
  }
  const upload = await manager.enqueue({ source: { target: { kind: "local" }, path: join(localPath, "assets") }, destination: { target, path: remotePath }, kind: "directory" })
  assert.equal((await complete(upload)).totalBytes, bytes.length)
  assert.deepEqual(await readFile(join(remotePath, "assets", "image.png")), bytes)
  assert.deepEqual(await readdir(join(remotePath, "assets", "empty")), [])
  const preview = await manager.readResource({ target, sessionId: "session", uri: "assets/image.png" })
  assert.equal(preview.mimeType, "image/png")
  assert.deepEqual(Buffer.from(preview.data), bytes)
  const download = await manager.enqueue({ source: { target, path: join(remotePath, "assets") }, destination: { target: { kind: "local" }, path: backPath }, kind: "directory" })
  assert.equal((await complete(download)).transferredBytes, bytes.length)
  assert.deepEqual(await readFile(join(backPath, "assets", "image.png")), bytes)
  assert.deepEqual(await readdir(join(backPath, "assets", "empty")), [])
  assert.equal(await readFile(join(backPath, "assets", "zero.txt"), "utf8"), "")
  assert.equal((await manager.transfers()).length, 2)
  assert.deepEqual(errors, [])
})
