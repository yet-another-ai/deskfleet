import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { channel } from "node:diagnostics_channel"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { DaemonClient } from "./control-client.ts"
import type { ControlRequest, LocalDaemonInfo } from "./control-protocol.ts"

const info: LocalDaemonInfo = {
  name: "Test daemon", desktop: false,
  screenCapturePermission: { status: "not-required" },
  accessibilityPermission: { status: "not-required" },
  fullDiskAccessPermission: { status: "not-required" },
}

async function connectFixture(context: TestContext, respond: (socket: Socket, request: ControlRequest) => void = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "df-client-eof-"))
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\deskfleet-test-${randomUUID()}` : join(directory, "control.sock")
  const sockets = new Set<Socket>()
  let remote!: Socket
  let local!: Socket
  let client: DaemonClient | undefined
  const disconnected: Error[] = []
  const server = createServer({ allowHalfOpen: true }, socket => {
    remote = socket
    sockets.add(socket)
    socket.on("error", () => {})
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)) as ControlRequest
        buffer = buffer.slice(end + 1)
        if (request.method === "hello") socket.write(`${JSON.stringify({ id: request.id, result: info })}\n`)
        else respond(socket, request)
      }
    })
  })
  const connections = channel("net.client.socket")
  const capture = (message: unknown) => { local = (message as { socket: Socket }).socket }
  connections.subscribe(capture)
  context.after(async () => {
    connections.unsubscribe(capture)
    client?.close()
    local?.destroy()
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  server.listen(endpoint)
  await once(server, "listening", { signal: context.signal })
  await writeFile(join(directory, "daemon.json"), JSON.stringify({ endpoint, token: "a".repeat(64) }))
  client = await DaemonClient.connect(() => {}, error => disconnected.push(error), directory)
  connections.unsubscribe(capture)
  return { client, local, remote, disconnected }
}

test("daemon EOF rejects pending requests without waiting for buffered writes or socket close", { timeout: 5_000 }, async context => {
  const { client, local, remote, disconnected } = await connectFixture(context)
  // Hold real socket writes above its high-water mark without depending on the
  // platform's kernel buffer size or a timer to establish backpressure.
  local.cork()
  const failures: Error[] = []
  const pending = ["first", "second"].map(sessionId => client.call("terminalOffer", {
    sessionId, sdp: "x".repeat(192 * 1024),
  }).catch((error: Error) => { failures.push(error); return error }))
  assert.equal(local.writableNeedDrain, true)
  let ended: { closed: boolean; disconnects: number } | undefined
  local.once("end", () => { ended = { closed: client.closed, disconnects: disconnected.length } })
  const eof = once(local, "end", { signal: context.signal })
  const closed = once(local, "close", { signal: context.signal })
  remote.end()
  await eof
  assert.deepEqual(ended, { closed: true, disconnects: 1 })
  await Promise.all(pending)
  await closed
  client.close()
  assert.equal(failures.length, 2)
  assert.ok(failures.every(error => error.message === "The local daemon disconnected"))
  assert.equal(disconnected.length, 1)
  await assert.rejects(client.call("capabilities", {}), /The local daemon disconnected/)
})

test("the final complete response is delivered before EOF rejects other pending requests", { timeout: 5_000 }, async context => {
  const capabilities = { displays: [], audio: false }
  const { client, local, disconnected } = await connectFixture(context, (socket, request) => {
    if (request.method === "capabilities") socket.end(`${JSON.stringify({ id: request.id, result: capabilities })}\n`)
  })
  const closed = once(local, "close", { signal: context.signal })
  const response = client.call("capabilities", {})
  const pending = assert.rejects(client.call("terminalList", {}), /The local daemon disconnected/)
  assert.deepEqual(await response, capabilities)
  await pending
  await closed
  client.close()
  assert.equal(disconnected.length, 1)
})
