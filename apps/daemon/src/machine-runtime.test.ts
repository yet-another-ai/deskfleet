import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { openInMemoryCatalog } from "@deskfleet/native"
import { BackendAgent } from "../../../scripts/fixtures/backend-agent.ts"
import { until } from "../../../scripts/fixtures/backend-peer.ts"
import type { AgentSnapshot } from "./agent-protocol.ts"
import type { EnrollmentTarget } from "./central-protocol.ts"
import { DaemonClient } from "./control-client.ts"
import { readDaemonDiscovery } from "./control-discovery.ts"
import { startDaemon } from "./daemon.ts"
import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"
import { MachineRuntime } from "./machine-runtime.ts"

const serverUrl = "http://127.0.0.1:8080"
const targetA = { serverUrl, teamId: "team-a" }
const targetB = { serverUrl, teamId: "team-b" }
const credentials = { ...targetA, serverId: "server", machineId: "machine", token: "original-host-token", revoked: true }
const options = {
  agentQuotas: new TestAgentQuotas(),
  peers: { create: async () => { throw new Error("Unexpected native peer creation") }, close: async () => { throw new Error("No native peer may be closed") } },
  capabilities: async () => ({ displays: [], audio: false }),
}

async function seed(directory: string, path = "machine"): Promise<void> {
  await mkdir(join(directory, path), { recursive: true })
  await writeFile(join(directory, path, "central.json"), JSON.stringify(credentials))
  if (path !== "machine") await writeFile(join(directory, "active-machine.json"), JSON.stringify({ directory: path }))
}

function backend(context: TestContext) {
  const registrations = new Map<string, { teamId: string; originId: string; localMachineId: string }>()
  const uploads: { token: string; path: string; body: Record<string, unknown> }[] = []
  const sockets: Socket[] = []
  class Socket extends EventTarget {
    static OPEN = 1
    readyState = Socket.OPEN
    token?: string
    constructor() { super(); sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))) }
    send(data: string): void {
      const message = JSON.parse(data) as { type: string; token?: string }
      if (message.type === "authenticate") {
        this.token = message.token!
        const registration = registrations.get(this.token)!
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ready", serverId: "server", machineId: "machine", teamId: registration.teamId }) })))
      }
    }
    close(code = 1000): void { this.readyState = 3; this.dispatchEvent(new CloseEvent("close", { code })) }
  }
  context.mock.property(globalThis, "WebSocket", Socket as unknown as typeof WebSocket)
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    const token = request.headers.get("authorization")!.slice(7)
    const path = new URL(request.url).pathname
    const registration = registrations.get(token)
    if (!registration) return Response.json({ error: { code: "machine_credential_rejected" } }, { status: 401 })
    if (path === "/api/daemon/me") return Response.json({ serverId: "server", machine: { id: "machine", ...registration } })
    const body = request.body ? await request.json() as Record<string, unknown> : {}
    uploads.push({ token, path, body })
    const snapshot = body.snapshot as AgentSnapshot | undefined
    return Response.json({ lastEventSeq: snapshot?.session?.lastEventSeq ?? body.snapshotSeq ?? "0" })
  })
  return { registrations, uploads, sockets }
}

