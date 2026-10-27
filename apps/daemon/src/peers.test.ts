import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPeer, openInMemoryCatalog, type NativePeer, type PeerEvent } from "@deskfleet/native"
import { startDaemon } from "./daemon.ts"
import { PeerSessions } from "./peers.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test("native peers exchange binary and text DataChannel messages through the daemon", { timeout: 20_000 }, async context => {
  const opened = [deferred<void>(), deferred<void>()]
  const binary = deferred<Buffer>()
  const text = deferred<string>()
  const failed = deferred<never>()
  // Failure can arrive between waits. Keep the shared rejection handled until
  // the next wait races it; the payload/opened promises only ever resolve.
  void failed.promise.catch(() => {})
  const errors: unknown[] = []
  const pumps: Promise<void>[] = []
  const states = ["new", "new"]
  const events: Record<string, number>[] = [{}, {}]
  let stage = "creating test directory"
  let closing = false
  let bodyFailed = false
  let starting: ReturnType<typeof startDaemon> | undefined
  const directory = mkdtemp(join(tmpdir(), "df-peers-test-"))

  const aborted = () => {
    context.diagnostic(JSON.stringify({ stage, states, events }))
    failed.reject(context.signal.reason ?? new Error("peer test aborted"))
  }
  context.signal.addEventListener("abort", aborted, { once: true })
  function waitFor<T>(nextStage: string, operation: Promise<T>): Promise<T> {
    stage = nextStage
    return Promise.race([operation, failed.promise])
  }
  async function consume(source: NativePeer, target: NativePeer, side: number) {
    for (;;) {
      const event: PeerEvent | null = await source.nextEvent()
      if (!event) {
        if (closing) return
        throw new Error(`peer ${side} event stream ended during ${stage}`)
      }
      const counts = events[side]!
      counts[event.kind] = (counts[event.kind] ?? 0) + 1
      if (event.kind === "stateChanged") {
        states[side] = event.state!
        if (!closing && (event.state === "failed" || event.state === "closed")) {
          throw new Error(`peer ${side} became ${event.state} during ${stage}`)
        }
      }
      if (!closing && event.kind === "dataChannelClosed") throw new Error(`peer ${side} data channel closed during ${stage}`)
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
    const controlDirectory = await waitFor("creating test directory", directory)
    starting = startDaemon(0, { controlDirectory, openCatalog: (_path, name) => openInMemoryCatalog(name), permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
    const daemon = await waitFor("starting daemon", starting)
    const left = await waitFor("creating left peer", daemon.peers.create("left"))
    const right = await waitFor("creating right peer", daemon.peers.create("right"))
    await waitFor("creating data channel", left.createDataChannel("operations"))
    const offer = await waitFor("creating offer", left.createOffer())
    const answer = await waitFor("answering offer", right.answerOffer(offer))
    await waitFor("accepting answer", left.acceptAnswer(answer))
    for (const [source, target, side] of [[left, right, 0], [right, left, 1]] as const) {
      pumps.push(consume(source, target, side).catch(error => {
        if (!closing) {
          errors.push(error)
          failed.reject(error)
        }
      }))
    }
    await waitFor("waiting for both data channels to open", Promise.all(opened.map(ready => ready.promise)))
    // A sliced Buffer may be reused as soon as sendData returns its Promise.
    const storage = Buffer.from([42, 0, 1, 127, 128, 255, 43])
    const payload = storage.subarray(1, -1)
    const expected = Buffer.from(payload)
    const sending = left.sendData("operations", payload)
    payload.fill(0xa5)
    await waitFor("sending binary", sending)
    const received = await waitFor("receiving binary", binary.promise)
    assert.deepEqual(received, expected)
    received.fill(0x5a)
    assert.deepEqual(payload, Buffer.alloc(expected.length, 0xa5))
    await waitFor("sending text", right.sendText("operations", "deskfleet: 你好"))
    assert.equal(await waitFor("receiving text", text.promise), "deskfleet: 你好")
    assert.deepEqual(errors, [])

    closing = true
    await waitFor("closing daemon", daemon.close())
    await waitFor("draining peer event streams", Promise.all(pumps))
    global.gc?.()
    assert.deepEqual(received, Buffer.alloc(expected.length, 0x5a))
    await assert.rejects(left.sendText("operations", "closed"), /closed/)
    await assert.rejects(daemon.peers.create("after shutdown"), /closed/)
  } catch (error) {
    bodyFailed = true
    throw error
  } finally {
    closing = true
    try {
      const failures: unknown[] = []
      for (const [name, cleanup] of [
        ["closing daemon", async () => {
          // Startup may finish after abort; close that late daemon too.
          const daemon = await starting?.catch(() => undefined)
          await daemon?.close()
        }],
        ["draining peer event streams", async () => { await Promise.all(pumps) }],
        ["removing test directory", async () => {
          const path = await directory.catch(() => undefined)
          if (path) await rm(path, { recursive: true, force: true })
        }],
      ] as const) {
        stage = `cleanup: ${name}`
        try { await cleanup() } catch (error) { failures.push(error) }
      }
      if (failures.length) {
        if (!bodyFailed) throw new AggregateError(failures, "Peer test cleanup failed")
        context.diagnostic(`Peer test cleanup failed: ${failures.map(String).join("; ")}`)
      }
    } finally {
      context.signal.removeEventListener("abort", aborted)
    }
  }
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
    await assert.rejects(peer.sendDesktopInput('{"type":"releaseAll"}'), /control is not enabled/)
  } finally {
    await peer.close()
  }
})
