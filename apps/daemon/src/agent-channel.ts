import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import {
  AGENT_CHUNK_BYTES, AGENT_MESSAGE_BYTES,
  type AgentActor, type AgentEvent, type AgentMethod, type AgentPermission, type AgentSnapshot,
} from "./agent-protocol.ts"

export interface AgentChannelSessions {
  readonly journal: { readonly identity: unknown }
  sessionDirectory?(sessionId: string): Promise<string>
  sessionAttachmentDirectory?(sessionId: string): Promise<string>
  handle(method: AgentMethod, params: unknown, actor: AgentActor): Promise<unknown>
  onEvent(listener: (event: AgentEvent) => void): () => void
  watchGit?(sessionId: string, actor: AgentActor, listener: (error?: string) => void): Promise<() => void>
}

type RpcId = string | number | null
type JsonObject = Record<string, unknown>
interface Subscription { ready: boolean; events: { event: AgentEvent; bytes: number }[] }
interface PermissionCall { sessionId: string; permissionId: string; resolved: boolean }
interface GitSubscription { stop?: () => void }

const METHODS = new Set<AgentMethod>([
  "_deskfleet/composer/references", "_deskfleet/composer/resolve",
  "_deskfleet/agent/configuration", "_deskfleet/session/configuration", "_deskfleet/session/configure",
  "_deskfleet/session/list", "_deskfleet/session/create", "_deskfleet/session/fork", "_deskfleet/session/subscribe", "_deskfleet/session/history",
  "_deskfleet/input/submit", "_deskfleet/input/steer", "_deskfleet/input/withdraw", "_deskfleet/input/retry",
  "_deskfleet/turn/cancel", "_deskfleet/permission/respond", "_deskfleet/session/resume", "_deskfleet/session/stop",
  "_deskfleet/elicitation/respond",
  "_deskfleet/session/archive", "_deskfleet/session/restore", "_deskfleet/command/get",
  "_deskfleet/git/status", "_deskfleet/git/diff", "_deskfleet/git/subscribe", "_deskfleet/git/unsubscribe",
])
const MAX_PENDING_REQUESTS = 128
const MAX_QUEUED_BYTES = AGENT_MESSAGE_BYTES * 2
const SEND_TIMEOUT_MS = 5_000

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function rpcId(value: unknown): value is RpcId {
  return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value)
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** A viewer attachment. Session processes and pending approvals belong to the service. */
export class AgentChannel {
  readonly #sessions: AgentChannelSessions
  readonly #actor: AgentActor
  readonly #send: (bytes: Uint8Array) => Promise<void>
  readonly #onFailure: (error: unknown) => void
  readonly #unsubscribe: () => void
  readonly #subscriptions = new Map<string, Subscription>()
  readonly #gitSubscriptions = new Map<string, GitSubscription>()
  readonly #permissionCalls = new Map<string, PermissionCall>()
  readonly #requests = new Set<RpcId>()
  readonly #decoder = new TextDecoder("utf-8", { fatal: true })
  readonly #closing = new AbortController()
  #fragments: Uint8Array[] = []
  #fragmentBytes = 0
  #requestBytes = 0
  #outgoing: Uint8Array[] = []
  #queuedBytes = 0
  #writing = false
  #initialized = false
  #closed = false
  #nextPermission = 0

  constructor(sessions: AgentChannelSessions, actor: AgentActor, send: (bytes: Uint8Array) => Promise<void>, onFailure: (error: unknown) => void) {
    this.#sessions = sessions
    this.#actor = actor
    this.#send = send
    this.#onFailure = onFailure
    this.#unsubscribe = sessions.onEvent(event => this.#event(event))
  }

