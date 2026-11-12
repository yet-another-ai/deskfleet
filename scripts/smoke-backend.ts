import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { CatalogSnapshot, CatalogWorkspace } from "../crates/node/index.ts"
import { startDaemon } from "../apps/daemon/src/daemon.ts"
import { DaemonClient } from "../apps/daemon/src/control-client.ts"
import type { AgentCommand, AgentEvent, AgentSnapshot } from "../apps/daemon/src/agent-protocol.ts"
import type { AgentProviderConfig, ProviderSnapshot } from "../apps/daemon/src/provider-protocol.ts"
import type { TerminalSummary } from "../apps/daemon/src/terminal-protocol.ts"
import { BackendAgent } from "./fixtures/backend-agent.ts"
import { connectBackendPeer, until, type BackendRequest } from "./fixtures/backend-peer.ts"
import type { FixtureLogin } from "./fixtures/backend-auth.ts"
import { startBackendFixture } from "./fixtures/backend-server.ts"
import { smokePortForwarding } from "./fixtures/backend-ports.ts"

const fixture = await startBackendFixture()
const { backend, auth } = fixture
let httpFixture: Awaited<ReturnType<typeof startBackendFixture>> | undefined
let httpBackend = backend
const directory = await mkdtemp(join(tmpdir(), "deskfleet-backend-smoke-"))
const execute = promisify(execFile)
const daemons: Awaited<ReturnType<typeof startDaemon>>[] = []
const closePeers: (() => Promise<void>)[] = []
const machines: string[] = []
let admin: BackendRequest | undefined
let teamId: string | undefined
const additionalTeams: string[] = []
const registration = (daemon: Awaited<ReturnType<typeof startDaemon>>) => daemon.registrations.forTeam({ serverUrl: backend, teamId: teamId! })

