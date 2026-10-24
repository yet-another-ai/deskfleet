import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { startDaemon } from "./daemon.ts"
import { DaemonClient } from "./control-client.ts"
import { CentralClient } from "./central-client.ts"
import type { MachineOperations } from "./machine-operations.ts"
import type { ControlPeers } from "./control-server.ts"
import { centralUrl } from "./central-protocol.ts"

test("local discovery grants only host setup and never imports development resources", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-central-auth-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const development = await startDaemon(0, { controlDirectory: directory, allowLocalControlForTests: true, requestScreenCaptureAccess: async () => null })
  const old = await DaemonClient.connect(() => {}, () => {}, directory)
  await old.call("workspaceCreate", { name: "Development data", directories: [{ path: directory }] })
  old.close(); await development.close()
  const daemon = await startDaemon(0, { controlDirectory: directory, requestScreenCaptureAccess: async () => null })
  context.after(() => daemon.close())
  const client = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => client.close())
  const status = await client.call("centralStatus", {})
  assert.equal(status.configured, false)
  assert.equal(status.connected, false)
  for (const method of ["catalogList", "providerList", "terminalList"] as const) await assert.rejects(client.call(method, {}), /Sign in and select a team/)
  await assert.rejects(client.call("workspaceCreate", { name: "Unauthorized", directories: [{ path: directory }] }), /backend API/)
})

test("enrollment verifies local machine identity and saves only a private daemon credential", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-enroll-"))
  const daemon = await startDaemon(0, { controlDirectory: directory, requestScreenCaptureAccess: async () => null })
  context.after(async () => { await daemon.close(); await rm(directory, { recursive: true, force: true }) })
  const identity = daemon.central.status().identity
  let originId = "wrong"
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer machine-secret")
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ serverId: "server", machine: { id: "machine", teamId: "team", originId, localMachineId: identity.machineId } }))
  })
  server.on("upgrade", (_request, socket) => socket.destroy())
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  context.after(() => server.close())
  const credentials = { serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, machineId: "machine", teamId: "team", token: "machine-secret" }
  await assert.rejects(daemon.central.enroll(credentials), /do not match/)
  originId = identity.originId
  const status = await daemon.central.enroll(credentials)
  assert.equal(status.configured, true)
  assert.equal("token" in status, false)
  const path = join(directory, "machine", "central.json")
  assert.equal(JSON.parse(await readFile(path, "utf8")).token, "machine-secret")
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600)
  await assert.rejects(daemon.central.enroll(credentials), /already belongs/)
})

test("remote enrollment requires TLS and accepts HTTP only on loopback", () => {
  assert.equal(centralUrl("http://localhost:8080"), "http://localhost:8080")
  assert.throws(() => centralUrl("http://backend.example"), /HTTPS/)
  assert.throws(() => centralUrl("https://user:secret@backend.example"), /origin URL/)
})


test("final synchronization has a shared deadline when the backend stops responding", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-final-sync-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  let posts = 0
  const server = createServer(() => { posts++ /* Accept the request without answering. */ })
  server.on("upgrade", (_request, socket) => socket.destroy())
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  context.after(() => { server.closeAllConnections(); server.close() })
  await writeFile(join(directory, "central.json"), JSON.stringify({
    serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    serverId: "server", teamId: "team", machineId: "machine", token: "secret",
  }))
  const unsubscribe = () => () => {}
  const operations = {
    agents: { journal: { identity: { originId: "origin", machineId: "local" }, list: async () => [] }, onEvent: unsubscribe },
    catalog: { native: { snapshot: async () => ({}) }, onChange: unsubscribe },
    providers: { metadata: () => ({}), onChanged: unsubscribe },
    terminals: { onChange: unsubscribe },
  } as unknown as MachineOperations
  const central = new CentralClient(directory, operations, {} as ControlPeers, 100)
  await central.init()
  const started = Date.now()
  const closing = central.close()
  assert.equal(central.close(), closing)
  await closing
  assert.equal(posts, 1)
  assert.ok(Date.now() - started < 2_000, "Shutdown must not wait for the normal 30-second sync timeout")
})
