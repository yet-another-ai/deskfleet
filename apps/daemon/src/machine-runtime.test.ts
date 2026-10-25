import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { openCatalog } from "@deskfleet/native"
import { BackendAgent } from "../../../scripts/fixtures/backend-agent.ts"
import { until } from "../../../scripts/fixtures/backend-peer.ts"
import type { AgentSnapshot } from "./agent-protocol.ts"
import { AgentProviders } from "./agent-providers.ts"
import { DaemonClient } from "./control-client.ts"
import { readDaemonDiscovery } from "./control-discovery.ts"
import { startDaemon } from "./daemon.ts"
import { activeMachineDirectory } from "./machine-directory.ts"
import { MachineRuntime } from "./machine-runtime.ts"

const execute = promisify(execFile)
const credentials = { serverUrl: "http://127.0.0.1:9", serverId: "server", teamId: "team", machineId: "machine", token: "retired-token", revoked: true }
const options = {
  peers: { create: async () => { throw new Error("Unexpected peer creation") }, close: async () => {} },
  capabilities: async () => ({ displays: [], audio: false }),
}
async function seed(directory: string, revoked = true): Promise<void> {
  await mkdir(join(directory, "machine"), { recursive: true })
  await writeFile(join(directory, "machine", "central.json"), JSON.stringify({ ...credentials, revoked }))
}

test("explicit registration reset stops resources and preserves their original paths and durable records", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-machine-reset-"))
  const provider = new BackendAgent()
  let runtime = new MachineRuntime(directory, { ...options, agentProvider: provider })
  let release = () => {}
  context.after(async () => { release(); await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  await seed(directory)
  await runtime.init()
  const previous = runtime.current
  const originalIdentity = previous.central.status().identity
  const repository = join(directory, "repository")
  await mkdir(repository)
  await execute("git", ["init", repository])
  await writeFile(join(repository, "README.md"), "original\n")
  await execute("git", ["-C", repository, "add", "."])
  await execute("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"])
  const workspace = await previous.catalog.native.createWorkspace("Previous workspace", [{ path: repository }])
  await previous.providers.update("codex", { name: "Private previous configuration", env: { OLD_SECRET: "retained-locally" } })
  const actor = previous.agents.actor()
  const created = await previous.agents.handle("_deskfleet/session/create", {
    workspaceId: workspace.id, provider: "codex", operationId: randomUUID(), context: "worktree",
  }, actor) as AgentSnapshot
  const sessionId = created.session.id
  const worktree = await previous.catalog.sessionWorktree(sessionId)
  const cwd = worktree!.directories[0]!.path
  await writeFile(join(cwd, "README.md"), "uncommitted changes\n")
  await writeFile(join(cwd, "untracked.txt"), "untracked data\n")
  await previous.agents.handle("_deskfleet/input/submit", {
    sessionId, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Retain this conversation" }],
  }, actor)
  await until(() => previous.agents.journal.read(sessionId), value => value.permissions.some(permission => permission.state === "pending"), "pending permission")
  const terminalId = "retained-terminal"
  await previous.terminals.dial({ mode: "create", terminalId, cols: 80, rows: 24, cwd, worktreeId: worktree!.id })
  await previous.terminals.input(terminalId, Buffer.from("echo retained-machine-transcript\r"))
  await until(() => previous.terminals.read(terminalId, 0, 64 * 1024), value => value.includes("retained-machine-transcript"), "terminal transcript")
  assert.equal(provider.closes, 0)
  const closeTerminals = previous.terminals.close.bind(previous.terminals)
  let closingTerminals = false
  const gate = new Promise<void>(resolve => { release = resolve })
  previous.terminals.close = async () => { closingTerminals = true; await gate; await closeTerminals() }
  const preparing = runtime.prepareEnrollment()
  assert.equal(runtime.prepareEnrollment(), preparing, "Concurrent resets share one operation")
  await until(() => closingTerminals, Boolean, "terminal shutdown")
  assert.equal(runtime.current, previous)
  assert.equal(await activeMachineDirectory(directory), join(directory, "machine"), "The active directory changes only after resource shutdown")
  release()
  const status = await preparing
  assert.equal(status.configured, false)
  assert.equal(status.revoked, false)
  assert.notEqual(status.identity.originId, originalIdentity.originId)
  assert.equal(provider.closes, 1)
  assert.notEqual(runtime.current.terminals, previous.terminals)
  assert.deepEqual(runtime.current.terminals.list(), [])
  assert.deepEqual((await runtime.current.catalog.native.snapshot()).workspaces, [])
  assert.deepEqual(await runtime.current.agents.journal.list(), [])
  assert.deepEqual(runtime.current.providers.get("codex").env, {})
  assert.notEqual(runtime.current.directory, previous.directory)
  assert.equal(await activeMachineDirectory(directory), runtime.current.directory)
  assert.deepEqual(await runtime.prepareEnrollment(), status, "Retrying prepare on the fresh identity does not rotate it again")

  assert.deepEqual(JSON.parse(await readFile(join(previous.directory, "central.json"), "utf8")), credentials)
  assert.equal(await readFile(join(cwd, "README.md"), "utf8"), "uncommitted changes\n")
  assert.equal(await readFile(join(cwd, "untracked.txt"), "utf8"), "untracked data\n")
  const gitStatus = (await execute("git", ["-C", cwd, "status", "--porcelain"])).stdout
  assert.match(gitStatus, /README\.md/u)
  assert.match(gitStatus, /untracked\.txt/u)
  const metadata = JSON.parse(await readFile(join(previous.directory, "terminals", terminalId, "session.json"), "utf8"))
  assert.equal(metadata.terminal.status, "interrupted")
  assert.match(await readFile(join(previous.directory, "terminals", terminalId, "output.bin"), "utf8"), /retained-machine-transcript/u)
  const retained = await openCatalog(join(previous.directory, "catalog.db"), "retained")
  try {
    const snapshot = JSON.parse(await retained.agentSnapshot(sessionId)) as AgentSnapshot
    assert.equal(snapshot.inputs.length, 1)
    assert.ok(snapshot.runs.every(run => run.state === "stopped"))
    assert.ok(snapshot.permissions.every(permission => permission.state !== "pending"))
    assert.equal((await retained.snapshot()).workspaces.length, 1)
  } finally { await retained.close() }
  await runtime.close()
  runtime = new MachineRuntime(directory, options)
  await runtime.init()
  assert.deepEqual(runtime.current.central.status().identity, status.identity, "Host restart selects the newly prepared directory")
  assert.deepEqual(await runtime.current.agents.journal.list(), [])
})