function client(login: FixtureLogin): BackendRequest {
  return async <T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> => {
    const response = await fetch(`${httpBackend}/api${path}`, {
      method, headers: { authorization: `Bearer ${login.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return (text ? JSON.parse(text) : undefined) as T
  }
}

try {
  // Keep daemon/client sockets on A while API requests reach B. Both processes
  // advertise the same public identity, as replicas behind one proxy would.
  httpFixture = await startBackendFixture({ publicUrl: backend })
  httpBackend = httpFixture.backend
  assert.notEqual(httpBackend, backend)
  const alice = await auth.login(backend, { subject: "alice", name: "Alice smoke", email: "alice@example.invalid" })
  const bob = await auth.login(backend, { subject: "bob", name: "Bob smoke", email: "bob@example.invalid" })
  await fixture.configureTurnSettings(alice)
  admin = client(alice)
  const member = client(bob)
  assert.deepEqual(auth.exchanges, ["alice", "bob"])
  assert.equal((await admin<{ user: { id: string } }>("/me")).user.id, alice.user.id)
  const team = await admin<{ id: string; role: string }>("/teams", { name: `Backend smoke ${randomUUID()}` })
  teamId = team.id
  assert.equal(team.role, "owner")
  console.log("Mailbox verification, password login, and native proof exchange passed")

  const providers: BackendAgent[] = []
  const workspaces: CatalogWorkspace[] = []
  const sessions: AgentSnapshot[] = []
  const rpc = <T>(machineId: string, method: string, params: unknown, request: BackendRequest = admin!): Promise<T> => request<T>(`/teams/${teamId}/machines/${machineId}/rpc`, { method, params })
  for (let index = 0; index < 2; index++) {
    const repository = join(directory, `repository-${index}`)
    const controlDirectory = join(directory, `daemon-${index}`)
    await mkdir(repository)
    await execute("git", ["init", repository])
    await writeFile(join(repository, "README.md"), `machine ${index}\n`)
    await execute("git", ["-C", repository, "add", "."])
    await execute("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"])
    const provider = new BackendAgent()
    providers.push(provider)
    const daemon = await startDaemon(0, { controlDirectory, agentProvider: provider, requestScreenCaptureAccess: async () => false, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
    daemons.push(daemon)
    const prepared = await daemon.registrations.prepareEnrollment({ serverUrl: backend, teamId })
    const { identity, identityToken } = prepared
    const enrollment: { machine: { id: string }; token: string } = await admin(`/teams/${teamId}/machines`, {
      name: `Fixture machine ${index}`, identityToken, originId: identity.originId, localMachineId: identity.machineId,
    })
    machines.push(enrollment.machine.id)
    await daemon.registrations.enroll({ serverUrl: backend, machineId: enrollment.machine.id, teamId, token: enrollment.token, originId: identity.originId })
    await until(() => registration(daemon).central.status(), status => status.connected, "authenticated daemon control WebSocket")
    const workspace = await rpc<CatalogWorkspace>(enrollment.machine.id, "workspaceCreate", { name: `Machine ${index}`, directories: [{ path: repository }] })
    workspaces.push(workspace)
    const created = await rpc<AgentProviderConfig>(enrollment.machine.id, "providerCreate", {
      provider: { template: "codex", name: `Remote fixture ${index}`, env: { DESKFLEET_SMOKE_PROFILE: String(index) } },
    })
    const listed: ProviderSnapshot = await rpc(enrollment.machine.id, "providerList", {})
    assert.equal(listed.providers.find(value => value.id === created.id)?.env.DESKFLEET_SMOKE_PROFILE, String(index))
    const snapshot = await rpc<AgentSnapshot>(enrollment.machine.id, "_deskfleet/session/create", {
      workspaceId: workspace.id, provider: created.id, operationId: randomUUID(), context: "worktree", title: `Machine ${index} conversation`,
    })
    assert.equal(snapshot.session.lifecycle, "ready")
    assert.equal(snapshot.session.archiveState, "active")
    sessions.push(snapshot)
  }
  assert.equal(workspaces[0]!.id, workspaces[1]!.id)
  assert.equal(sessions[0]!.session.id, sessions[1]!.session.id, "Independent daemons intentionally allocate equal local IDs")
  assert.notEqual(registration(daemons[0]!).central.status().identity.originId, registration(daemons[1]!).central.status().identity.originId)
  for (const machine of machines) {
    await until(() => admin!<{ sessions: AgentSnapshot[] }>(`/teams/${teamId}/machines/${machine}/sessions`), page => page.sessions.length === 1, "initial Agent history synchronization")
    const replica = await admin!<{ providers: unknown }>(`/teams/${teamId}/machines/${machine}/catalog`)
    assert.ok(!JSON.stringify(replica.providers).includes("DESKFLEET_SMOKE_PROFILE"), "Provider environment values stay on the owning machine")
  }
  await assert.rejects(member(`/teams/${teamId}/machines/${machines[0]}/catalog`), /403/u)
  const invite = await admin<{ token: string }>(`/teams/${teamId}/invites`, { email: bob.user.email, role: "member" })
  await member("/invites/accept", { token: invite.token })
  await rpc(machines[0]!, "catalogList", {}, member)
  await assert.rejects(member(`/teams/${teamId}/machines/${machines[0]}`, undefined, "DELETE"), /403/u)
  console.log("Two API processes: daemon registrations, cross-process control RPC, Provider settings, team authorization, and equal local IDs passed")

  await smokePortForwarding(backend, bob, teamId, machines[0]!)

  const sessionId = sessions[0]!.session.id
  const sessionPath = `/teams/${teamId}/machines/${machines[0]}/sessions/${sessionId}`
  const readCentral = () => member<{ snapshot: AgentSnapshot; lastEventSeq: string }>(sessionPath)
  await until(() => member<{ sessions: AgentSnapshot[] }>(`/teams/${teamId}/machines/${machines[0]}/sessions`), page => page.sessions.some(row => row.session.id === sessionId), "initial Agent history synchronization")
  const agent = await connectBackendPeer({ backend, token: bob.token, teamId, machineId: machines[0]!, purpose: "agent", request: member })
  closePeers.push(agent.close)
  await agent.rpc("_deskfleet/session/subscribe", { sessionId })
  const submitId = randomUUID()
  await agent.rpc("_deskfleet/input/submit", {
    sessionId, operationId: submitId, delivery: "backlog", content: [{ type: "text", text: "WebRTC request from Bob" }],
    actor: { kind: "user", userId: "forged-admin" },
  })
  await until(readCentral, value => value.snapshot.permissions.some(permission => permission.state === "pending"), "real-time prompt and pending approval synchronization")
  await agent.rpc("_deskfleet/input/submit", { sessionId, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Retained backlog" }] })
  const running = await until(readCentral, value => value.snapshot.inputs.length === 2, "backlog synchronization")
  assert.equal(running.snapshot.inputs[0]!.author.userId, bob.user.id)
  assert.deepEqual(running.snapshot.inputs[0]!.author, agent.authorization.actor)
  assert.equal(running.snapshot.inputs[0]!.author.sourceMachine, undefined)
  const { commands } = await member<{ commands: AgentCommand[] }>(`${sessionPath}/commands`)
  assert.equal(commands.find(command => command.operationId === submitId)?.actor.userId, bob.user.id)
  assert.ok(commands.some(command => command.method === "dispatch"))
  const events = await member<{ events: AgentEvent[] }>(`${sessionPath}/events?after=0&limit=200`)
  assert.ok(events.events.some(event => event.kind === "acp" && "update" in event.payload && event.payload.update.sessionUpdate === "tool_call"))
  assert.equal((await member<{ snapshot: AgentSnapshot }>(`/teams/${teamId}/machines/${machines[1]}/sessions/${sessionId}`)).snapshot.inputs.length, 0)
  console.log("Authenticated WebRTC signaling, trusted browser actor, ACP/tool events, audit receipts, and history isolation passed")

  const catalog = await rpc<CatalogSnapshot>(machines[0]!, "catalogList", {})
  const worktree = catalog.workspaces.flatMap(value => value.worktrees).find(value => value.sessionId === sessionId)!
  const cwd = worktree.directories[0]!.path
  await writeFile(join(cwd, "README.md"), "uncommitted smoke changes\n")
  await writeFile(join(cwd, "untracked.txt"), "retained untracked smoke file\n")
  const terminalId = randomUUID()
  await rpc<TerminalSummary>(machines[0]!, "terminalDial", { mode: "create", terminalId, worktreeId: worktree.id, cols: 80, rows: 24 }, member)
  const terminal = await connectBackendPeer({ backend, token: bob.token, teamId, machineId: machines[0]!, purpose: "terminal", request: member })
  closePeers.push(terminal.close)
  await terminal.rpc("attach", { sessionId: terminalId })
  await terminal.rpc("input", { sessionId: terminalId, data: Buffer.from("echo deskfleet-retained-terminal\r").toString("base64") })
  const output = () => terminal.messages.flatMap(message => message.event?.kind === "output" ? [Buffer.from(message.event.data, "base64").toString("utf8")] : []).join("")
  await until(output, text => text.includes("deskfleet-retained-terminal"), "native terminal output over WebRTC")
  const archiveId = randomUUID()
  const archived = await rpc<AgentSnapshot>(machines[0]!, "_deskfleet/session/archive", { sessionId, operationId: archiveId }, member)
  assert.equal(archived.session.archiveState, "archived")
  assert.ok(archived.permissions.every(permission => permission.state !== "pending"))
  assert.equal(archived.inputs[1]!.state, "pending")
  assert.equal((await rpc<TerminalSummary[]>(machines[0]!, "terminalList", {}, member)).find(value => value.id === terminalId)?.status, "interrupted")
  assert.equal(await readFile(join(cwd, "README.md"), "utf8"), "uncommitted smoke changes\n")
  assert.equal(await readFile(join(cwd, "untracked.txt"), "utf8"), "retained untracked smoke file\n")
  await assert.rejects(agent.rpc("_deskfleet/input/submit", { sessionId, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "blocked" }] }), /Restore this Session/u)
  await assert.rejects(rpc(machines[0]!, "terminalDial", { mode: "create", terminalId: randomUUID(), worktreeId: worktree.id, cols: 80, rows: 24 }), /Restore this Session/u)
  const starts = providers[0]!.starts
  const restored = await rpc<AgentSnapshot>(machines[0]!, "_deskfleet/session/restore", { sessionId, operationId: randomUUID() }, member)
  assert.equal(restored.session.archiveState, "active")
  assert.equal(await readFile(join(cwd, "README.md"), "utf8"), "uncommitted smoke changes\n")
  assert.equal(await readFile(join(cwd, "untracked.txt"), "utf8"), "retained untracked smoke file\n")
  assert.equal(providers[0]!.starts, starts)
  assert.equal(providers[0]!.prompts.length, 1)
  assert.match(providers[0]!.prompts[0]!, /^DeskFleet worktree branch naming preference: semantic prefix\./u)
  assert.ok(providers[0]!.prompts[0]!.endsWith("WebRTC request from Bob"))
  assert.equal((await rpc<TerminalSummary>(machines[0]!, "terminalDial", { mode: "resume", terminalId })).status, "interrupted")
  await terminal.rpc("detach", { sessionId: terminalId })
  terminal.messages.length = 0
  await terminal.rpc("attach", { sessionId: terminalId })
  await until(output, text => text.includes("deskfleet-retained-terminal"), "retained terminal history after restore")

  // Default protection retains dirty checkouts, but a clean checkout is reclaimed.
  await writeFile(join(cwd, "README.md"), "machine 0\n")
  await rm(join(cwd, "untracked.txt"))
  const cleaned = await rpc<AgentSnapshot>(machines[0]!, "_deskfleet/session/archive", { sessionId, operationId: randomUUID() }, member)
  assert.equal(cleaned.session.archiveState, "archived")
  await assert.rejects(readdir(cwd), { code: "ENOENT" })
  const recreated = await rpc<AgentSnapshot>(machines[0]!, "_deskfleet/session/restore", { sessionId, operationId: randomUUID() }, member)
  assert.equal(recreated.session.archiveState, "active")
  assert.equal(recreated.inputs[1]!.state, "pending")
  assert.equal(await readFile(join(cwd, "README.md"), "utf8"), "machine 0\n")
  await assert.rejects(readFile(join(cwd, "untracked.txt")), { code: "ENOENT" })
  assert.equal(providers[0]!.starts, starts)
  await until(readCentral, value => value.snapshot.session.archiveState === "active"
    && BigInt(value.lastEventSeq) >= BigInt(recreated.session.lastEventSeq)
    && value.lastEventSeq === value.snapshot.session.lastEventSeq, "complete synchronized archive and restore journal")
  const { commands: audit } = await member<{ commands: AgentCommand[] }>(`${sessionPath}/commands`)
  assert.equal(audit.find(command => command.operationId === archiveId)?.status, "completed")
  assert.ok(audit.find(command => command.operationId === archiveId)?.result)
  console.log("Archive protected dirty checkouts and reclaimed clean ones; restore retained edits or recreated committed files without starting processes")

  // Later machine-removal checks exercise edits made after this restore.
  await writeFile(join(cwd, "README.md"), "uncommitted smoke changes\n")
  await writeFile(join(cwd, "untracked.txt"), "retained untracked smoke file\n")

  const reconnectLogin = await auth.login(backend, { subject: "bob", name: "Bob smoke", email: "bob@example.invalid" })
  const reconnectRequest = client(reconnectLogin)
  const reconnectAgent = await connectBackendPeer({ backend, token: reconnectLogin.token, teamId, machineId: machines[1]!, purpose: "agent", request: reconnectRequest })
  const reconnectTerminal = await connectBackendPeer({ backend, token: reconnectLogin.token, teamId, machineId: machines[1]!, purpose: "terminal", request: reconnectRequest })
  closePeers.push(reconnectAgent.close, reconnectTerminal.close)
  const reconnectSessionId = sessions[1]!.session.id
  const reconnectShell = await rpc<TerminalSummary>(machines[1]!, "terminalDial", { mode: "create", terminalId: randomUUID(), cols: 80, rows: 24 }, member)
  await reconnectAgent.rpc("_deskfleet/session/subscribe", { sessionId: reconnectSessionId })
  await reconnectTerminal.rpc("attach", { sessionId: reconnectShell.id })
  await fixture.stopServer()
  await until(() => daemons.map(daemon => registration(daemon).central.status()), values => values.every(value => !value.connected), "daemon detects central server interruption")
  assert.equal((await readCentral()).snapshot.session.id, sessionId, "The second API process keeps synchronized history readable")
  await reconnectAgent.rpc("_deskfleet/input/submit", { sessionId: reconnectSessionId, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Accepted while signaling is unavailable" }] })
  await reconnectTerminal.rpc("input", { sessionId: reconnectShell.id, data: Buffer.from("echo deskfleet-offline-peer\r").toString("base64") })
  await until(() => reconnectTerminal.messages, values => values.some(value => value.event?.kind === "output" && Buffer.from(value.event.data, "base64").toString("utf8").includes("deskfleet-offline-peer")), "terminal input survives signaling loss")
  assert.equal(providers[1]!.closes, 0)
  await until(() => reconnectAgent.rpc<AgentSnapshot>("_deskfleet/session/subscribe", { sessionId: reconnectSessionId }),
    value => value.inputs.length === 1 && value.inputs[0]!.state === "pending" && !!value.session.turnLimitReason,
    "offline input waits for current Team entitlement authority")
  assert.equal(providers[1]!.prompts.length, 0, "new provider turns require current central authority")
  await fixture.restartServer()
  await until(() => daemons.map(daemon => registration(daemon).central.status()), values => values.every(value => value.connected), "daemon reconnects to restarted server")
  const secondCentral = () => member<{ snapshot: AgentSnapshot; lastEventSeq: string }>(`/teams/${teamId}/machines/${machines[1]}/sessions/${reconnectSessionId}`)
  const paused = await until(secondCentral, value => value.snapshot.inputs.length === 1
    && value.snapshot.inputs[0]!.state === "pending" && !!value.snapshot.session.turnLimitReason, "paused offline journal catches up after reconnect")
  assert.equal(providers[1]!.prompts.length, 0, "reconnection does not automatically resume paused input")
  await reconnectAgent.rpc("_deskfleet/input/retry", {
    sessionId: reconnectSessionId, inputId: paused.snapshot.inputs[0]!.id, operationId: randomUUID(),
  })
  await until(secondCentral, value => value.snapshot.permissions.some(permission => permission.state === "pending"), "explicit retry resumes the original queued input")
  assert.equal(providers[1]!.prompts.length, 1)
  assert.match(providers[1]!.prompts[0]!, /^DeskFleet worktree branch naming preference: semantic prefix\./u)
  assert.ok(providers[1]!.prompts[0]!.endsWith("Accepted while signaling is unavailable"))
  assert.ok((await reconnectAgent.rpc<{ id: string }[]>("_deskfleet/session/list", {})).some(value => value.id === reconnectSessionId))
  await reconnectRequest("/auth/logout", {})
  await until(() => [reconnectAgent.disconnected(), reconnectTerminal.disconnected()], values => values.every(Boolean), "logout revokes established peer access")
  await assert.rejects(reconnectAgent.rpc("_deskfleet/session/list", {}), /closed/u)
  assert.equal(providers[1]!.closes, 0, "Revoking access must preserve the accepted Agent task")
  assert.equal(registration(daemons[1]!).terminals.list().find(value => value.id === reconnectShell.id)?.status, "running", "Revoking access must preserve the shell")
  assert.ok((await secondCentral()).snapshot.permissions.some(permission => permission.state === "pending"))
  console.log("Established Agent/Terminal peers survive server interruption and restart; logout revokes access without terminating accepted work")

  // A blocked management RPC must be released by provider shutdown, before the
  // control link waits for its handler to finish.
  providers[1]!.blockNextCreation = true
  const creating = rpc(machines[1]!, "_deskfleet/session/create", {
    workspaceId: workspaces[1]!.id, provider: sessions[1]!.session.provider, operationId: randomUUID(), context: "directory",
  }).catch(() => {})
  await until(() => providers[1]!.blockedCreations, value => value === 1, "blocked provider session creation")
  let stopped = false
  const stopping = daemons[1]!.close().then(() => { stopped = true })
  await until(() => stopped, Boolean, "shutdown releases a pending provider RPC", 5_000)
  await Promise.all([stopping, creating])

  // Shut down immediately after acceptance, before the coalesced upload timer.
  await agent.rpc("_deskfleet/input/submit", { sessionId, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Final accepted input before daemon shutdown" }] })
  await daemons[0]!.close()
  for (const close of closePeers) await close()
  console.log("Shutdown releases blocked control RPCs and flushes the final durable history")
  await until(() => member<{ id: string; online: boolean }[]>(`/teams/${teamId}/machines`), values => values.every(value => !value.online), "offline machine presence")
  const offline = await readCentral()
  assert.equal(offline.snapshot.inputs.length, 3)
  assert.ok(offline.snapshot.runs.every(run => run.state !== "running"))
  assert.ok(offline.snapshot.permissions.every(permission => permission.state !== "pending"))
  const offlineEvents = await member<{ events: AgentEvent[] }>(`${sessionPath}/events?after=0&limit=200`)
  assert.ok(offlineEvents.events.length)
  assert.ok(!JSON.stringify({ offline, offlineEvents }).includes("deskfleet-retained-terminal"), "Terminal bytes never enter central Agent history")
  assert.equal((await member<{ snapshot: AgentSnapshot }>(`/teams/${teamId}/machines/${machines[1]}/sessions/${sessionId}`)).snapshot.inputs.length, 1)
  await assert.rejects(rpc(machines[0]!, "_deskfleet/session/archive", { sessionId, operationId: randomUUID() }), /503/u)
  assert.equal((await readCentral()).snapshot.session.archiveState, "active")
  console.log("Offline Agent history remains readable, terminal output stays local, and offline archive is rejected")

  const hostDirectory = join(directory, "daemon-0")
  daemons[0] = await startDaemon(0, { controlDirectory: hostDirectory, agentProvider: providers[0], requestScreenCaptureAccess: async () => false, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  const oldOrigin = registration(daemons[0]!).central.status().identity.originId
  await until(() => registration(daemons[0]!).central.status(), value => value.connected, "machine restarts before removal")
  const secondTeam = await admin<{ id: string }>("/teams", { name: `Shared host ${randomUUID()}` })
  additionalTeams.push(secondTeam.id)
  const secondScope = { serverUrl: backend, teamId: secondTeam.id }
  const otherPrepared = await daemons[0]!.registrations.prepareEnrollment(secondScope)
  const otherEnrollment = await admin<{ machine: { id: string }; token: string }>(`/teams/${secondTeam.id}/machines`, {
    name: "Same host in another Team", identityToken: otherPrepared.identityToken,
    originId: otherPrepared.identity.originId, localMachineId: otherPrepared.identity.machineId,
  })
  assert.equal(otherEnrollment.machine.id, machines[0], "One public Machine ID is shared across Teams")
  await daemons[0]!.registrations.enroll({ ...secondScope, machineId: otherEnrollment.machine.id, token: otherEnrollment.token, originId: otherPrepared.identity.originId })
  const secondRegistration = () => daemons[0]!.registrations.forTeam(secondScope)
  await until(() => secondRegistration().central.status(), value => value.connected, "second Team connects without replacing first Team")
  assert.equal(registration(daemons[0]!).central.status().connected, true)
  const secondRpc = <T>(method: string, params: unknown) => admin!<T>(`/teams/${secondTeam.id}/machines/${machines[0]}/rpc`, { method, params })
  const secondProvider = await secondRpc<AgentProviderConfig>("providerCreate", { provider: { template: "codex", name: "Second Team", env: {} } })
  const secondSession = await secondRpc<AgentSnapshot>("_deskfleet/session/create", { provider: secondProvider.id, operationId: randomUUID(), context: "directory", title: "Second Team only" })
  assert.equal(secondSession.session.id, sessionId, "Two Team catalogs may allocate the same local Session ID")
  const secondSessionsPath = `/teams/${secondTeam.id}/machines/${machines[0]}/sessions`
  await until(() => admin!<{ sessions: AgentSnapshot[] }>(secondSessionsPath), page => page.sessions.some(value => value.session.id === sessionId && value.session.title === "Second Team only"), "second Team history synchronization")
  const secondHistoryPath = `${secondSessionsPath}/${sessionId}`
  assert.equal((await admin!<{ snapshot: AgentSnapshot }>(secondHistoryPath)).snapshot.session.title, "Second Team only")
  await assert.rejects(member(secondHistoryPath), /403/u)
  assert.equal((await readCentral()).snapshot.inputs.length, 3)
  await admin(`/teams/${teamId}/machines/${machines[0]}`, undefined, "DELETE")
  await until(() => registration(daemons[0]!).central.status(), value => value.revoked, "only the removed Team registration is revoked")
  assert.equal(secondRegistration().central.status().connected, true)
  assert.equal((await secondRpc<CatalogSnapshot>("catalogList", {})).sessions.some(value => value.sessionId === sessionId), true)
  const host = await DaemonClient.connect(() => {}, () => {}, hostDirectory)
  try {
    const scope = { serverUrl: backend, teamId }
    const prepared = await host.call("centralPrepareEnrollment", scope)
    assert.equal(prepared.identity.originId, oldOrigin)
    assert.equal(prepared.configured, true)
    assert.equal(prepared.revoked, true)
    assert.equal((await host.call("centralPrepareEnrollment", scope)).identity.originId, oldOrigin)
    const enrollment = await admin<{ machine: { id: string }; token: string }>(`/teams/${teamId}/machines`, {
      name: "Re-enrolled machine", identityToken: prepared.identityToken,
      originId: oldOrigin, localMachineId: prepared.identity.machineId,
    })
    assert.equal(enrollment.machine.id, machines[0])
    await host.call("centralEnroll", { ...scope, machineId: enrollment.machine.id, token: enrollment.token, originId: oldOrigin })
    await until(() => registration(daemons[0]!).central.status(), value => value.connected, "same registration rejoins its Team")
    const catalog = await rpc<CatalogSnapshot>(enrollment.machine.id, "catalogList", {})
    assert.equal(catalog.workspaces.length, 1)
    assert.equal((await readCentral()).snapshot.inputs.length, 3)
    assert.equal((await host.call("centralPrepareEnrollment", scope)).identity.originId, oldOrigin)
    await assert.rejects(admin(`/teams/${teamId}/machines`, { name: "Duplicate", identityToken: prepared.identityToken, originId: oldOrigin, localMachineId: prepared.identity.machineId }), /409/u)
  } finally { host.close() }
  assert.equal(await readFile(join(cwd, "untracked.txt"), "utf8"), "retained untracked smoke file\n")
  const retainedGit = await execute("git", ["-C", cwd, "status", "--porcelain"])
  assert.match(retainedGit.stdout, /README\.md/u)
  assert.match(retainedGit.stdout, /untracked\.txt/u)
  await daemons[0]!.close()
  daemons[0] = await startDaemon(0, { controlDirectory: hostDirectory, agentProvider: providers[0], requestScreenCaptureAccess: async () => false, requestAccessibilityAccess: async () => null, requestFullDiskAccess: async () => null })
  assert.equal(registration(daemons[0]!).central.status().identity.originId, oldOrigin)
  await until(() => daemons[0]!.registrations.status().registrations, values => values.length === 2 && values.every(value => value.connected), "all Team registrations reconnect after one daemon restart")
  console.log("One daemon shares a stable Machine ID across Teams, isolates same-ID Sessions, rejects duplicate registration, and restores retained history after Team removal and restart")
} catch (error) {
  if (fixture.diagnostics()) console.error(fixture.diagnostics())
  if (httpFixture?.diagnostics()) console.error(httpFixture.diagnostics())
  throw error
} finally {
  await Promise.allSettled(closePeers.map(close => close()))
  await Promise.allSettled(daemons.map(daemon => daemon.close()))
  if (admin) {
    for (const machine of machines) await admin(`/teams/${teamId}/machines/${machine}`, undefined, "DELETE").catch(() => {})
    for (const otherTeam of additionalTeams) {
      await admin(`/teams/${otherTeam}/machines/${machines[0]}`, undefined, "DELETE").catch(() => {})
      await admin(`/teams/${otherTeam}`, undefined, "DELETE").catch(() => {})
    }
    if (teamId) await admin(`/teams/${teamId}`, undefined, "DELETE").catch(() => {})
  }
  await Promise.all([fixture.close(), httpFixture?.close()])
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
