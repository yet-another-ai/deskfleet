import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { openInMemoryCatalog } from "@deskfleet/native"
import type { CentralSocket, CentralTransport } from "@deskfleet/client/central-transport"
import { startDaemon } from "./daemon.ts"

class HostSocket extends EventTarget {
  readyState = 0
  readonly sent: unknown[] = []
  send(value: string): void { this.sent.push(JSON.parse(value)) }
  close(): void { this.readyState = 3 }
  open(): void { this.readyState = 1; this.dispatchEvent(new Event("open")) }
}

test("the host transport reaches every Team's enrollment, control link, requests, and final synchronization", { timeout: 10_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-host-transport-"))
  const requests: Request[] = []
  const sockets: Array<{ url: string; socket: HostSocket }> = []
  const identities = new Map<string, { originId: string; machineId: string }>()
  const nodeFetch = context.mock.method(globalThis, "fetch", async () => { throw new Error("Backend requests must use the host transport") })
  context.mock.property(globalThis, "WebSocket", class {
    static OPEN = 1
    constructor() { throw new Error("Backend sockets must use the host transport") }
  } as unknown as typeof WebSocket)
  const centralTransport: CentralTransport = {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      assert.equal(new URL(request.url).origin, "https://proxy-only.invalid")
      const teamId = request.headers.get("authorization")?.replace("Bearer token-", "")
      assert.ok(teamId)
      const identity = identities.get(teamId)
      assert.ok(identity)
      if (new URL(request.url).pathname === "/api/daemon/me") {
        return Response.json({ serverId: "server", machine: { id: "machine", teamId, originId: identity.originId, localMachineId: identity.machineId } })
      }
      if (new URL(request.url).pathname === "/api/daemon/authorize-delegation") return Response.json({ authorized: true })
      return Response.json({})
    },
    socket: url => {
      const socket = new HostSocket()
      sockets.push({ url, socket })
      return socket as unknown as CentralSocket
    },
  }
  const daemon = await startDaemon(0, {
    controlDirectory: directory,
    centralTransport,
    openCatalog: (_path, name) => openInMemoryCatalog(name),
    permissionPlatform: "darwin",
    requestScreenCaptureAccess: async () => null,
    requestAccessibilityAccess: async () => null,
    requestFullDiskAccess: async () => null,
  })
  context.after(async () => { await daemon.close(); await rm(directory, { recursive: true, force: true }) })
  for (const teamId of ["team-one", "team-two"]) {
    const target = { serverUrl: "https://proxy-only.invalid", teamId }
    const prepared = await daemon.registrations.prepareEnrollment(target)
    identities.set(teamId, prepared.identity)
    await daemon.registrations.enroll({ ...target, machineId: "machine", originId: prepared.identity.originId, token: `token-${teamId}` })
    const socket = sockets.at(-1)!
    assert.equal(socket.url, "wss://proxy-only.invalid/api/daemon/ws")
    socket.socket.open()
    assert.deepEqual(socket.socket.sent, [{ type: "authenticate", token: `token-${teamId}` }])
    const central = daemon.registrations.forTeam(target).central
    const actor = { kind: "user" as const, userId: "user", deviceId: "device" }
    assert.deepEqual(await central.authorizeDelegation(actor), actor)
  }
  await daemon.close()
  for (const teamId of identities.keys()) {
    const paths = requests.filter(request => request.headers.get("authorization") === `Bearer token-${teamId}`)
      .map(request => new URL(request.url).pathname)
    assert.deepEqual(paths, ["/api/daemon/me", "/api/daemon/authorize-delegation", "/api/daemon/catalog", "/api/daemon/schedules"])
  }
  assert.equal(sockets.length, 2)
  assert.ok(sockets.every(({ socket }) => socket.readyState === 3))
  assert.equal(nodeFetch.mock.callCount(), 0)
})
