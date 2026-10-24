import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { CatalogSnapshot, CatalogWorkspace } from "../crates/node/index.ts"
import { startDaemon } from "../apps/daemon/src/daemon.ts"
import type { AgentCommand, AgentEvent, AgentSnapshot } from "../apps/daemon/src/agent-protocol.ts"
import type { AgentProviderConfig, ProviderSnapshot } from "../apps/daemon/src/provider-protocol.ts"
import type { TerminalSummary } from "../apps/daemon/src/terminal-protocol.ts"
import { BackendAgent } from "./fixtures/backend-agent.ts"
import { connectBackendPeer, until, type BackendRequest } from "./fixtures/backend-peer.ts"
import type { FixtureLogin } from "./fixtures/backend-oidc.ts"
import { startBackendFixture } from "./fixtures/backend-server.ts"

const fixture = await startBackendFixture()
const { backend, oidc } = fixture
const directory = await mkdtemp(join(tmpdir(), "deskfleet-backend-smoke-"))
const execute = promisify(execFile)
const daemons: Awaited<ReturnType<typeof startDaemon>>[] = []
const closePeers: (() => Promise<void>)[] = []
const machines: string[] = []
let admin: BackendRequest | undefined
let teamId: string | undefined

function client(login: FixtureLogin): BackendRequest {
  return async <T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> => {
    const response = await fetch(`${backend}/api${path}`, {
      method, headers: { authorization: `Bearer ${login.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return JSON.parse(text) as T
  }
}

try {
  const alice = await oidc.login(backend, { subject: "alice", name: "Alice smoke", email: "alice@example.invalid" })
  const bob = await oidc.login(backend, { subject: "bob", name: "Bob smoke", email: "bob@example.invalid" })
  admin = client(alice)
  const member = client(bob)
  assert.deepEqual(oidc.exchanges, ["alice", "bob"])
  assert.equal((await admin<{ user: { id: string } }>("/me")).user.id, alice.user.id)
  const team = await admin<{ id: string; role: string }>("/teams", { name: `Backend smoke ${randomUUID()}` })
  teamId = team.id
  assert.equal(team.role, "admin")
  console.log("OIDC discovery, RS256, PKCE, nonce, and application login passed")

  const providers: BackendAgent[] = []
  const workspaces: CatalogWorkspace[] = []
  const sessions: AgentSnapshot[] = []
  const rpc = <T>(machineId: string, method: string, params: unknown, request: BackendRequest = admin!): Promise<T> => request<T>(`/machines/${machineId}/rpc`, { method, params })
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
    const daemon = await startDaemon(0, { controlDirectory, agentProvider: provider, requestScreenCaptureAccess: async () => false })
    daemons.push(daemon)
    const { identity } = daemon.central.status()
    const enrollment: { machine: { id: string }; token: string } = await admin(`/teams/${teamId}/machines`, {
      name: `Fixture machine ${index}`, originId: identity.originId, localMachineId: identity.machineId,
    })
    machines.push(enrollment.machine.id)
    await daemon.central.enroll({ serverUrl: backend, machineId: enrollment.machine.id, teamId, token: enrollment.token })
    await until(() => daemon.central.status(), status => status.connected, "authenticated daemon control WebSocket")
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
  assert.notEqual(daemons[0]!.central.status().identity.originId, daemons[1]!.central.status().identity.originId)
  for (const machine of machines) {
    await until(() => admin!<{ sessions: AgentSnapshot[] }>(`/machines/${machine}/sessions`), page => page.sessions.length === 1, "initial Agent history synchronization")
    const replica = await admin!<{ providers: unknown }>(`/machines/${machine}/catalog`)
    assert.ok(!JSON.stringify(replica.providers).includes("DESKFLEET_SMOKE_PROFILE"), "Provider environment values stay on the owning machine")
  }
  await assert.rejects(member(`/machines/${machines[0]}/catalog`), /403/u)
  const invite = await admin<{ token: string }>(`/teams/${teamId}/invites`, { email: bob.user.email, role: "member" })
  await member("/invites/accept", { token: invite.token })
  await rpc(machines[0]!, "catalogList", {}, member)
  await assert.rejects(member(`/machines/${machines[0]}`, undefined, "DELETE"), /403/u)
  console.log("Two daemon registrations, control RPC, Provider settings, team authorization, and equal local IDs passed")

  const sessionId = sessions[0]!.session.id
  const sessionPath = `/machines/${machines[0]}/sessions/${sessionId}`
  const readCentral = () => member<{ snapshot: AgentSnapshot; lastEventSeq: string }>(sessionPath)
  await until(() => member<{ sessions: AgentSnapshot[] }>(`/machines/${machines[0]}/sessions`), page => page.sessions.some(row => row.session.id === sessionId), "initial Agent history synchronization")
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
  assert.equal((await member<{ snapshot: AgentSnapshot }>(`/machines/${machines[1]}/sessions/${sessionId}`)).snapshot.inputs.length, 0)
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
  await assert.rejects(rpc(machines[0]!, "_deskfleet/session/delete", { sessionId, operationId: randomUUID() }), /400|403/u)
  const starts = providers[0]!.starts
  const restored = await rpc<AgentSnapshot>(machines[0]!, "_deskfleet/session/restore", { sessionId, operationId: randomUUID() }, member)
  assert.equal(restored.session.archiveState, "active")
  assert.equal(providers[0]!.starts, starts)
  assert.deepEqual(providers[0]!.prompts, ["WebRTC request from Bob"])
  assert.equal((await rpc<TerminalSummary>(machines[0]!, "terminalDial", { mode: "resume", terminalId })).status, "interrupted")
  await terminal.rpc("detach", { sessionId: terminalId })
  terminal.messages.length = 0
  await terminal.rpc("attach", { sessionId: terminalId })
  await until(output, text => text.includes("deskfleet-retained-terminal"), "retained terminal history after restore")
  await until(readCentral, value => value.snapshot.session.archiveState === "active"
    && BigInt(value.lastEventSeq) >= BigInt(restored.session.lastEventSeq)
    && value.lastEventSeq === value.snapshot.session.lastEventSeq, "complete synchronized archive and restore journal")
  const { commands: audit } = await member<{ commands: AgentCommand[] }>(`${sessionPath}/commands`)
  assert.equal(audit.find(command => command.operationId === archiveId)?.status, "completed")
  assert.ok(audit.find(command => command.operationId === archiveId)?.result)
  console.log("Archive/restore retained files, backlog, audit, and terminal transcript; live processes remain stopped")

  for (const close of closePeers) await close()
  for (const daemon of daemons) await daemon.close()
  await until(() => member<{ id: string; online: boolean }[]>(`/teams/${teamId}/machines`), values => values.every(value => !value.online), "offline machine presence")
  const offline = await readCentral()
  assert.equal(offline.snapshot.inputs.length, 2)
  const offlineEvents = await member<{ events: AgentEvent[] }>(`${sessionPath}/events?after=0&limit=200`)
  assert.ok(offlineEvents.events.length)
  assert.ok(!JSON.stringify({ offline, offlineEvents }).includes("deskfleet-retained-terminal"), "Terminal bytes never enter central Agent history")
  assert.equal((await member<{ snapshot: AgentSnapshot }>(`/machines/${machines[1]}/sessions/${sessionId}`)).snapshot.inputs.length, 0)
  await assert.rejects(rpc(machines[0]!, "_deskfleet/session/archive", { sessionId, operationId: randomUUID() }), /503/u)
  assert.equal((await readCentral()).snapshot.session.archiveState, "active")
  console.log("Offline Agent history remains readable, terminal output stays local, and offline archive is rejected")
} catch (error) {
  if (fixture.diagnostics()) console.error(fixture.diagnostics())
  throw error
} finally {
  await Promise.allSettled(closePeers.map(close => close()))
  await Promise.allSettled(daemons.map(daemon => daemon.close()))
  if (admin) {
    for (const machine of machines) await admin(`/machines/${machine}`, undefined, "DELETE").catch(() => {})
    if (teamId) await admin(`/teams/${teamId}`, undefined, "DELETE").catch(() => {})
  }
  await fixture.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
