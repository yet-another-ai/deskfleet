import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net"
import { HttpCentralClient } from "../../packages/client/src/http-central.ts"
import { connectPortPeer } from "../../packages/client/src/ports-signaling.ts"
import { PortForwards } from "../../apps/desktop/src/main/ports-controller.ts"
import { createNativePortPeer } from "../../apps/desktop/src/main/ports-peer.ts"
import type { FixtureLogin } from "./backend-oidc.ts"
import { until } from "./backend-peer.ts"

/** Exercise the Desktop API against the real backend, daemon, TCP sockets and RTC. */
export async function smokePortForwarding(backend: string, login: FixtureLogin, teamId: string, machineId: string): Promise<void> {
  const central = new HttpCentralClient({
    account: { serverUrl: backend, token: login.token, user: login.user },
    persist: async () => {}, authorize: async () => { throw new Error("Smoke login is already authenticated") },
  })
  let signalingReady = false, lastPeerId = ""
  const unsubscribe = central.onEvent(event => { if (event.type === "connection") signalingReady = event.connected })
  const createPeer = central.createPeer.bind(central)
  central.createPeer = async (...args) => {
    const grant = await createPeer(...args)
    assert.equal(grant.authorization.purpose, "ports")
    assert.deepEqual(grant.authorization.actions, ["ports:forward"])
    lastPeerId = grant.peerId
    return grant
  }
  const relayOnly = process.env.DESKFLEET_SMOKE_RELAY_ONLY === "1"
  const candidates: string[] = []
  const forwards = new PortForwards(central, (request, failed, signal) => {
    const factory = createNativePortPeer(request, signal, { relayOnly })
    return connectPortPeer(central, request.target, (servers, events) => factory(servers, {
      ...events, candidate(value) { candidates.push(value.candidate); events.candidate(value) },
    }), failed, signal)
  })
  const sockets = new Set<Socket>()
  const greeting = Buffer.from([0, 255, 1, 128, 13, 10])
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    socket.write(greeting)
    const hash = createHash("sha256")
    socket.on("data", chunk => hash.update(chunk))
    // The response is sent only after the client's FIN, exercising half-close.
    socket.on("end", () => socket.end(hash.digest()))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const targetPort = (server.address() as AddressInfo).port
  async function exchange(localPort: number, payload: Buffer): Promise<void> {
    const socket = createConnection({ host: "127.0.0.1", port: localPort })
    socket.setTimeout(20_000, () => socket.destroy(new Error("Forwarded TCP response timed out")))
    try {
      await once(socket, "connect")
      socket.end(payload)
      const received: Buffer[] = []
      for await (const chunk of socket) received.push(Buffer.from(chunk))
      assert.deepEqual(Buffer.concat(received), Buffer.concat([greeting, createHash("sha256").update(payload).digest()]))
    } finally { socket.destroy() }
  }
  let live: Socket | undefined
  try {
    await until(() => signalingReady, Boolean, "port forwarding signaling authentication")
    const request = { target: { teamId, machineId }, targetPort }
    const first = await forwards.start(request)
    assert.equal(first.localHost, "127.0.0.1")
    assert.ok(first.localPort > 0)
    const payload = Buffer.from(Array.from({ length: 2 * 1024 * 1024 + 19 }, (_, index) => index % 251))
    await Promise.all(Array.from({ length: 4 }, () => exchange(first.localPort, payload)))
    assert.equal((await forwards.list()).length, 1)
    await forwards.stop(first.id)
    assert.deepEqual(await forwards.list(), [])
    await assert.rejects(exchange(first.localPort, payload), /ECONNREFUSED|ECONNRESET/u)

    const second = await forwards.start(request)
    live = createConnection({ host: "127.0.0.1", port: second.localPort })
    live.on("error", () => {})
    await once(live, "data")
    let closed = false
    live.once("close", () => { closed = true })
    // Revoke from the server while the local API and target service stay alive.
    await central.closePeer(lastPeerId)
    await until(() => forwards.list(), entries => entries.length === 0, "revoked forwarding removed from Desktop")
    await until(() => closed && sockets.size === 0, Boolean, "revocation closes both sides of the TCP bridge")
    assert.equal(server.listening, true, "Stopping forwarding does not stop the target service")
    if (relayOnly) {
      assert.ok(candidates.some(candidate => / typ relay(?: |$)/u.test(candidate)), "Port peer must gather a TURN candidate")
      assert.ok(candidates.every(candidate => !/ typ (?:host|srflx)(?: |$)/u.test(candidate)), "Relay-only port peer must not use direct candidates")
    }
    console.log(`TCP forwarding ${relayOnly ? "over TURN" : "over WebRTC"}: concurrent binary streams, half-close, stop and revocation passed`)
  } finally {
    live?.destroy()
    await forwards.close()
    unsubscribe(); central.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}