test("Team registrations run concurrently with separate catalogs, preserve same local IDs, and recover after restart", { timeout: 120_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-team-runtimes-"))
  const provider = new BackendAgent()
  const api = backend(context)
  let runtime = new MachineRuntime(directory, { ...options, agentProvider: provider })
  context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  await runtime.init()
  const prepareA = runtime.prepareEnrollment(targetA)
  assert.equal(runtime.prepareEnrollment(targetA), prepareA)
  const [preparedA, preparedB] = await Promise.all([prepareA, runtime.prepareEnrollment(targetB)])
  assert.notEqual(preparedA.identity.originId, preparedB.identity.originId)
  assert.equal(preparedA.identityToken, preparedB.identityToken)
  assert.equal(preparedA.identityToken.length, 64)
  for (const [target, prepared, token] of [[targetA, preparedA, "token-a"], [targetB, preparedB, "token-b"]] as const) {
    api.registrations.set(token, { teamId: target.teamId, originId: prepared.identity.originId, localMachineId: prepared.identity.machineId })
    await runtime.enroll({ ...target, machineId: "machine", token, originId: prepared.identity.originId })
  }
  const a = runtime.forTeam(targetA), b = runtime.forTeam(targetB)
  assert.equal(runtime.forLocalChannel("team-a", "machine"), a.central)
  assert.equal(runtime.forLocalChannel("team-b", "machine"), b.central)
  assert.throws(() => runtime.forLocalChannel("team-c", "machine"), /not found/)
  const session = async (target: EnrollmentTarget, text: string) => {
    const machine = runtime.forTeam(target)
    const configured = await machine.providers.create({ template: "codex", name: text, env: { TEAM: text } })
    const workspace = await machine.catalog.native.createWorkspace(text, [{ path: directory }])
    const created = await machine.agents.handle("_deskfleet/session/create", {
      workspaceId: workspace.id, provider: configured.id, operationId: randomUUID(), context: "directory",
    }, machine.agents.actor()) as AgentSnapshot
    await machine.agents.handle("_deskfleet/input/submit", {
      sessionId: created.session.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text }],
    }, machine.agents.actor())
    await until(() => machine.agents.journal.read(created.session.id), value => value.permissions.some(permission => permission.state === "pending"), "running Team Session")
    return created.session.id
  }
  const [idA, idB] = await Promise.all([session(targetA, "Only Team A"), session(targetB, "Only Team B")])
  assert.equal(idA, idB, "Local IDs can repeat in distinct catalogs")
  const snapshotA = await a.agents.journal.read(idA), snapshotB = await b.agents.journal.read(idB)
  assert.match(JSON.stringify(snapshotA), /Only Team A/)
  assert.doesNotMatch(JSON.stringify(snapshotA), /Only Team B/)
  assert.match(JSON.stringify(snapshotB), /Only Team B/)
  assert.doesNotMatch(JSON.stringify(snapshotB), /Only Team A/)
  const before = a.agents.journal.identity
  const again = await runtime.prepareEnrollment(targetA)
  assert.deepEqual(again.identity, before)
  assert.equal(again.configured, true)
  assert.equal(provider.closes, 0, "Adding or preparing a Team does not stop accepted work")
  assert.equal("identityToken" in runtime.status(), false)
  assert.doesNotMatch(JSON.stringify(runtime.status()), /token-a|token-b|identityToken/)
  await assert.rejects(runtime.enroll({ ...targetB, machineId: "different-machine", token: "token-b", originId: preparedB.identity.originId }), /retain this host/)
  await assert.rejects(runtime.enroll({ ...targetB, machineId: "machine", token: "token-b", originId: preparedA.identity.originId }), /another catalog/)
  await until(async () => api.uploads, values => values.some(value => value.token === "token-a" && value.path.endsWith("/history")) && values.some(value => value.token === "token-b" && value.path.endsWith("/history")), "separate Team synchronization")
  for (const upload of api.uploads) assert.doesNotMatch(JSON.stringify(upload.body), upload.token === "token-a" ? /Only Team B/ : /Only Team A/)

  api.sockets.find(socket => socket.token === "token-a")!.close(4403)
  await until(async () => a.central.status(), value => value.revoked, "Team A revoked")
  assert.equal(b.central.status().connected, true)
  assert.equal(provider.closes, 0, "Revocation does not stop either Team's accepted Session")
  const rePrepared = await runtime.prepareEnrollment(targetA)
  assert.equal(rePrepared.revoked, true)
  assert.deepEqual(rePrepared.identity, before)
  api.registrations.set("token-a-new", api.registrations.get("token-a")!)
  const renewed = { ...targetA, machineId: "machine", token: "token-a-new", originId: before.originId }
  await runtime.enroll(renewed)
  assert.equal(a.central.status().revoked, false)
  assert.deepEqual(await runtime.enroll(renewed), a.central.status(), "Repeated credential delivery is idempotent")
  assert.equal(provider.closes, 0)
  const paths = [a.directory, b.directory]
  await runtime.close()
  runtime = new MachineRuntime(directory, { ...options, agentProvider: provider })
  await runtime.init()
  assert.deepEqual([runtime.forTeam(targetA).directory, runtime.forTeam(targetB).directory], paths)
  assert.deepEqual(runtime.forTeam(targetA).agents.journal.identity, before)
  assert.equal((await runtime.prepareEnrollment(targetB)).identityToken, preparedA.identityToken)
  assert.match(JSON.stringify(await runtime.forTeam(targetA).agents.journal.read(idA)), /Only Team A/)
  assert.match(JSON.stringify(await runtime.forTeam(targetB).agents.journal.read(idB)), /Only Team B/)
  assert.equal(runtime.status().registrations.length, 2)
})

