import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk/unstable"

const mode = process.env.DESKFLEET_TEST_TERMINAL_MODE
const connection = acp.agent({ name: "deskfleet-terminal-fixture" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    _meta: { clientCapabilities: params.clientCapabilities },
  }))
  .onRequest(acp.methods.agent.session.new, async ({ client }) => {
    const sessionId = "terminal-provider-session"
    if (mode === "opening-failure" || mode === "opening-mismatch") {
      await client.request(acp.methods.client.terminal.create, { sessionId, command: "opening-command" })
      if (mode === "opening-failure") throw acp.RequestError.internalError({ details: "Opening failed" })
      return { sessionId: "mismatched-session" }
    }
    return { sessionId }
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const operation = params._meta?.operation as { method: string; params: Record<string, unknown> }
    try {
      const result = await client.request<unknown>(operation.method, { sessionId: params.sessionId, ...operation.params })
      return { stopReason: "end_turn", _meta: { callback: { result } } }
    } catch (error) {
      if (!(error instanceof acp.RequestError)) throw error
      return { stopReason: "end_turn", _meta: { callback: { error: { code: error.code, message: error.message } } } }
    }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>))

await connection.closed
