import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { openInMemoryCatalog } from "@deskfleet/native"
import { DaemonClient } from "./control-client.ts"
import { readDaemonDiscovery } from "./control-discovery.ts"
import { parseControlRequest, validateControlParams } from "./control-request.ts"
import { MAX_CONTROL_MESSAGE_BYTES } from "./control-protocol.ts"
import { startDaemon } from "./daemon.ts"

const exec = promisify(execFile)

test("workspace creation owns a main worktree and ordered anonymous directories across restart", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-catalog-"))
  const controlDirectory = join(directory, "local # catalog")
  const frontend = join(directory, "frontend")
  const backend = join(directory, "backend")
  await Promise.all([mkdir(frontend), mkdir(backend)])
  let daemon = await startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, controlDirectory, permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const clients: DaemonClient[] = []
  context.after(async () => {
    clients.forEach(client => client.close())
    await daemon.close()
    await rm(directory, { recursive: true, force: true })
  })
  let changed: (() => void) | undefined
  const client = await DaemonClient.connect(() => {}, () => {}, controlDirectory)
  const observer = await DaemonClient.connect(event => { if (event.kind === "catalogChanged") changed?.() }, () => {}, controlDirectory)
  clients.push(client, observer)
  const initial = await client.call("catalogList", {})
  assert.match(initial.machineId, /^[1-9][0-9]*$/u)
  assert.deepEqual(initial.workspaces, [])
  const notification = new Promise<void>(resolve => { changed = resolve })
  const bindings = [{ path: frontend }, { path: backend }]
  const workspace = await client.call("workspaceCreate", { name: "storefront", directories: bindings })
  await notification
  assert.equal(workspace.worktrees.length, 1)
  const main = workspace.worktrees[0]!
  assert.equal(main.sessionId, undefined)
  assert.equal(main.workspaceId, workspace.id)
  assert.deepEqual(main.directories, bindings)
  assert.deepEqual((await observer.call("catalogList", {})).workspaces, [workspace])

  await assert.rejects(client.call("workspaceUpdate", {
    workspaceId: workspace.id, name: "not saved", directories: [{ path: join(directory, "missing") }],
  }), /Cannot access directory/u)
  assert.deepEqual((await client.call("catalogList", {})).workspaces, [workspace])
  const file = join(directory, "file.txt")
  await writeFile(file, "not a directory")
  await assert.rejects(client.call("workspaceCreate", { name: "invalid", directories: [{ path: file }] }), /Not a directory/u)
  await assert.rejects(client.call("workspaceCreate", { name: "relative", directories: [{ path: "somewhere" }] }), /absolute path/u)
  const updated = await client.call("workspaceUpdate", { workspaceId: workspace.id, name: "shop", directories: bindings.toReversed() })
  assert.equal(updated.worktrees[0]!.id, main.id)
  assert.deepEqual(updated.worktrees[0]!.directories, bindings.toReversed())
  const terminal = await client.call("terminalDial", { mode: "create", terminalId: "catalog-shell", cols: 100, rows: 30, cwd: updated.worktrees[0]!.directories[0]!.path })
  assert.equal(terminal.cwd, backend)
  await client.call("terminalHangup", { terminalId: terminal.id })

  clients.forEach(connection => connection.close())
  await daemon.close()
  daemon = await startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, controlDirectory, permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const reopened = await DaemonClient.connect(() => {}, () => {}, controlDirectory)
  clients.push(reopened)
  assert.deepEqual(await reopened.call("catalogList", {}), { ...initial, workspaces: [updated] })
  await reopened.call("workspaceDelete", { workspaceId: workspace.id })
  assert.deepEqual((await reopened.call("catalogList", {})).workspaces, [])
  assert.ok((await stat(frontend)).isDirectory())
  await assert.rejects(reopened.call("workspaceUpdate", { workspaceId: "9007199254740993", name: "missing", directories: bindings }), /not found|Not found|does not exist/u)
})

test("session lifecycle creates isolated Git worktrees and removes them without deleting main directories", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-session-catalog-"))
  const checkout = join(directory, "checkout")
  await mkdir(checkout)
  await exec("git", ["init", "-q", checkout])
  await writeFile(join(checkout, "README.md"), "source")
  await exec("git", ["-C", checkout, "add", "."])
  await exec("git", ["-C", checkout, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"])
  let daemon = await startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, controlDirectory: join(directory, "daemon"), permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  let client = await DaemonClient.connect(() => {}, () => {}, join(directory, "daemon"))
  context.after(async () => { client.close(); await daemon.close(); await rm(directory, { recursive: true, force: true }) })
  const workspace = await client.call("workspaceCreate", { name: "project", directories: [{ path: checkout }] })
  const session = await client.call("workspaceSessionCreate", { workspaceId: workspace.id })
  assert.equal(session.worktree.sessionId, session.id)
  const isolated = session.worktree.directories[0]!.path
  assert.notEqual(isolated, checkout)
  assert.equal(await readFile(join(isolated, "README.md"), "utf8"), "source")
  await writeFile(join(isolated, "README.md"), "session change")
  assert.equal(await readFile(join(checkout, "README.md"), "utf8"), "source")
  await assert.rejects(client.call("workspaceDelete", { workspaceId: workspace.id }))
  assert.equal((await client.call("catalogList", {})).workspaces[0]!.worktrees.length, 2)
  client.close()
  await daemon.close()
  daemon = await startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, controlDirectory: join(directory, "daemon"), permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  client = await DaemonClient.connect(() => {}, () => {}, join(directory, "daemon"))
  await client.call("workspaceSessionDestroy", { sessionId: session.id })
  await assert.rejects(stat(isolated), { code: "ENOENT" })
  assert.deepEqual((await client.call("catalogList", {})).workspaces, [workspace])
  assert.equal(await readFile(join(checkout, "README.md"), "utf8"), "source")
})

test("catalog operations require local authentication and exclusive daemon ownership", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-catalog-auth-"))
  const daemon = await startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, openCatalog: (_path, name) => openInMemoryCatalog(name), controlDirectory: directory, permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const clients: DaemonClient[] = []
  context.after(async () => {
    clients.forEach(client => client.close())
    await daemon.close()
    await rm(directory, { recursive: true, force: true })
  })
  const discovery = await readDaemonDiscovery(directory)
  const socket = connect(discovery.endpoint)
  context.after(() => socket.destroy())
  await once(socket, "connect")
  const response = once(socket, "data")
  socket.write(JSON.stringify({ id: 1, method: "workspaceCreate", params: { name: "unauthenticated", directories: [{ path: directory }] } }) + "\n")
  const [data] = await response
  assert.match(JSON.parse(String(data)).error, /Authenticate/u)
  socket.destroy()
  const client = await DaemonClient.connect(() => {}, () => {}, directory)
  clients.push(client)
  const workspace = await client.call("workspaceCreate", { name: "retained", directories: [{ path: directory }] })
  await assert.rejects(startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, openCatalog: (_path, name) => openInMemoryCatalog(name), controlDirectory: directory, permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null }), /already running/u)
  assert.deepEqual((await client.call("catalogList", {})).workspaces, [workspace])
})

