import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { MachineOperations } from "./machine-operations.ts"
import { dispatchMcp } from "./mcp-dispatch.ts"
import { writeRemoteAgentSettings } from "./remote-agent-settings.ts"
import { RemoteMcp } from "./remote-mcp.ts"

const actor = { kind: "user" as const, userId: "creator", deviceId: "login" }
const scope = { sessionId: "1", workspaceId: "10" }
const machineScope = { sessionId: "40" }

function fixture() {
  const calls: unknown[] = []
  const tasks = [{ id: "a", workspaceId: "10" }, { id: "b", workspaceId: "20" }]
  const sessions = [
    { id: "1", workspaceId: "10" },
    { id: "2", workspaceId: "20" },
    { id: "40" },
    { id: "41" },
  ]
  const operations = {
    agents: {
      requireActive: async (id: string) => ({ session: sessions.find(session => session.id === id)! }),
      journal: { list: async () => sessions, read: async (id: string) => ({ session: sessions.find(session => session.id === id)! }) },
      handle: async (...args: unknown[]) => { calls.push(args); return "history" },
    },
    catalog: {
      native: {
        snapshot: async () => ({
          teamId: "1", machineId: "1", machineName: "host",
          workspaces: [{ id: "10" }, { id: "20" }],
          sessions: [
            { id: "100", sessionId: "40", directories: [{ path: "/home/a" }] },
            { id: "101", sessionId: "41", directories: [{ path: "/home/b" }] },
          ],
        }),
      },
    },
    providers: { metadata: () => ({ providers: [{ id: "codex", name: "Codex" }] }) },
    handle: async (method: string, ...args: unknown[]) => {
      if (method === "scheduleList") return tasks
      calls.push([method, ...args]); return "accepted"
    },
  } as unknown as MachineOperations
  return { calls, operations }
}

test("MCP discovery filters Workspace resources and never exposes provider launch secrets", async () => {
  const { operations } = fixture()
  assert.deepEqual(await dispatchMcp(operations, "catalogList", {}, actor, scope), {
    teamId: "1", machineId: "1", machineName: "host", sessionId: "1", workspaceId: "10",
    workspaces: [{ id: "10" }], sessions: [],
  })
  assert.deepEqual(await dispatchMcp(operations, "_deskfleet/session/list", {}, actor, scope), [{ id: "1", workspaceId: "10" }])
  assert.deepEqual(await dispatchMcp(operations, "scheduleList", {}, actor, scope), [{ id: "a", workspaceId: "10" }])
  assert.deepEqual(await dispatchMcp(operations, "providerList", {}, actor, scope), { providers: [{ id: "codex", name: "Codex" }] })
})

test("machine-scoped MCP isolation stays on the issuing Session", async () => {
  const { operations, calls } = fixture()
  assert.deepEqual(await dispatchMcp(operations, "catalogList", {}, actor, machineScope), {
    teamId: "1", machineId: "1", machineName: "host", sessionId: "40",
    workspaces: [],
    sessions: [{ id: "100", sessionId: "40", directories: [{ path: "/home/a" }] }],
  })
  assert.deepEqual(await dispatchMcp(operations, "_deskfleet/session/list", {}, actor, machineScope), [{ id: "40" }])
  await assert.rejects(dispatchMcp(operations, "_deskfleet/session/history", { sessionId: "41", afterSeq: "0" }, actor, machineScope), /outside/)
  assert.equal(await dispatchMcp(operations, "_deskfleet/session/history", { sessionId: "40", afterSeq: "0" }, actor, machineScope), "history")
  assert.deepEqual(calls, [["_deskfleet/session/history", { sessionId: "40", afterSeq: "0" }, actor]])
  await assert.rejects(dispatchMcp(operations, "scheduleCreate", { schedule: { title: "Task" } }, actor, machineScope), /Workspace/)
})

test("MCP rejects resource IDs and updates outside its issuing Workspace", async () => {
  const { operations, calls } = fixture()
  for (const [method, params] of [
    ["_deskfleet/session/subscribe", { sessionId: "2" }],
    ["_deskfleet/session/history", { sessionId: "2", afterSeq: "0" }],
    ["scheduleCreate", { schedule: { workspaceId: "20" } }],
    ["scheduleDelete", { scheduleId: "b" }],
    ["scheduleRun", { scheduleId: "b" }],
    ["scheduleUpdate", { scheduleId: "a", changes: { workspaceId: "20" } }],
    ["workspaceDelete", { workspaceId: "10" }],
  ] as const) await assert.rejects(dispatchMcp(operations, method, params, actor, scope), /outside|unavailable/)
  assert.deepEqual(calls, [])
  assert.equal(await dispatchMcp(operations, "scheduleUpdate", { scheduleId: "a", changes: { enabled: false } }, actor, scope), "accepted")
  assert.deepEqual(calls[0], ["scheduleUpdate", { scheduleId: "a", changes: { enabled: false } }, actor])
  await dispatchMcp(operations, "scheduleCreate", { schedule: { title: "Review changes" } }, actor, scope)
  assert.deepEqual(calls[1], ["scheduleCreate", { schedule: { title: "Review changes", workspaceId: "10" } }, actor])
})

test("an archived issuing Session cannot use a retained MCP grant", async () => {
  const { operations, calls } = fixture()
  operations.agents.requireActive = async () => { throw new Error("Session is archived") }
  await assert.rejects(dispatchMcp(operations, "scheduleRun", { scheduleId: "a" }, actor, scope), /archived/)
  assert.deepEqual(calls, [])
})

