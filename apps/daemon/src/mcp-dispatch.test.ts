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
      handle: async (method: string, params: Record<string, unknown>, ...args: unknown[]) => {
        calls.push([method, params, ...args])
        if (method === "_deskfleet/session/create") return { session: { id: "50", workspaceId: params.workspaceId, lifecycle: "ready" } }
        if (method === "_deskfleet/input/submit") return { operationId: params.operationId, commandId: "cmd-1", sessionId: params.sessionId, inputId: "in-1" }
        return "history"
      },
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
      handle: async (request: unknown) => {
        calls.push(["catalog", request])
        return { id: "30", ...(request as { params: Record<string, unknown> }).params }
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

test("machine-scoped MCP sees and delegates into Workspaces while isolating other machine-scoped Sessions", async () => {
  const { operations, calls } = fixture()
  assert.deepEqual(await dispatchMcp(operations, "catalogList", {}, actor, machineScope), {
    teamId: "1", machineId: "1", machineName: "host", sessionId: "40",
    workspaces: [{ id: "10" }, { id: "20" }],
    sessions: [{ id: "100", sessionId: "40", directories: [{ path: "/home/a" }] }],
  })
  assert.deepEqual(await dispatchMcp(operations, "_deskfleet/session/list", {}, actor, machineScope), [
    { id: "1", workspaceId: "10" },
    { id: "2", workspaceId: "20" },
    { id: "40" },
  ])
  for (const [method, params] of [
    ["_deskfleet/session/subscribe", { sessionId: "41" }],
    ["_deskfleet/session/history", { sessionId: "41", afterSeq: "0" }],
    ["_deskfleet/input/submit", { sessionId: "41", prompt: "intrude" }],
  ] as const) await assert.rejects(dispatchMcp(operations, method, params, actor, machineScope), /outside/)
  assert.equal(await dispatchMcp(operations, "_deskfleet/session/history", { sessionId: "40", afterSeq: "0" }, actor, machineScope), "history")
  assert.equal(await dispatchMcp(operations, "_deskfleet/session/history", { sessionId: "2", afterSeq: "0" }, actor, machineScope), "history")
  assert.equal(await dispatchMcp(operations, "_deskfleet/session/subscribe", { sessionId: "1" }, actor, machineScope), "history")
  await dispatchMcp(operations, "_deskfleet/input/submit", { sessionId: "2", prompt: "Delegate into workspace" }, actor, machineScope)
  assert.deepEqual(calls.slice(0, 3), [
    ["_deskfleet/session/history", { sessionId: "40", afterSeq: "0" }, actor],
    ["_deskfleet/session/history", { sessionId: "2", afterSeq: "0" }, actor],
    ["_deskfleet/session/subscribe", { sessionId: "1" }, actor],
  ])
  assert.deepEqual({ ...(calls[3] as [string, Record<string, unknown>])[1], operationId: "op" }, {
    sessionId: "2", operationId: "op", content: [{ type: "text", text: "Delegate into workspace" }], delivery: "backlog",
  })

  const createdWorkspace = await dispatchMcp(operations, "workspaceCreate", {
    name: "New Workspace", directories: [{ path: "/srv/app" }, { path: "/srv/shared" }],
  }, actor, machineScope)
  assert.deepEqual(createdWorkspace, { id: "30", name: "New Workspace", directories: [{ path: "/srv/app" }, { path: "/srv/shared" }] })
  assert.deepEqual(calls[4], ["catalog", { method: "workspaceCreate", params: { name: "New Workspace", directories: [{ path: "/srv/app" }, { path: "/srv/shared" }] } }])

  for (const invalid of [
    { name: "   ", directories: [{ path: "/srv/app" }] },
    { name: "x".repeat(257), directories: [{ path: "/srv/app" }] },
    { name: "bad\0name", directories: [{ path: "/srv/app" }] },
    { name: "Empty dirs", directories: [] },
    { name: "Alias", directories: [{ path: "/srv/app", name: "root" }] },
    { name: "Dupes", directories: [{ path: "/srv/app" }, { path: "/srv/app" }] },
    { name: "Null path", directories: [{ path: "/srv/\0app" }] },
    { name: "Long path", directories: [{ path: "/" + "a".repeat(4096) }] },
    { name: "Extra", directories: [{ path: "/srv/app" }], extra: true },
  ]) await assert.rejects(dispatchMcp(operations, "workspaceCreate", invalid, actor, machineScope))

  await assert.rejects(dispatchMcp(operations, "_deskfleet/session/create", { workspaceId: "999", provider: "codex" }, actor, machineScope), /Unknown Workspace: 999/)
  await dispatchMcp(operations, "_deskfleet/session/create", { workspaceId: "20", provider: "codex", context: "worktree", title: "Scoped child" }, actor, machineScope)
  assert.deepEqual({ ...(calls[5] as [string, Record<string, unknown>])[1], operationId: "op" }, {
    workspaceId: "20", operationId: "op", title: "Scoped child", provider: "codex", context: "worktree",
  })
  await dispatchMcp(operations, "_deskfleet/session/create", { provider: "codex", title: "Home helper" }, actor, machineScope)
  assert.deepEqual({ ...(calls[6] as [string, Record<string, unknown>])[1], operationId: "op" }, {
    operationId: "op", title: "Home helper", provider: "codex", context: "directory",
  })
  await assert.rejects(dispatchMcp(operations, "scheduleCreate", { schedule: { title: "Task" } }, actor, machineScope), /Workspace/)
})

test("MCP rejects resource IDs and updates outside its issuing Workspace", async () => {
  const { operations, calls } = fixture()
  for (const [method, params] of [
    ["_deskfleet/session/subscribe", { sessionId: "2" }],
    ["_deskfleet/session/subscribe", { sessionId: "40" }],
    ["_deskfleet/session/history", { sessionId: "2", afterSeq: "0" }],
    ["_deskfleet/session/create", { workspaceId: "20", provider: "codex" }],
    ["_deskfleet/input/submit", { sessionId: "2", prompt: "outside" }],
    ["workspaceCreate", { name: "Escape", directories: [{ path: "/srv/escape" }] }],
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
  await dispatchMcp(operations, "_deskfleet/session/create", { provider: "codex", context: "worktree", title: "Child", prompt: "Start work", configuration: { model: "gpt-5" } }, actor, scope)
  assert.equal((calls[2] as unknown[])[0], "_deskfleet/session/create")
  assert.deepEqual({ ...(calls[2] as [string, Record<string, unknown>])[1], operationId: "op" }, {
    workspaceId: "10", operationId: "op", title: "Child", provider: "codex", context: "worktree", model: "gpt-5",
  })
  assert.equal((calls[3] as unknown[])[0], "_deskfleet/input/submit")
  assert.deepEqual({ ...(calls[3] as [string, Record<string, unknown>])[1], operationId: "op" }, {
    sessionId: "50", operationId: "op", content: [{ type: "text", text: "Start work" }], delivery: "backlog",
  })
  assert.deepEqual(calls[4], ["_deskfleet/session/subscribe", { sessionId: "50" }, actor])
  await dispatchMcp(operations, "_deskfleet/input/submit", { sessionId: "1", prompt: "Follow up", delivery: "steer", turnId: "turn-1" }, actor, scope)
  assert.deepEqual({ ...(calls[5] as [string, Record<string, unknown>])[1], operationId: "op" }, {
    sessionId: "1", operationId: "op", content: [{ type: "text", text: "Follow up" }], delivery: "steer", turnId: "turn-1",
  })
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
  assert.equal(await dispatchMcp(operations, "remoteMcp/workspaceCreate", { machineId: "target", name: "Remote repo", directories: [{ path: "/srv/repo" }] }, actor, scope, remote), "remote")
  assert.deepEqual(requests, [
    { userId: "creator", deviceId: "login", sessionId: "1", operation: "session", machineId: "target", arguments: { sessionId: "remote-session" } },
    { userId: "creator", deviceId: "login", sessionId: "1", operation: "workspaceCreate", machineId: "target", arguments: { name: "Remote repo", directories: [{ path: "/srv/repo" }] } },
  ])
  await assert.rejects(dispatchMcp(operations, "remoteMcp/workspaceCreate", { machineId: "target", name: "Dupes", directories: [{ path: "/a" }, { path: "/a" }] }, actor, scope, remote), /unique/)
  await assert.rejects(dispatchMcp(operations, "remoteMcp/session", { sessionId: "remote-session" }, actor, scope, remote), /target machine/)
  operations.agents.requireActive = async () => { throw new Error("Session is archived") }
  await assert.rejects(dispatchMcp(operations, "remoteMcp/machines", {}, actor, scope, remote), /archived/)
  assert.equal(requests.length, 2)
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

test("a Workspace-bound BYOA Super Agent Session keeps cross-Workspace MCP delegation", async () => {
  const { calls, operations } = fixture()
  const superScope = { sessionId: "90", workspaceId: "10", superAgent: true }
  const superSession = { id: "90", workspaceId: "10", superAgent: true }
  const list = await operations.agents.journal.list()
  ;(list as unknown as Record<string, unknown>[]).push(superSession)

  assert.deepEqual(await dispatchMcp(operations, "catalogList", {}, actor, superScope), {
    teamId: "1", machineId: "1", machineName: "host", sessionId: "90", workspaceId: "10",
    workspaces: [{ id: "10" }, { id: "20" }], sessions: [],
  })
  assert.deepEqual(
    ((await dispatchMcp(operations, "_deskfleet/session/list", {}, actor, superScope)) as { id: string }[]).map(s => s.id),
    ["1", "2", "90"],
  )
  assert.deepEqual(
    await dispatchMcp(operations, "workspaceCreate", { name: "New repo", directories: [{ path: "/srv/new" }] }, actor, superScope),
    { id: "30", name: "New repo", directories: [{ path: "/srv/new" }] },
  )
  await dispatchMcp(operations, "_deskfleet/session/create", { workspaceId: "20", provider: "codex", context: "directory" }, actor, superScope)
  assert.equal((calls.at(-1) as [string, Record<string, unknown>])[1].workspaceId, "20")
  await assert.rejects(dispatchMcp(operations, "catalogList", {}, actor, { sessionId: "1", workspaceId: "10", superAgent: true }), /scope/)
})

test("MCP session creation inherits YOLO from YOLO parents, allows opt-down, and blocks non-YOLO escalation", async () => {
  const { calls, operations } = fixture()
  const yoloScope = { sessionId: "95", workspaceId: "10" }
  const list = await operations.agents.journal.list()
  ;(list as unknown as Record<string, unknown>[]).push({ id: "95", workspaceId: "10", yolo: true })

  // Non-YOLO parent cannot escalate locally or remotely, and omits yolo when false or unset.
  await assert.rejects(
    dispatchMcp(operations, "_deskfleet/session/create", { provider: "codex", yolo: true }, actor, scope),
    /Only a YOLO Session/,
  )
  const remoteRequests: unknown[] = []
  const remote = async (request: unknown) => { remoteRequests.push(request); return "remote" }
  await assert.rejects(
    dispatchMcp(operations, "remoteMcp/sessionCreate", { machineId: "target", provider: "codex", yolo: true }, actor, scope, remote),
    /Only a YOLO Session/,
  )
  await dispatchMcp(operations, "_deskfleet/session/create", { provider: "codex", yolo: false }, actor, scope)
  assert.equal("yolo" in (calls.at(-1) as [string, Record<string, unknown>])[1], false)
  await dispatchMcp(operations, "remoteMcp/sessionCreate", { machineId: "target", provider: "codex" }, actor, scope, remote)
  assert.deepEqual(remoteRequests.at(-1), {
    userId: "creator", deviceId: "login", sessionId: "1", operation: "sessionCreate", machineId: "target",
    arguments: { provider: "codex" },
  })

  // YOLO parent propagates yolo: true by default locally and remotely.
  await dispatchMcp(operations, "_deskfleet/session/create", { provider: "codex", context: "worktree" }, actor, yoloScope)
  assert.equal((calls.at(-1) as [string, Record<string, unknown>])[1].yolo, true)
  await dispatchMcp(operations, "remoteMcp/sessionCreate", { machineId: "target", provider: "codex" }, actor, yoloScope, remote)
  assert.deepEqual(remoteRequests.at(-1), {
    userId: "creator", deviceId: "login", sessionId: "95", operation: "sessionCreate", machineId: "target",
    arguments: { provider: "codex", yolo: true },
  })

  // YOLO parent can explicitly opt down with yolo: false locally and remotely.
  await dispatchMcp(operations, "_deskfleet/session/create", { provider: "codex", yolo: false }, actor, yoloScope)
  assert.equal("yolo" in (calls.at(-1) as [string, Record<string, unknown>])[1], false)
  await dispatchMcp(operations, "remoteMcp/sessionCreate", { machineId: "target", provider: "codex", yolo: false }, actor, yoloScope, remote)
  assert.deepEqual(remoteRequests.at(-1), {
    userId: "creator", deviceId: "login", sessionId: "95", operation: "sessionCreate", machineId: "target",
    arguments: { provider: "codex" },
  })
})

test("opt-in local cross-workspace delegation lets Workspace Sessions delegate across local Workspaces without exposing machine-scoped Sessions or workspace creation", async () => {
  const { calls, operations } = fixture()
  let enabled = false
  const allowCrossWorkspace = () => enabled

  // Disabled by default: sibling Workspace stays blocked.
  await assert.rejects(
    dispatchMcp(operations, "_deskfleet/session/create", { workspaceId: "20", provider: "codex" }, actor, scope, undefined, allowCrossWorkspace),
    /outside/,
  )

  // Live opt-in opens sibling Workspace discovery and Session delegation.
  enabled = true
  assert.deepEqual(await dispatchMcp(operations, "catalogList", {}, actor, scope, undefined, allowCrossWorkspace), {
    teamId: "1", machineId: "1", machineName: "host", sessionId: "1", workspaceId: "10",
    workspaces: [{ id: "10" }, { id: "20" }], sessions: [],
  })
  assert.deepEqual(
    ((await dispatchMcp(operations, "_deskfleet/session/list", {}, actor, scope, undefined, allowCrossWorkspace)) as { id: string }[]).map(s => s.id),
    ["1", "2"],
  )
  assert.equal(await dispatchMcp(operations, "_deskfleet/session/subscribe", { sessionId: "2" }, actor, scope, undefined, allowCrossWorkspace), "history")
  await dispatchMcp(operations, "_deskfleet/input/submit", { sessionId: "2", prompt: "Build consumer" }, actor, scope, undefined, allowCrossWorkspace)
  await dispatchMcp(operations, "_deskfleet/session/create", { workspaceId: "20", provider: "codex", context: "worktree" }, actor, scope, undefined, allowCrossWorkspace)
  assert.equal((calls.at(-1) as [string, Record<string, unknown>])[1].workspaceId, "20")
  // Omitting workspaceId still defaults to the issuing Session's own Workspace.
  await dispatchMcp(operations, "_deskfleet/session/create", { provider: "codex", context: "worktree" }, actor, scope, undefined, allowCrossWorkspace)
  assert.equal((calls.at(-1) as [string, Record<string, unknown>])[1].workspaceId, "10")

  // Machine-scoped Sessions and local Workspace creation remain isolated.
  await assert.rejects(dispatchMcp(operations, "_deskfleet/session/subscribe", { sessionId: "40" }, actor, scope, undefined, allowCrossWorkspace), /outside/)
  await assert.rejects(dispatchMcp(operations, "workspaceCreate", { name: "Blocked", directories: [{ path: "/srv/blocked" }] }, actor, scope, undefined, allowCrossWorkspace), /outside/)
  await assert.rejects(dispatchMcp(operations, "_deskfleet/session/create", { workspaceId: "999", provider: "codex" }, actor, scope, undefined, allowCrossWorkspace), /Unknown Workspace: 999/)
})
