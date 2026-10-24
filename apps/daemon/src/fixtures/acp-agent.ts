import { writeFileSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

const mode = process.env.DESKFLEET_TEST_AGENT_MODE
const exitFile = process.env.DESKFLEET_TEST_EXIT_FILE
if (exitFile) process.once("exit", code => writeFileSync(exitFile, String(code)))

const activePrompts = new Map<string, (response: acp.PromptResponse) => void>()
let nextSession = 0
const connection = acp.agent({ name: "deskfleet-test-agent" })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => {
    if (mode === "wait-init") await new Promise(() => {})
    if (mode === "exit-init") process.exit(12)
    return {
      protocolVersion: acp.PROTOCOL_VERSION + (mode === "wrong-version" ? 1 : 0),
      agentInfo: { name: "deskfleet-test-agent", version: "1.0.0" },
      agentCapabilities: {
        promptCapabilities: { image: true },
        sessionCapabilities: { resume: {} },
      },
      _meta: {
        steering: { supported: true, supportsPromptRequired: mode !== "legacy-steering" },
        clientCapabilities: params.clientCapabilities,
        environment: {
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          extra: process.env.DESKFLEET_TEST_VALUE,
        },
      },
    }
  })
  .onRequest(acp.methods.agent.session.new, async ({ params }) => {
    if (mode === "wait-session") await new Promise(() => {})
    return { sessionId: `fixture-session-${++nextSession}`, _meta: { request: params } }
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => ({
    configOptions: [{ id: params.configId, category: "model", name: "Model", type: "select", currentValue: String(params.value), options: [{ value: String(params.value), name: "Model" }] }],
  }))
  .onRequest(acp.methods.agent.session.resume, ({ params }) => ({ _meta: { request: params } }))
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const pending = mode === "wait" || mode?.startsWith("steer-")
      ? new Promise<acp.PromptResponse>(resolve => { activePrompts.set(params.sessionId, resolve) })
      : undefined
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ready" } },
      _meta: { source: "fixture" },
    })
    if (pending) {
      try { return await pending } finally { activePrompts.delete(params.sessionId) }
    }
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "write-1", title: "Write a file", kind: "edit" },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject once", kind: "reject_once" },
      ],
    })
    return { stopReason: "end_turn", _meta: { prompt: params.prompt, permission } }
  })
  .onRequest("_session/steering", params => params as acp.PromptRequest, async ({ params: request, client }) => {
    const steering = request._meta?.steering as { idleBehavior?: string } | undefined
    if (steering?.idleBehavior !== "promptRequired") throw new Error("Steering must prohibit detached fallback")
    if (mode === "steer-exit") process.exit(17)
    if (mode === "steer-failed") return { outcome: "failed" }
    if (mode === "steer-end-race") {
      activePrompts.get(request.sessionId)?.({ stopReason: "end_turn" })
      activePrompts.delete(request.sessionId)
    }
    if (!activePrompts.has(request.sessionId)) return { outcome: "promptRequired", reason: "noRunningTurn" }
    await client.notify(acp.methods.client.session.update, {
      sessionId: request.sessionId,
      update: { sessionUpdate: "user_message_chunk", content: request.prompt[0]! },
      _meta: request._meta,
    })
    return { outcome: "injected" }
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    activePrompts.get(params.sessionId)?.({ stopReason: "cancelled" })
  })
  .connect(acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ))

await connection.closed
process.exit(0)