test("catalog IPC requires paths and bigint IDs, and exposes no manual Worktree operations", () => {
  assert.deepEqual(validateControlParams("workspaceDelete", { workspaceId: "9007199254740993" }), { workspaceId: "9007199254740993" })
  for (const id of [9007199254740993, "0", "-1", "1.5", "9223372036854775808", "other"]) {
    assert.throws(() => validateControlParams("workspaceDelete", { workspaceId: id }), /resource ID/u)
  }
  assert.throws(() => validateControlParams("workspaceCreate", { name: "project", directories: [] }), /at least one/u)
  assert.throws(() => validateControlParams("workspaceCreate", { name: "project", directories: [{ name: "root", path: "/a" }] }), /only paths/u)
  assert.throws(() => validateControlParams("workspaceCreate", { name: "project", directories: [{ path: "/a" }, { path: "/a" }] }), /unique/u)
  for (const method of ["worktreeCreate", "worktreeUpdate", "worktreeDelete"]) {
    assert.throws(() => parseControlRequest({ id: 1, method, params: {} }), /Unknown local daemon operation/u)
  }
})

test("catalog snapshots can grow beyond individual IPC request and queue limits", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-catalog-size-"))
  const daemon = await startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, openCatalog: (_path, name) => openInMemoryCatalog(name), controlDirectory: directory, permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const client = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(async () => { client.close(); await daemon.close(); await rm(directory, { recursive: true, force: true }) })
  const directories = Array.from({ length: 700 }, (_, index) => ({ path: join(directory, String(index).padEnd(230, "x")) }))
  await Promise.all(directories.map(({ path }) => mkdir(path)))
  for (let index = 0; index < 6; index++) {
    await client.call("workspaceCreate", { name: `project ${index}`, directories })
  }
  const snapshot = await client.call("catalogList", {})
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > MAX_CONTROL_MESSAGE_BYTES * 4)
  assert.equal(snapshot.workspaces.length, 6)
  assert.deepEqual(snapshot.workspaces[5]!.worktrees[0]!.directories, directories)
})

test("a Session Worktree terminal starts in the Worktree and ends when its Session is destroyed", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-worktree-terminal-"))
  const controlDirectory = join(directory, "daemon")
  const repository = join(directory, "repository")
  await mkdir(repository)
  await exec("git", ["init", repository])
  await writeFile(join(repository, "README.md"), "fixture\n")
  await exec("git", ["-C", repository, "add", "."])
  await exec("git", ["-C", repository, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"])
  const daemon = await startDaemon(0, { agentQuotas: new TestAgentQuotas(), allowLocalControlForTests: true, openCatalog: (_path, name) => openInMemoryCatalog(name), controlDirectory, permissionPlatform: "darwin" as const, requestScreenCaptureAccess: async () => null, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const client = await DaemonClient.connect(() => {}, () => {}, controlDirectory)
  context.after(async () => {
    client.close()
    await daemon.close()
    await rm(directory, { recursive: true, force: true })
  })
  const workspace = await client.call("workspaceCreate", { name: "repo", directories: [{ path: repository }] })
  const session = await client.call("workspaceSessionCreate", { workspaceId: workspace.id })
  await assert.rejects(client.call("terminalDial", { mode: "create", terminalId: "main-shell", cols: 80, rows: 24, worktreeId: workspace.worktrees[0]!.id }), /Session worktree is unavailable/u)
  const owned = await client.call("terminalDial", { mode: "create", terminalId: "session-shell", cols: 80, rows: 24, worktreeId: session.worktree.id })
  assert.equal(owned.worktreeId, session.worktree.id)
  assert.equal(owned.cwd, session.worktree.directories[0]!.path)
  const machine = await client.call("terminalDial", { mode: "create", terminalId: "machine-shell", cols: 80, rows: 24, cwd: repository })
  await client.call("workspaceSessionDestroy", { sessionId: session.id })
  assert.deepEqual((await client.call("terminalList", {})).map(terminal => terminal.id), [machine.id])
})
