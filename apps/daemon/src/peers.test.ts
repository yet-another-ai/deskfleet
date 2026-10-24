import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPeer, type NativePeer, type PeerEvent } from "@deskfleet/native"
import { startDaemon } from "./daemon.ts"
import { PeerSessions } from "./peers.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test("native peers exchange binary and text DataChannel messages through the daemon", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "df-peers-test-"))
  const daemon = await startDaemon(0, { controlDirectory: directory, requestScreenCaptureAccess: async () => null })
  const left = await daemon.peers.create("left")
  const right = await daemon.peers.create("right")
  const opened = [deferred<void>(), deferred<void>()]
  const binary = deferred<Buffer>()
  const text = deferred<string>()
  const errors: unknown[] = []
  const pumps: Promise<void>[] = []
  async function consume(source: NativePeer, target: NativePeer, side: number) {
    for (;;) {
      const event: PeerEvent | null = await source.nextEvent()
      if (!event) return
      if (event.kind === "iceCandidate") await target.addIceCandidate(event.candidate!)
      if (event.kind === "dataChannelOpen") opened[side]!.resolve()
      if (event.kind === "data" && side === 1) binary.resolve(event.data!)
      if (event.kind === "data" && side === 0) {
        assert.equal(event.isString, true)
        text.resolve(event.data!.toString("utf8"))
      }
      if (event.kind === "error") throw new Error(event.error!)
    }
  }
  try {
    await left.createDataChannel("operations")
    const offer = await left.createOffer()
    const answer = await right.answerOffer(offer)
    await left.acceptAnswer(answer)
    for (const [source, target, side] of [[left, right, 0], [right, left, 1]] as const) {
      pumps.push(consume(source, target, side).catch(error => {
        errors.push(error)
        for (const ready of opened) ready.reject(error)
      }))
    }
    await Promise.all(opened.map(ready => ready.promise))
    const payload = Buffer.from([0, 1, 127, 128, 255])
    await left.sendData("operations", payload)
    assert.deepEqual(await binary.promise, payload)
    await right.sendText("operations", "deskfleet: 你好")
    assert.equal(await text.promise, "deskfleet: 你好")
    assert.deepEqual(errors, [])
  } finally {
    await daemon.close()
    await Promise.all(pumps)
    await rm(directory, { recursive: true, force: true })
  }
  await assert.rejects(left.sendText("operations", "closed"), /closed/)
  await assert.rejects(daemon.peers.create("after shutdown"), /closed/)
})

test("peer ownership rejects duplicate IDs and closes peers created during shutdown", async () => {
  const sessions = new PeerSessions()
  const creating = sessions.create("pending")
  await assert.rejects(sessions.create("pending"), /already exists/)
  await sessions.closeAll()
  const peer = await creating
  await assert.rejects(peer.createOffer(), /closed/)
  await sessions.closeAll()
})

test("desktop settings reject invalid input without initializing capture", async () => {
  const peer = await createPeer({ video: "h264" })
  try {
    await assert.rejects(peer.startDesktop({ displayId: 0, fps: 0 }), /fps/)
    await assert.rejects(peer.startDesktop({ displayId: 0, bitrateBps: 0 }), /bitrate/)
  } finally {
    await peer.close()
  }
})