test("legacy registration keeps its identity, catalog, paths, and host token when another Team joins", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-team-migration-"))
  const legacyDirectory = `machines/${randomUUID()}`
  await seed(directory, legacyDirectory)
  let runtime = new MachineRuntime(directory, options)
  context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  await runtime.init()
  const original = runtime.forTeam(targetA), identity = original.agents.journal.identity
  const workspace = await original.catalog.native.createWorkspace("Retained workspace", [{ path: directory }])
  const prepared = await runtime.prepareEnrollment(targetA)
  assert.equal(prepared.identityToken, credentials.token)
  assert.equal(prepared.revoked, true)
  assert.deepEqual(prepared.identity, identity)
  await runtime.prepareEnrollment(targetB)
  assert.equal(runtime.forTeam(targetA), original)
  assert.equal(original.directory, join(directory, legacyDirectory))
  await runtime.close()
  await writeFile(join(directory, "active-machine.json"), "obsolete pointer after migration")
  runtime = new MachineRuntime(directory, options)
  await runtime.init()
  assert.deepEqual(runtime.forTeam(targetA).agents.journal.identity, identity)
  assert.equal((await runtime.forTeam(targetA).catalog.native.snapshot()).workspaces[0]?.id, workspace.id)
  assert.equal((await runtime.prepareEnrollment(targetB)).identityToken, credentials.token)
})

test("pending registrations survive restart and a failed additional registration leaves existing work available", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-team-pending-"))
  let runtime = new MachineRuntime(directory, options)
  context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  await runtime.init()
  const prepared = await runtime.prepareEnrollment(targetA)
  const a = runtime.forTeam(targetA)
  const blocker = join(directory, "machine-registrations.json.tmp")
  await mkdir(blocker)
  await assert.rejects(runtime.prepareEnrollment(targetB))
  assert.equal(runtime.forTeam(targetA), a)
  assert.equal(runtime.status().registrations.length, 1)
  await rm(blocker, { recursive: true })
  await runtime.prepareEnrollment(targetB)
  await runtime.close()
  runtime = new MachineRuntime(directory, options)
  await runtime.init()
  assert.deepEqual(await runtime.prepareEnrollment(targetA), prepared)
  assert.equal(runtime.status().registrations.length, 2)
})

test("host IPC keeps both Team registrations available and exposes secrets only through prepare", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-team-ipc-"))
  const daemon = await startDaemon(0, {
    controlDirectory: directory, openCatalog: (_path, name) => openInMemoryCatalog(name),
    permissionPlatform: "darwin", requestScreenCaptureAccess: async () => null,
    requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null,
  })
  const first = await DaemonClient.connect(() => {}, () => {}, directory)
  const second = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(async () => { first.close(); second.close(); await daemon.close(); await rm(directory, { recursive: true, force: true }) })
  const discovery = await readDaemonDiscovery(directory)
  assert.deepEqual((await first.call("centralStatus", {})).registrations, [])
  const [a, aAgain, b] = await Promise.all([
    first.call("centralPrepareEnrollment", targetA), second.call("centralPrepareEnrollment", targetA), second.call("centralPrepareEnrollment", targetB),
  ])
  assert.deepEqual(a, aAgain)
  assert.equal(a.identityToken, b.identityToken)
  assert.notEqual(a.identity.originId, b.identity.originId)
  const status = await first.call("centralStatus", {})
  assert.equal(status.registrations.length, 2)
  assert.equal(status.registrations[0]!.teamId, targetA.teamId)
  assert.doesNotMatch(JSON.stringify(status), /identityToken|token/)
  assert.deepEqual(await readDaemonDiscovery(directory), discovery)
  assert.equal(first.closed, false)
  const identityFile = JSON.parse(await readFile(join(directory, "machine-identity.json"), "utf8"))
  assert.equal(identityFile.identityToken, a.identityToken)
})