  receive(data: Uint8Array, isString = false): void {
    if (this.#closed) return
    if (isString) { this.#fail(new Error("ACP DataChannel requires binary NDJSON chunks")); return }
    let start = 0
    for (let end = 0; end <= data.byteLength; end++) {
      if (end !== data.byteLength && data[end] !== 10) continue
      const fragment = data.subarray(start, end)
      if (this.#fragmentBytes + fragment.byteLength > AGENT_MESSAGE_BYTES) {
        this.#fail(new Error("ACP message exceeds its byte limit")); return
      }
      if (fragment.byteLength) this.#fragments.push(fragment.slice())
      this.#fragmentBytes += fragment.byteLength
      if (end < data.byteLength) {
        const line = Buffer.concat(this.#fragments, this.#fragmentBytes)
        this.#fragments = []
        this.#fragmentBytes = 0
        this.#line(line)
        if (this.#closed) return
      }
      start = end + 1
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#closing.abort()
    this.#unsubscribe()
    for (const subscription of this.#gitSubscriptions.values()) subscription.stop?.()
    this.#gitSubscriptions.clear()
    this.#subscriptions.clear()
    this.#permissionCalls.clear()
    this.#requests.clear()
    this.#fragments = []
    this.#fragmentBytes = 0
    this.#outgoing = []
    this.#queuedBytes = 0
  }

  #line(line: Uint8Array): void {
    let message: unknown
    try {
      const text = this.#decoder.decode(line).trim()
      if (!text) return
      message = JSON.parse(text)
    } catch {
      this.#error(null, -32700, "Invalid JSON")
      return
    }
    if (!object(message) || message.jsonrpc !== "2.0") {
      this.#error(null, -32600, "Invalid JSON-RPC message"); return
    }
    if (!("method" in message)) {
      const hasResult = Object.hasOwn(message, "result")
      const hasError = Object.hasOwn(message, "error")
      if (!rpcId(message.id) || hasResult === hasError || hasError &&
        (!object(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== "string")) {
        this.#fail(new Error("Invalid JSON-RPC response")); return
      }
      this.#permissionResponse(message)
      return
    }
    const hasId = Object.hasOwn(message, "id")
    if (typeof message.method !== "string" || hasId && !rpcId(message.id)) {
      this.#error(null, -32600, "Invalid JSON-RPC request"); return
    }
    if (!hasId) {
      // Viewer RPC cancellation does not cancel a shared Session operation.
      return
    }
    const id = message.id as RpcId
    if (this.#requests.has(id)) { this.#error(id, -32600, "Request ID is already pending"); return }
    if (this.#requests.size >= MAX_PENDING_REQUESTS || this.#requestBytes + line.byteLength > AGENT_MESSAGE_BYTES) {
      this.#fail(new Error("Too much pending ACP input")); return
    }
    this.#requests.add(id)
    this.#requestBytes += line.byteLength
    // Keep receiving permission responses/cancellation while any request awaits.
    void this.#request(id, message.method, message.params).finally(() => {
      this.#requests.delete(id)
      this.#requestBytes -= line.byteLength
    })
  }

  async #request(id: RpcId, method: string, params: unknown): Promise<void> {
    let subscribing: { sessionId: string; subscription: Subscription } | undefined
    try {
      if (method === "initialize") {
        if (this.#initialized) { this.#error(id, -32600, "ACP is already initialized"); return }
        if (!object(params) || !Number.isInteger(params.protocolVersion)) {
          this.#error(id, -32602, "Invalid initialize parameters"); return
        }
        this.#initialized = true
        this.#queue({ jsonrpc: "2.0", id, result: {
          protocolVersion: 1,
          agentInfo: { name: "deskfleet", version: "0.1.0" },
          agentCapabilities: { _meta: { deskfleet: { sessions: true, maxMessageBytes: AGENT_MESSAGE_BYTES } } },
          _meta: { deskfleet: { identity: this.#sessions.journal.identity } },
        } })
        return
      }
      if (!this.#initialized) { this.#error(id, -32002, "Initialize ACP before using Sessions"); return }
      if (!METHODS.has(method as AgentMethod)) { this.#error(id, -32601, "Method not found"); return }
      if (method === "_deskfleet/git/subscribe" || method === "_deskfleet/git/unsubscribe") {
        await this.#gitSubscription(method, params)
        this.#queue({ jsonrpc: "2.0", id, result: null })
        return
      }
      if (method === "_deskfleet/session/subscribe" && object(params) && typeof params.sessionId === "string") {
        const existing = this.#subscriptions.get(params.sessionId)
        if (existing && !existing.ready) throw new Error("Session subscription is already pending")
        const subscription: Subscription = { ready: false, events: [] }
        this.#subscriptions.set(params.sessionId, subscription)
        subscribing = { sessionId: params.sessionId, subscription }
      }
      const result = await this.#sessions.handle(method as AgentMethod, params, this.#actor)
      if (this.#closed) return
      this.#queue({ jsonrpc: "2.0", id, result })
      if (this.#closed) return
      if (subscribing) {
        const { subscription } = subscribing
        const permissionChanges = new Map<string, AgentPermission["state"]>()
        for (const { event } of subscription.events) {
          if (event.kind === "permission") {
            const permission = event.payload as AgentPermission
            permissionChanges.set(permission.id, permission.state)
          }
        }
        // The service authorized the subscription. Publish its response before
        // events captured while its consistent snapshot was being read.
        for (const { event, bytes } of subscription.events) {
          this.#queuedBytes -= bytes
          this.#forward(event)
          if (this.#closed) return
        }
        subscription.events = []
        subscription.ready = true
        const snapshot = result as AgentSnapshot
        for (const permission of snapshot.permissions) {
          if ((permissionChanges.get(permission.id) ?? permission.state) === "pending") this.#permission(permission)
        }
      }
    } catch (error) {
      if (subscribing) {
        this.#subscriptions.delete(subscribing.sessionId)
        for (const item of subscribing.subscription.events) this.#queuedBytes -= item.bytes
      }
      this.#error(id, -32000, errorMessage(error))
    }
  }

  async #gitSubscription(method: string, params: unknown): Promise<void> {
    if (!object(params) || typeof params.subscriptionId !== "string" || !params.subscriptionId || params.subscriptionId.length > 128) {
      throw new Error("Invalid Git subscription ID")
    }
    const subscriptionId = params.subscriptionId
    if (method === "_deskfleet/git/unsubscribe") {
      this.#gitSubscriptions.get(subscriptionId)?.stop?.()
      this.#gitSubscriptions.delete(subscriptionId)
      return
    }
    if (typeof params.sessionId !== "string" || !params.sessionId) throw new Error("Missing Session ID")
    if (!this.#sessions.watchGit) throw new Error("Git observation is unavailable")
    if (this.#gitSubscriptions.has(subscriptionId)) throw new Error("Git subscription ID is already in use")
    if (this.#gitSubscriptions.size >= MAX_PENDING_REQUESTS) throw new Error("Too many Git subscriptions")
    const sessionId = params.sessionId
    const subscription: GitSubscription = {}
    this.#gitSubscriptions.set(subscriptionId, subscription)
    try {
      const stop = await this.#sessions.watchGit(sessionId, this.#actor, error => {
        if (this.#closed || this.#gitSubscriptions.get(subscriptionId) !== subscription) return
        this.#queue({ jsonrpc: "2.0", method: "_deskfleet/git/changed", params: { sessionId, subscriptionId, ...(error ? { error } : {}) } })
      })
      // The viewer can hide the panel or disconnect while directory watches attach.
      if (this.#closed || this.#gitSubscriptions.get(subscriptionId) !== subscription) stop()
      else subscription.stop = stop
    } catch (error) {
      if (this.#gitSubscriptions.get(subscriptionId) === subscription) this.#gitSubscriptions.delete(subscriptionId)
      throw error
    }
  }

  #event(event: AgentEvent): void {
    if (this.#closed) return
    const subscription = this.#subscriptions.get(event.sessionId)
    if (!subscription) return
    if (subscription.ready) { this.#forward(event); return }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (this.#queuedBytes + bytes > MAX_QUEUED_BYTES) { this.#fail(new Error("ACP viewer cannot keep up")); return }
    this.#queuedBytes += bytes
    subscription.events.push({ event, bytes })
  }

  #forward(event: AgentEvent): void {
    this.#queue({ jsonrpc: "2.0", method: "_deskfleet/session/event", params: event })
    if (event.kind !== "permission") return
    const permission = event.payload as AgentPermission
    if (permission.state === "pending") { this.#permission(permission); return }
    for (const [id, call] of this.#permissionCalls) {
      if (call.sessionId !== permission.sessionId || call.permissionId !== permission.id || call.resolved) continue
      call.resolved = true
      this.#queue({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: id } })
    }
  }

  #permission(permission: AgentPermission): void {
    if (this.#closed) return
    for (const call of this.#permissionCalls.values()) {
      if (call.sessionId === permission.sessionId && call.permissionId === permission.id) return
    }
    if (this.#permissionCalls.size >= MAX_PENDING_REQUESTS) { this.#fail(new Error("Too many unanswered ACP permission requests")); return }
    const id = `permission-${++this.#nextPermission}`
    this.#permissionCalls.set(id, { sessionId: permission.sessionId, permissionId: permission.id, resolved: false })
    this.#queue({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
      ...permission.request,
      sessionId: permission.sessionId,
      _meta: { ...permission.request._meta, deskfleet: { permissionId: permission.id } },
    } })
  }

  #permissionResponse(message: JsonObject): void {
    if (typeof message.id !== "string") return
    const call = this.#permissionCalls.get(message.id)
    if (!call) return
    this.#permissionCalls.delete(message.id)
    if ("error" in message || !object(message.result) || !object(message.result.outcome)) return
    const { outcome } = message.result
    if (outcome.outcome !== "selected" || typeof outcome.optionId !== "string") return
    const meta = message.result._meta
    const deskfleet = object(meta) ? meta.deskfleet : undefined
    const operationId = object(deskfleet) && typeof deskfleet.operationId === "string" ? deskfleet.operationId : randomUUID()
    void this.#sessions.handle("_deskfleet/permission/respond", {
      sessionId: call.sessionId, permissionId: call.permissionId, operationId, optionId: outcome.optionId,
    }, this.#actor).then(result => {
      this.#queue({ jsonrpc: "2.0", method: "_deskfleet/permission/receipt", params: { operationId, permissionId: call.permissionId, result } })
    }, error => {
      this.#queue({ jsonrpc: "2.0", method: "_deskfleet/permission/receipt", params: { operationId, permissionId: call.permissionId, error: errorMessage(error) } })
    })
  }

  #error(id: RpcId, code: number, message: string): void {
    this.#queue({ jsonrpc: "2.0", id, error: { code, message } })
  }

  #queue(message: JsonObject): void {
    if (this.#closed) return
    const bytes = Buffer.from(JSON.stringify(message) + "\n")
    if (bytes.byteLength > AGENT_MESSAGE_BYTES + 1 || this.#queuedBytes + bytes.byteLength > MAX_QUEUED_BYTES) {
      this.#fail(new Error("ACP viewer exceeded its output byte limit")); return
    }
    this.#queuedBytes += bytes.byteLength
    this.#outgoing.push(bytes)
    if (!this.#writing) void this.#write()
  }

  async #write(): Promise<void> {
    this.#writing = true
    try {
      while (!this.#closed && this.#outgoing.length) {
        const message = this.#outgoing.shift()!
        for (let offset = 0; offset < message.byteLength && !this.#closed; offset += AGENT_CHUNK_BYTES) {
          const chunk = message.subarray(offset, offset + AGENT_CHUNK_BYTES)
          const deadline = Date.now() + SEND_TIMEOUT_MS
          for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined
            const stopped = () => rejectStopped(new Error("ACP channel closed"))
            let rejectStopped!: (error: Error) => void
            try {
              const stopping = new Promise<never>((_, reject) => { rejectStopped = reject })
              this.#closing.signal.addEventListener("abort", stopped, { once: true })
              await Promise.race([
                this.#send(chunk),
                stopping,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error("ACP send buffer stalled")), Math.max(1, deadline - Date.now()))
                }),
              ])
              break
            } catch (error) {
              if (!/backpressure|send buffer is full/i.test(errorMessage(error)) || Date.now() >= deadline) throw error
              await delay(10, undefined, { signal: this.#closing.signal })
              if (this.#closed) return
            } finally {
              clearTimeout(timer)
              this.#closing.signal.removeEventListener("abort", stopped)
            }
          }
        }
        this.#queuedBytes = Math.max(0, this.#queuedBytes - message.byteLength)
      }
    } catch (error) { this.#fail(error) }
    finally { this.#writing = false }
  }

  #fail(error: unknown): void {
    if (this.#closed) return
    this.close()
    this.#onFailure(error)
  }
}