test("cross-machine tools bind the initiating Session and actor while the target is explicit", async () => {
  const { operations } = fixture()
  const requests: unknown[] = []
  const remote = async (request: unknown) => { requests.push(request); return "remote" }
  assert.equal(await dispatchMcp(operations, "remoteMcp/session", { machineId: "target", sessionId: "remote-session" }, actor, scope, remote), "remote")
  assert.deepEqual(requests, [{ userId: "creator", deviceId: "login", sessionId: "1", operation: "session", machineId: "target", arguments: { sessionId: "remote-session" } }])
  await assert.rejects(dispatchMcp(operations, "remoteMcp/session", { sessionId: "remote-session" }, actor, scope, remote), /target machine/)
  operations.agents.requireActive = async () => { throw new Error("Session is archived") }
  await assert.rejects(dispatchMcp(operations, "remoteMcp/machines", {}, actor, scope, remote), /archived/)
  assert.equal(requests.length, 1)
})

test("cross-machine file tools reuse FilesService and FileTransferManager with live read/operate authorization", async t => {
  const { operations } = fixture()
  const root = await mkdtemp(join(tmpdir(), "df-mcp-files-"))
  const localDir = join(root, "local"), remoteDir = join(root, "remote"), downloadDir = join(root, "download"), settingsDir = join(root, "settings")
  await Promise.all([mkdir(join(localDir, "saves", "empty"), { recursive: true }), mkdir(remoteDir), mkdir(downloadDir), mkdir(settingsDir)])
  const payload = Buffer.from(Array.from({ length: 200_003 }, (_, index) => index % 251))
  await writeFile(join(localDir, "saves", "world.sav"), payload)
  await writeFile(join(localDir, "profile.lua"), "return { name = 'Lemon' }\n")

  const targetService = new RemoteMcp(settingsDir, operations)
  t.after(async () => { targetService.close(); await rm(root, { recursive: true, force: true }) })
  const delegatedActor = { ...actor, sourceMachine: { id: "source", originId: "origin" } }
  const remote = (request: { sessionId: string; operation: string; arguments: Record<string, unknown> }) =>
    targetService.handle("remoteMcp", {
      source: { teamId: "team", machineId: "source", sessionId: request.sessionId },
      operation: request.operation,
      arguments: request.arguments,
    }, delegatedActor, { teamId: "team", machineId: "target" })

  // Read-only access permits listing, stat, and downloading, but rejects uploading.
  await writeRemoteAgentSettings(settingsDir, { allowRead: true, allowOperate: false })
  await assert.rejects(
    dispatchMcp(operations, "remoteMcp/fileUpload", { machineId: "target", sourcePath: join(localDir, "profile.lua"), destinationDirectory: remoteDir }, actor, scope, remote),
    /operate/,
  )
  assert.deepEqual(await readdir(remoteDir), [])

  // Operate access permits uploading files and directories with conflict policies.
  await writeRemoteAgentSettings(settingsDir, { allowRead: false, allowOperate: true })
  const uploadedFile = await dispatchMcp(operations, "remoteMcp/fileUpload", {
    machineId: "target", sourcePath: join(localDir, "profile.lua"), destinationDirectory: remoteDir,
  }, actor, scope, remote) as { name: string; kind: string; transferredBytes: number; skipped: boolean }
  assert.equal(uploadedFile.name, "profile.lua")
  assert.equal(uploadedFile.kind, "file")
  assert.equal(uploadedFile.skipped, false)

  await assert.rejects(
    dispatchMcp(operations, "remoteMcp/fileUpload", { machineId: "target", sourcePath: join(localDir, "profile.lua"), destinationDirectory: remoteDir, conflict: "ask" }, actor, scope, remote),
    /already exists/,
  )
  const skippedFile = await dispatchMcp(operations, "remoteMcp/fileUpload", {
    machineId: "target", sourcePath: join(localDir, "profile.lua"), destinationDirectory: remoteDir, conflict: "skip",
  }, actor, scope, remote) as { skipped: boolean }
  assert.equal(skippedFile.skipped, true)

  const uploadedFolder = await dispatchMcp(operations, "remoteMcp/fileUpload", {
    machineId: "target", sourcePath: join(localDir, "saves"), destinationDirectory: remoteDir, conflict: "replace",
  }, actor, scope, remote) as { name: string; kind: string; transferredBytes: number }
  assert.equal(uploadedFolder.name, "saves")
  assert.equal(uploadedFolder.kind, "directory")
  assert.equal(uploadedFolder.transferredBytes, payload.byteLength)

  // Listing and stat work under read or operate permission.
  await writeRemoteAgentSettings(settingsDir, { allowRead: true, allowOperate: false })
  const listed = await dispatchMcp(operations, "remoteMcp/files", { machineId: "target", path: remoteDir }, actor, scope, remote) as { entries: { name: string; kind: string }[] }
  assert.deepEqual(listed.entries.map(entry => ({ name: entry.name, kind: entry.kind })), [
    { name: "saves", kind: "directory" },
    { name: "profile.lua", kind: "file" },
  ])
  const statted = await dispatchMcp(operations, "remoteMcp/files", { machineId: "target", operation: "stat", path: join(remoteDir, "saves", "world.sav") }, actor, scope, remote) as { size: number }
  assert.equal(statted.size, payload.byteLength)

  // Downloading copies the remote folder back into the local destination directory.
  const downloaded = await dispatchMcp(operations, "remoteMcp/fileDownload", {
    machineId: "target", sourcePath: join(remoteDir, "saves"), destinationDirectory: downloadDir,
  }, actor, scope, remote) as { transferredBytes: number; skipped: boolean }
  assert.equal(downloaded.transferredBytes, payload.byteLength)
  assert.equal(downloaded.skipped, false)
  assert.deepEqual(await readFile(join(downloadDir, "saves", "world.sav")), payload)
  assert.deepEqual(await readdir(join(downloadDir, "saves", "empty")), [])
})

