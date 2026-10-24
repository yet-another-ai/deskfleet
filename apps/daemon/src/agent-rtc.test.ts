import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { createPeer, type NativePeer, type PeerEvent } from "@deskfleet/native"
import { AgentChannel, type AgentChannelSessions } from "./agent-channel.ts"
import { AGENT_CHANNEL, type AgentActor, type AgentEvent, type AgentMethod, type AgentPermission, type AgentSnapshot } from "./agent-protocol.ts"

type Message = { id?: string | number; method?: string; params?: any; result?: any; error?: unknown }
const createdAt = "2026-10-23T00:00:00Z"
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** The real Session/journal decision transaction is covered by agent-sessions.test.ts. */
class Sessions implements AgentChannelSessions {
  readonly journal = { identity: { originId: "test-origin", machineId: "1" } }
  readonly listeners = new Set<(event: AgentEvent) => void>()
  readonly decisions: { actor: AgentActor; params: { operationId: string; permissionId: string; optionId: string } }[] = []
  readonly permissions: AgentPermission[] = []
  readonly waiting = new Map<string, ReturnType<typeof deferred<string>>>()
  sequence = 0
  onEvent(listener: (event: AgentEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async handle(method: AgentMethod, params: any, actor: AgentActor): Promise<unknown> {
    if (method === "_deskfleet/session/list") return [{ deviceId: actor.deviceId }]
    if (method === "_deskfleet/session/subscribe") return {
      session: { id: "1", workspaceId: "1", title: "Transport fixture", provider: "fixture", context: "worktree", lifecycle: "ready", createdAt, updatedAt: createdAt, lastEventSeq: String(this.sequence) },
      runs: [], inputs: [], turns: [], permissions: this.permissions.map(permission => ({ ...permission })), elicitations: [],
    } satisfies AgentSnapshot
    if (method === "_deskfleet/permission/respond") {
      this.decisions.push({ actor, params })
      const permission = this.permissions.find(permission => permission.id === params.permissionId)!
      if (permission.state !== "pending") return permission
      permission.state = "resolved"
      permission.optionId = params.optionId
      permission.actor = actor
      this.emit(permission)
      this.waiting.get(permission.id)!.resolve(params.optionId)
      return permission
    }
    throw new Error(`Unexpected operation: ${method}`)
  }
  requestPermission(): Promise<string> {
    const permission: AgentPermission = {
      id: randomUUID(), sessionId: "1", runGeneration: 1, state: "pending", createdAt,
      request: { sessionId: "fixture-provider", toolCall: { toolCallId: "tool", title: "写文件 🌍" }, options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" },
      ] },
    }
    const response = deferred<string>()
    this.permissions.push(permission)
    this.waiting.set(permission.id, response)
    this.emit(permission)
    return response.promise
  }
  emit(permission: AgentPermission): void {
    const event: AgentEvent = { sessionId: "1", seq: String(++this.sequence), kind: "permission", payload: { ...permission }, createdAt }
    for (const listener of this.listeners) listener(event)
  }
}

async function connect(sessions: Sessions, deviceId: string, register: (close: () => Promise<void>) => void) {
  const [client, daemon] = await Promise.all([createPeer({}), createPeer({})])
  const identity: AgentActor = { kind: "user", userId: "fixture-user", deviceId, sourceMachine: { originId: `origin-${deviceId}`, id: "1" } }
  const errors: unknown[] = []
  const messages: Message[] = []
  const opened = [deferred<void>(), deferred<void>()]
  let buffer = Buffer.alloc(0)
  let closed = false
  const channel = new AgentChannel(sessions, identity, bytes => daemon.sendData(AGENT_CHANNEL, Buffer.from(bytes)), error => errors.push(error))
  const pumps: Promise<void>[] = []
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    channel.close()
    await Promise.all([client.close(), daemon.close()])
    await Promise.all(pumps)
  }
  register(close)
  async function consume(source: NativePeer, target: NativePeer, side: number): Promise<void> {
    for (;;) {
      const event: PeerEvent | null = await source.nextEvent()
      if (!event) return
      if (event.kind === "iceCandidate") await target.addIceCandidate(event.candidate!)
      if (event.kind === "dataChannelOpen") opened[side]!.resolve()
      if (event.kind === "data") {
        assert.equal(event.isString, false)
        if (side === 1) channel.receive(event.data!, event.isString)
        else {
          buffer = Buffer.concat([buffer, event.data!])
          for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
            messages.push(JSON.parse(buffer.subarray(0, newline).toString("utf8")))
            buffer = buffer.subarray(newline + 1)
          }
        }
      }
      if (event.kind === "error") throw new Error(event.error!)
    }
  }
  await client.createDataChannel(AGENT_CHANNEL)
  const offer = await client.createOffer()
  await client.acceptAnswer(await daemon.answerOffer(offer))
  for (const [source, target, side] of [[client, daemon, 0], [daemon, client, 1]] as const) {
    pumps.push(consume(source, target, side).catch(error => {
      if (closed) return
      errors.push(error)
      for (const ready of opened) ready.reject(error)
    }))
  }
  await Promise.all(opened.map(value => value.promise))
  async function send(message: Message): Promise<void> { await client.sendData(AGENT_CHANNEL, Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")) }
  async function waitFor(predicate: (message: Message) => boolean): Promise<Message> {
    for (let attempt = 0; attempt < 1_000; attempt++) {
      if (errors.length) throw errors[0]
      const message = messages.find(predicate)
      if (message) return message
      await delay(5)
    }
    throw new Error("Timed out waiting for native Agent DataChannel")
  }
  await send({ id: "initialize", method: "initialize", params: { protocolVersion: 1 } })
  assert.equal((await waitFor(message => message.id === "initialize")).result.protocolVersion, 1)
  await send({ id: "subscribe", method: "_deskfleet/session/subscribe", params: { sessionId: "1" } })
  await waitFor(message => message.id === "subscribe")
  return { send, waitFor, close, identity, errors, messages }
}

test("two real WebRTC Agent clients isolate RPC IDs, share permission winners, and reconnect without cancelling", { timeout: 20_000 }, async t => {
  const sessions = new Sessions()
  const register = (close: () => Promise<void>) => { t.after(close) }
  const [first, second] = await Promise.all([connect(sessions, "first", register), connect(sessions, "second", register)])
  await Promise.all([first.send({ id: 0, method: "_deskfleet/session/list", params: {} }), second.send({ id: 0, method: "_deskfleet/session/list", params: {} })])
  assert.equal((await first.waitFor(message => message.id === 0)).result[0].deviceId, "first")
  assert.equal((await second.waitFor(message => message.id === 0)).result[0].deviceId, "second")

  const decision = sessions.requestPermission()
  const [left, right] = await Promise.all([first.waitFor(message => message.method === "session/request_permission"), second.waitFor(message => message.method === "session/request_permission")])
  assert.equal(left.params.toolCall.title, "写文件 🌍")
  // Each connection can use the same request ID: its own actor and durable
  // permission mapping are established by the authenticated attachment.
  assert.equal(left.id, right.id)
  const winningOperation = randomUUID()
  await first.send({ id: left.id, result: { outcome: { outcome: "selected", optionId: "allow" }, _meta: { deskfleet: { operationId: winningOperation } } } })
  assert.equal(await decision, "allow")
  await second.waitFor(message => message.method === "$/cancel_request")
  const lateOperation = randomUUID()
  await second.send({ id: right.id, result: { outcome: { outcome: "selected", optionId: "reject" }, _meta: { deskfleet: { operationId: lateOperation } } } })
  const receipt = await second.waitFor(message => message.method === "_deskfleet/permission/receipt" && message.params.operationId === lateOperation)
  assert.equal(receipt.params.result.optionId, "allow")
  assert.deepEqual(sessions.decisions.map(value => value.actor.deviceId), ["first", "second"])
  assert.deepEqual(sessions.decisions.map(value => value.params.operationId), [winningOperation, lateOperation])

  const nextDecision = sessions.requestPermission()
  const nextId = sessions.permissions.at(-1)!.id
  await Promise.all([first.waitFor(message => message.params?._meta?.deskfleet?.permissionId === nextId), second.waitFor(message => message.params?._meta?.deskfleet?.permissionId === nextId)])
  await Promise.all([first.close(), second.close()])
  assert.equal(sessions.listeners.size, 0)
  assert.equal(sessions.permissions.at(-1)!.state, "pending")
  assert.equal(sessions.decisions.length, 2)
  const reconnected = await connect(sessions, "reconnected", register)
  const pending = await reconnected.waitFor(message => message.params?._meta?.deskfleet?.permissionId === nextId)
  await reconnected.send({ id: pending.id, result: { outcome: { outcome: "selected", optionId: "reject" } } })
  assert.equal(await nextDecision, "reject")
  assert.deepEqual(sessions.decisions.at(-1)!.actor, reconnected.identity)
  assert.deepEqual([...first.errors, ...second.errors, ...reconnected.errors], [])
})