test("registration preparation retains host IPC and resolves getters to the new context", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-machine-ipc-reset-"))
  let starting: ReturnType<typeof startDaemon> | undefined
  const clients: DaemonClient[] = []
  context.after(async () => {
    clients.forEach(client => client.close())
    try { await (await starting)?.close() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  const own = (client: DaemonClient): DaemonClient => {
    clients.push(client)
    if (context.signal.aborted) { client.close(); context.signal.throwIfAborted() }
    return client
  }
  await seed(directory)
  context.signal.throwIfAborted()
  starting = startDaemon(0, { controlDirectory: directory, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const daemon = await starting
  context.signal.throwIfAborted()
  const first = own(await DaemonClient.connect(() => {}, () => {}, directory))
  const second = own(await DaemonClient.connect(() => {}, () => {}, directory))
  const before = await first.call("centralStatus", {})
  assert.equal(before.revoked, true)
  const discovery = await readDaemonDiscovery(directory)
  const previousTerminals = daemon.terminals
  const statuses = await Promise.all([first.call("centralPrepareEnrollment", {}), second.call("centralPrepareEnrollment", {})])
  assert.deepEqual(statuses[0], statuses[1])
  assert.notEqual(statuses[0]!.identity.originId, before.identity.originId)
  assert.deepEqual(await first.call("centralStatus", {}), statuses[0])
  assert.deepEqual(daemon.central.status(), statuses[0])
  assert.notEqual(daemon.terminals, previousTerminals)
  assert.equal(first.closed, false)
  assert.deepEqual(await readDaemonDiscovery(directory), discovery)
  assert.equal((await fetch(`${daemon.address}/healthz`)).status, 200)
})

test("an enrolled machine cannot prepare another registration just because it is offline", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-machine-reset-denied-"))
  await seed(directory, false)
  const runtime = new MachineRuntime(directory, options)
  context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  await runtime.init()
  const identity = runtime.current.central.status().identity
  await assert.rejects(runtime.prepareEnrollment(), /already enrolled/u)
  assert.deepEqual(runtime.current.central.status().identity, identity)
  assert.equal(await activeMachineDirectory(directory), join(directory, "machine"))
})

test("failed registration preparation keeps the retired catalog usable and can be retried", async context => {
  for (const failure of ["directory", "startup", "activation"] as const) await context.test(failure, async context => {
    const directory = await mkdtemp(join(tmpdir(), "df-machine-reset-retry-"))
    await seed(directory)
    const runtime = new MachineRuntime(directory, options)
    context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
    await runtime.init()
    const previous = runtime.current
    const original = previous.central.status()
    const workspace = await previous.catalog.native.createWorkspace("Retained", [{ path: directory }])
    let removeFailure = async () => {}
    if (failure === "directory") {
      const path = join(directory, "machines")
      await writeFile(path, "not a directory")
      removeFailure = () => rm(path)
    } else if (failure === "startup") {
      const init = context.mock.method(AgentProviders.prototype, "init", async () => { throw new Error("Provider settings unavailable") })
      removeFailure = async () => { init.mock.restore() }
    } else {
      const path = join(directory, "active-machine.json.tmp")
      await mkdir(path)
      removeFailure = () => rm(path, { recursive: true })
    }
    await assert.rejects(runtime.prepareEnrollment())
    assert.equal(runtime.current, previous)
    assert.deepEqual(runtime.current.central.status(), original)
    assert.equal((await runtime.current.catalog.native.snapshot()).workspaces[0]?.id, workspace.id)
    assert.equal(await activeMachineDirectory(directory), previous.directory)
    await removeFailure()
    const prepared = await runtime.prepareEnrollment()
    assert.equal(prepared.configured, false)
    assert.notEqual(prepared.identity.originId, original.identity.originId)
    assert.equal(await activeMachineDirectory(directory), runtime.current.directory)
    assert.deepEqual((await runtime.current.catalog.native.snapshot()).workspaces, [])
    await runtime.close()
  })
})

test("a committed registration reset succeeds when retired machine cleanup fails", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-machine-reset-cleanup-"))
  await seed(directory)
  const runtime = new MachineRuntime(directory, options)
  context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  await runtime.init()
  const previous = runtime.current
  const original = previous.central.status()
  const failure = new Error("Retired central cleanup failed")
  const close = previous.central.close.bind(previous.central)
  context.mock.method(previous.central, "close", async () => { await close(); throw failure })
  const report = context.mock.method(console, "error", () => {})

  const prepared = await runtime.prepareEnrollment()
  assert.equal(prepared.configured, false)
  assert.notEqual(prepared.identity.originId, original.identity.originId)
  assert.deepEqual(runtime.current.central.status(), prepared)
  assert.equal(await activeMachineDirectory(directory), runtime.current.directory)
  assert.deepEqual(await runtime.prepareEnrollment(), prepared)
  assert.throws(() => previous.catalog.native, /not available/u)
  assert.deepEqual(report.mock.calls.map(call => call.arguments), [["Retired machine cleanup failed", failure]])
})

test("host shutdown waits for an accepted reset and closes its replacement context", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-machine-reset-shutdown-"))
  await seed(directory)
  const daemon = await startDaemon(0, { controlDirectory: directory, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const client = await DaemonClient.connect(() => {}, () => {}, directory)
  let release = () => {}
  context.after(async () => { release(); client.close(); await daemon.close(); await rm(directory, { recursive: true, force: true }) })
  const originalIdentity = daemon.central.status().identity
  const closeTerminals = daemon.terminals.close.bind(daemon.terminals)
  let entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  daemon.terminals.close = async () => { entered = true; await gate; await closeTerminals() }
  const preparing = client.call("centralPrepareEnrollment", {}).catch(error => error)
  await until(() => entered, Boolean, "reset closes old terminals")
  const closing = daemon.close()
  await until(() => client.closed, Boolean, "host closes its IPC connection")
  assert.equal(await activeMachineDirectory(directory), join(directory, "machine"))
  release()
  await closing
  await preparing
  assert.notEqual(daemon.central.status().identity.originId, originalIdentity.originId)
  await assert.rejects(daemon.terminals.dial({ mode: "create", terminalId: "after-shutdown", cols: 80, rows: 24 }), /closed/u)
  await assert.rejects(readDaemonDiscovery(directory), { code: "ENOENT" })
})
