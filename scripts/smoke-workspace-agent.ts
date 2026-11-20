/** Live local smoke. Use a disposable TEST_DATABASE_URL and signed-in local providers. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { startDaemon } from "../apps/daemon/src/daemon.ts"
import { DaemonClient } from "../apps/daemon/src/control-client.ts"
import type { AgentReceipt, AgentSnapshot } from "../apps/daemon/src/agent-protocol.ts"
import type { SuperSnapshot } from "../apps/daemon/src/super-agent-protocol.ts"
import { startBackendFixture } from "./fixtures/backend-server.ts"

const root = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-live-front-")))
const fixture = await startBackendFixture()
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
let client: DaemonClient | undefined
try {
  const account = await fixture.auth.login(fixture.backend, { subject: randomUUID(), name: "Workspace smoke", email: "workspace@example.invalid" })
  async function request<T>(path: string, body: unknown): Promise<T> {
    const result = await fetch(`${fixture.backend}/api${path}`, { method: "POST", headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    assert.ok(result.ok, `HTTP ${result.status} on ${path}: ${await result.clone().text()}`)
    return await result.json() as T
  }
  const team = await request<{id: string}>("/teams", { name: "Isolated workspace smoke" })
  const controlDirectory = join(root, "daemon")
  daemon = await startDaemon(0, { controlDirectory,
    ...(process.argv.includes("--fixed-route") ? { superRoute: async (ctx: { text: string }) => ({
      reason: "Fixed test coordinator", actions: [{ kind: "create" as const, title: "Synthetic file", scope: ctx.text, prompt: ctx.text }],
    }) } : {}),
    requestScreenCaptureAccess: async () => false, requestAccessibilityAccess: async () => false, requestFullDiskAccess: async () => null })
  const target = { serverUrl: fixture.backend, teamId: team.id }
  const { identity, identityToken } = await daemon.registrations.prepareEnrollment(target)
  const enrollment = await request<{machine: {id: string}; token: string}>(`/teams/${team.id}/machines`, { name: "Smoke Mac", identityToken, originId: identity.originId, localMachineId: identity.machineId })
  const machineId = enrollment.machine.id
  await daemon.registrations.enroll({ ...target, machineId, token: enrollment.token, originId: identity.originId })
  const deadline = Date.now() + 30_000
  while (!daemon.registrations.forTeam(target).central.status().connected) { assert.ok(Date.now() < deadline, "registration connection"); await delay(75) }
  const manage = <T>(method: string, params: unknown) => request<T>(`/teams/${team.id}/machines/${machineId}/rpc`, {method, params})
  const grant = await request<{ peerId: string; token: string }>("/peers/local", { teamId: team.id, machineId, purpose: "agent" })
  const replies = new Map<number, {result?: unknown; error?: {message: string}}>()
  let pending = Buffer.alloc(0), id = 0
  client = await DaemonClient.connect(event => {
    if (event.kind !== "localChannelMessage") return
    void client!.call("localAck", { peerId: event.peerId, sequence: event.sequence }).catch(() => {})
    pending = Buffer.concat([pending, Buffer.from(event.data, "base64")])
    let n
    while ((n = pending.indexOf(10)) !== -1) {
      const record = JSON.parse(pending.subarray(0, n).toString())
      if (typeof record.id === "number") replies.set(record.id, record)
      pending = pending.subarray(n+1)
    }
  }, () => {}, controlDirectory)
  await client.call("localOpen", { teamId: team.id, machineId, peerId: grant.peerId, token: grant.token })
  async function call<T>(method: string, params: unknown): Promise<T> {
    const requestId = ++id
    const data = Buffer.from(JSON.stringify({jsonrpc:"2.0", id: requestId, method, params}) + "\n").toString("base64")
    await client!.call("localSend", {peerId: grant.peerId, isString: false, data})
    const deadline = Date.now() + 45_000
    while (!replies.has(requestId)) { assert.ok(Date.now() < deadline, method); await delay(30) }
    const reply = replies.get(requestId)!
    replies.delete(requestId)
    if (reply.error) throw Error(reply.error.message)
    return reply.result as T
  }
  await call("initialize", {protocolVersion:1})
  const initial = await call<SuperSnapshot>("_deskfleet/super-agent/snapshot", { workspaceId: null })
  assert.equal(initial.messages.length, 0)
  console.log("Verified real login, local grant and private empty front desk")
  for (const name of ["A", "B"]) {
    const path = join(root, name)
    await mkdir(path)
    await writeFile(join(path, "example.txt"), "deskfleet synthetic fixture\n")
  }
  const entry = await manage<{id:string}>("workspaceCreate", {name:"A", directories:[{path:join(root,"A")}]})
  await manage("workspaceCreate", {name:"B", directories:[{path:join(root,"B")}]})
  const providers = new Map<string, string>()
  const workerTemplates = process.argv.includes("--workers") ? ["codex", "claude-code"]
    : [process.argv.includes("--claude") ? "claude-code" : "codex"]
  const templates = new Set(workerTemplates)
  if (process.argv.includes("--codex-router") || process.argv.includes("--journey")) templates.add("codex")
  for (const template of templates) {
    const input = await manage<{id:string}>("providerCreate", {provider:{template, name:template, inheritShellEnvironment:false, env:{}}})
    providers.set(template, input.id)
  }
  const front = (method: string, params: object) => call<SuperSnapshot>(`_deskfleet/super-agent/${method}`, {workspaceId:entry.id,...params})
  if (process.argv.includes("--codex-router")) await front("settings", { coordinator: providers.get("codex")! })
  if (process.argv.includes("--journey")) {
    const codex = providers.get("codex")!
    await front("settings", { provider: codex, coordinator: codex })
    const origin = (method: string, params: object) => call<SuperSnapshot>(`_deskfleet/super-agent/${method}`, { workspaceId: null, ...params })
    async function waitFor(read: () => Promise<SuperSnapshot>, condition: (state: SuperSnapshot) => boolean, label: string) {
      const limit = Date.now() + 210_000
      for (;;) {
        const state = await read()
        const problem = state.messages.findLast(m => m.reason && (m.state === "failed" || m.state === "uncertain"))
        if (problem) throw Error(`${label}: ${problem.reason}`)
        if (state.tickets.some(t => t.status === "blocked" || t.status === "attention")) {
          throw Error(`${label}: ${state.messages.findLast(m => m.role !== "user")?.text}`)
        }
        if (condition(state)) return state
        assert.ok(Date.now() < limit, `${label} timed out: ${state.messages.map(m => [m.role,m.state,m.text.slice(0,140)]).slice(-3).map(row => JSON.stringify(row)).join(" ")}`)
        await delay(500)
      }
    }
    const query = randomUUID()
    await origin("send", { messageId: query, text: "请查 A 项目目录中的 example.txt，原样告诉我第一行，并注明文件来源。只读。" })
    const readOnly = await waitFor(() => origin("snapshot", {}), state => state.messages.some(m => m.role === "assistant" && m.text.includes("deskfleet synthetic fixture")), "cross-project read")
    assert.equal(readOnly.tickets.length, 0)
    assert.equal((await front("snapshot", {})).messages.length, 0)
    console.log("Default: real read of A/example.txt with no task created")
    const writeId = randomUUID()
    const original = "请在 A 项目的根目录创建 result.txt，文件内容写成 PASSED。这条是执行委托，请直接修改。"
    await origin("send", {messageId:writeId, text:original})
    await origin("send", {messageId:writeId, text:original})
    const source = await waitFor(() => origin("snapshot", {}), state => state.messages.some(m => m.id === writeId && m.targetWorkspaceId === entry.id), "ownership transfer")
    assert.equal(source.messages.filter(m=>m.id===writeId).length,1)
    const completed = await waitFor(() => front("snapshot",{}), state => {
      const request = state.messages.find(m => m.role === "user" && m.sourceMessageId === writeId)
      return !!request?.ticketId && state.messages.some(m => m.workerEvent === "result" && m.sourceMessageId === request.id && m.ticketId === request.ticketId)
    }, "real first worker turn")
    assert.equal(completed.messages.filter(m=>m.text===original && m.role==="user").length, 1)
    assert.equal(completed.tickets.length, 1)
    assert.equal((await readFile(join(root,"A","result.txt"),"utf8")).trim(),"PASSED")
    const ticket = completed.tickets[0]!
    assert.ok(ticket.sessionId)
    console.log("Handoff: original preserved; one ticket, one Codex Session; file verified")
    const follow = randomUUID()
    const before = await call<AgentSnapshot>("_deskfleet/session/subscribe", {sessionId:ticket.sessionId})
    const precedingTurns = new Set(before.turns.map(t=>t.id))
    await front("send", {messageId:follow, text:"接着改刚才的 result.txt，保留原第一行，并在第二行写 NEXT。"})
    await waitFor(() => front("snapshot",{}), state => state.messages.some(m=>m.id===follow && m.ticketId===ticket.id)
        && state.messages.some(m=>m.workerEvent==="result" && m.ticketId===ticket.id && m.sourceMessageId===follow && !!m.turnId), "unquoted follow-up")
    // Require the specific new journal input and turn. A ticket can have more than one worker event.
    const until = Date.now()+120_000
    for (;;) {
      const actual = await call<AgentSnapshot>("_deskfleet/session/subscribe", {sessionId:ticket.sessionId})
      const nextInput = actual.inputs.find(i=>i.content.some(block=>block.type==="text" && block.text.includes("第二行写 NEXT")))
      const turn = actual.turns.find(t=>t.id===nextInput?.turnId && !precedingTurns.has(t.id))
      if (turn?.state === "completed") break
      if ((turn && ["cancelled","failed","interrupted"].includes(turn.state)) || Date.now()>until) {
        throw Error(`Unquoted follow-up did not complete its own turn: ${turn?.state}, input ${nextInput?.state}`)
      }
      await delay(500)
    }
    const contents = await readFile(join(root,"A","result.txt"),"utf8")
    if (contents.trim() !== "PASSED\nNEXT") {
      const diagnostic = await front("snapshot",{})
      console.log("Synthetic follow-up", diagnostic.messages.slice(-6).map(m=>[m.role,m.state,m.reason,m.text.slice(-600)]))
    }
    assert.equal(contents.trim(),"PASSED\nNEXT")
    const final = await front("snapshot",{})
    assert.equal(final.tickets.length,1)
    assert.equal(final.tickets[0]?.sessionId,ticket.sessionId)
    console.log("Follow-up: unquoted message continued the original ticket and session; second edit verified")
  } else if (process.argv.includes("--workers")) {
    const runs = [...providers].map(async ([template, provider]) => {
      const registered = await manage<AgentSnapshot>("_deskfleet/session/create", { operationId: randomUUID(), workspaceId:entry.id, provider, context:"directory", title:`Live ${template}`, deferStartup:true })
      const sessionId = registered.session.id
      const receipt = await call<AgentReceipt>("_deskfleet/input/submit", { sessionId, operationId:randomUUID(), delivery:"backlog", content:[{type:"text",text:"Reply with exactly DESKFLEET_TEST_OK. Do not use tools or change any files."}] })
      console.log(template, "receipt", receipt.commandId, "session", sessionId, "input", receipt.inputId)
      const limit = Date.now() + 150_000
      while (Date.now() < limit) {
        const snapshot = await call<AgentSnapshot>("_deskfleet/session/subscribe", {sessionId})
        const turn = snapshot.turns.at(-1)
        if (turn && ["completed","failed","cancelled","interrupted"].includes(turn.state)) {
          console.log(template, "turn", turn.id, turn.state)
          assert.equal(turn.state, "completed", turn.error)
          return
        }
        if (snapshot.inputs.some(input => input.error)) throw Error(`${template} ${snapshot.inputs.find(input=>input.error)?.error}`)
        await delay(1200)
      }
      throw Error(`${template} timed out waiting for a completed turn`)
    })
    const results = await Promise.allSettled(runs)
    for (const result of results) if (result.status === "rejected") console.error(String(result.reason).slice(0,350))
    assert.ok(results.every(r=>r.status==="fulfilled"), "both providers must finish")
  } else {
    const template = process.argv.includes("--claude") ? "claude-code" : "codex"
    await front("settings", {provider: providers.get(template)})
    const messageId = randomUUID()
    const text = "Create a file named result.txt in this workspace with only the word PASSED. Execute this using the default worker."
    await front("send", {messageId, text})
    await front("send", {messageId, text})
    const limit = Date.now() + 190_000
    for (;;) {
      const state = await front("snapshot", {})
      assert.equal(state.messages.filter(m=>m.id===messageId).length, 1)
      const ticket = state.tickets[0]
      const user = state.messages.find(m=>m.id===messageId)!
      if (user.state === "failed" || ticket?.status === "blocked") throw Error(user.reason || state.messages.findLast(m=>m.role !== "user")?.text || ticket?.summary || "Routing failed")
      if (ticket?.status === "attention") throw Error("Worker requires manual permission in its original session")
      if (ticket && state.messages.some(m => m.workerEvent === "result" && m.sourceMessageId === messageId && m.ticketId === ticket.id)) {
        assert.equal((await readFile(join(root,"A","result.txt"),"utf8")).trim(),"PASSED")
        console.log(template,"front desk, exactly one task, durable result and filesystem change passed")
        break
      }
      assert.ok(Date.now()<limit, "live front desk timed out")
      await delay(1200)
    }
  }
} finally {
  client?.close()
  try { await daemon?.close() } finally { await fixture.close(); await rm(root,{recursive:true,force:true}) }
}
