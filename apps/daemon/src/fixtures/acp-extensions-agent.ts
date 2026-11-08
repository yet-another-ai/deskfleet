import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk/unstable"

const mode = process.env.DESKFLEET_TEST_EXTENSIONS_MODE
let forkCalls = 0

async function announceChild(client: acp.AgentContext, sessionId: string, cwd: string): Promise<void> {
  const child = `${sessionId}-child`
  await client.notify(acp.methods.client.session.update, { sessionId, update: {
    sessionUpdate: "subagent_update", sessionId: child, title: "Explorer", cwd,
  } })
  await openingFile(client, child, cwd)
  await client.notify(acp.methods.client.session.update, { sessionId: child, update: {
    sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Child result" },
  } })
}

async function openingFile(client: acp.AgentContext, sessionId: string, cwd: string): Promise<string> {
  const path = join(cwd, "opening", `${sessionId}.txt`)
  await client.request(acp.methods.client.fs.writeTextFile, { sessionId, path, content: `${sessionId}\nready\n` })
  const read = await client.request(acp.methods.client.fs.readTextFile, { sessionId, path, line: 2, limit: 1 })
  return read.content
}

const connection = acp.agent({ name: "deskfleet-extensions-fixture" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true, sessionCapabilities: mode === "unsupported-fork" ? {} : { fork: {} } },
    _meta: { clientCapabilities: params.clientCapabilities },
  }))
  .onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
    const sessionId = "extension-source"
    const content = await openingFile(client, sessionId, params.cwd)
    if (mode === "children") await announceChild(client, sessionId, params.cwd)
    return { sessionId, _meta: { content } }
  })
  .onRequest(acp.methods.agent.session.fork, async ({ params, client }) => {
    forkCalls++
    const sessionId = mode === "same-id" ? params.sessionId : `extension-fork-${forkCalls}`
    const content = await openingFile(client, sessionId, params.cwd)
    if (mode === "children") await announceChild(client, sessionId, params.cwd)
    return { sessionId: mode === "mismatched-id" ? "different-id" : sessionId, _meta: { request: params, content } }
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    await announceChild(client, params.sessionId, params.cwd)
    return {}
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const notification = params._meta?.notification as { method: string; params: unknown } | undefined
    if (notification) {
      await client.notify(notification.method, notification.params)
      return { stopReason: "end_turn" }
    }
    const operation = params._meta?.operation as { method: string; params: Record<string, unknown> } | undefined
    if (operation) {
      try {
        const result = await client.request<unknown>(operation.method, { sessionId: params.sessionId, ...operation.params })
        return { stopReason: "end_turn", _meta: { callback: { result }, forkCalls } }
      } catch (error) {
        if (!(error instanceof acp.RequestError)) throw error
        return { stopReason: "end_turn", _meta: { callback: { error: { code: error.code, message: error.message } }, forkCalls } }
      }
    }
    if (params._meta?.url) {
      const response = await client.request(acp.methods.client.elicitation.create, {
        sessionId: params.sessionId, mode: "url", elicitationId: "authorize-account",
        url: "https://example.com/authorize", message: "Connect your account",
      })
      if (response.action === "accept") await client.notify(acp.methods.client.elicitation.complete, {
        elicitationId: "authorize-account", _meta: { completed: true },
      })
      return { stopReason: "end_turn", _meta: { response, forkCalls } }
    }
    return { stopReason: "end_turn", _meta: { forkCalls } }
  })
  .connect(acp.ndJsonStream(
    Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ))

await connection.closed
