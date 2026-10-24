import { writeFileSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

const mode = process.env.DESKFLEET_TEST_AGENT_MODE
const exitFile = process.env.DESKFLEET_TEST_EXIT_FILE
if (exitFile) process.once("exit", code => writeFileSync(exitFile, String(code)))

const activePrompts = new Map<string, (response: acp.PromptResponse) => void>()
const cursorQuestion = {
  toolCallId: "call_123",
  title: "Need input",
  questions: [
    { id: "q1", prompt: "Which mode should I use?", options: [{ id: "agent", label: "Agent" }, { id: "plan", label: "Plan" }] },
    { id: "q2", prompt: "Which checks?", allowMultiple: true, options: [{ id: "lint", label: "Lint" }, { id: "test", label: "Test" }] },
  ],
}
const grokQuestion = {
  toolCallId: "tc-1",
  mode: "plan",
  questions: [{
    question: "Which database?",
    options: [
      { label: "Redis", description: "In-memory store", preview: " redis preview " },
      { label: "Postgres", description: "Relational DB" },
    ],
  }],
}
async function askVendor(client: acp.AgentContext, method: string, params: unknown): Promise<acp.PromptResponse> {
  try {
    return { stopReason: "end_turn", _meta: { question: await client.request(method, params) } }
  } catch (error) {
    const questionError = error instanceof acp.RequestError
      ? { code: error.code, message: error.message }
      : { message: error instanceof Error ? error.message : String(error) }
    return { stopReason: "end_turn", _meta: { questionError } }
  }
}
let nextSession = 0
let authenticated = false
let authMethod: string | undefined
let authHeadless: unknown
const cursorMode = mode === "cursor"
const grokMode = mode === "grok" || mode === "grok-cached" || mode === "grok-login"
function grokAuthMethods(): acp.AuthMethod[] {
  if (mode === "grok") return [{ id: "xai.api_key", name: "xai.api_key" }, { id: "cached_token", name: "cached_token" }]
  if (mode === "grok-cached") return [{ id: "cached_token", name: "cached_token" }]
  return [{ id: "grok.com", name: "Grok", type: "terminal" }]
}
const connection = acp.agent({ name: "deskfleet-test-agent" })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => {
    if (mode === "wait-init") await new Promise(() => {})
    if (mode === "exit-init") process.exit(12)
    return {
      protocolVersion: acp.PROTOCOL_VERSION + (mode === "wrong-version" ? 1 : 0),
      agentInfo: { name: cursorMode ? "cursor-agent" : grokMode ? "grok" : "deskfleet-test-agent", version: "1.0.0" },
      agentCapabilities: cursorMode ? {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {} },
      } : {
        promptCapabilities: { image: true },
        sessionCapabilities: { resume: {} },
      },
      ...(cursorMode ? { authMethods: [{ id: "cursor_login", name: "Cursor Login" }] } : grokMode ? { authMethods: grokAuthMethods() } : {}),
      _meta: {
        steering: { supported: true, supportsPromptRequired: mode !== "legacy-steering" },
        clientCapabilities: params.clientCapabilities,
        environment: {
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          extra: process.env.DESKFLEET_TEST_VALUE,
        },
        launch: { args: process.argv.slice(2), claudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE },
      },
    }
  })
  .onRequest(acp.methods.agent.authenticate, ({ params }) => {
    authenticated = true
    authMethod = params.methodId
    authHeadless = params._meta?.headless
    return {}
  })
  .onRequest(acp.methods.agent.session.new, async ({ params }) => {
    if (mode === "wait-session") await new Promise(() => {})
    if (mode === "session-error") throw acp.RequestError.internalError({ details: `fixture cannot open ${params.cwd}` })
    if (cursorMode && !authenticated) throw acp.RequestError.internalError({ details: "authenticate required" })
    return {
      sessionId: `fixture-session-${++nextSession}`,
      _meta: {
        request: params,
        ...(cursorMode ? { authenticated } : {}),
        ...(grokMode ? { authenticated, authMethod, headless: authHeadless } : {}),
      },
    }
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    if (cursorMode && !authenticated) throw new Error("authenticate required")
    if (cursorMode) {
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed history" } },
      })
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [{ id: "model", category: "model", name: "Model", type: "select", currentValue: "composer", options: [{ value: "composer", name: "Composer" }] }],
        },
      })
    }
    return { _meta: { method: "session/load", request: params } }
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
    if (mode === "cursor-question" || mode === "cursor-question-invalid") {
      return askVendor(client, "cursor/ask_question", mode === "cursor-question" ? cursorQuestion : { toolCallId: "call_123", questions: [] })
    }
    if (mode === "grok-question" || mode === "grok-question-alias") {
      return askVendor(client, mode === "grok-question" ? "x.ai/ask_user_question" : "_x.ai/ask_user_question", {
        ...grokQuestion, sessionId: params.sessionId,
      })
    }
    if (mode?.startsWith("elicitation")) {
      const scope = mode === "elicitation-request" ? { requestId: "configuration" } : { sessionId: params.sessionId, toolCallId: "question-1" }
      const request: acp.CreateElicitationRequest = mode === "elicitation-url"
        ? { ...scope, mode: "url", message: "Open a link", elicitationId: "link-1", url: "https://example.invalid" }
        : { ...scope, mode: "form", message: "Choose a direction", requestedSchema: {
            type: "object", required: ["direction"], properties: {
              direction: { type: "string", oneOf: [{ const: "left", title: "Left" }, { const: "right", title: "Right" }] },
            },
          } }
      const elicitation = await client.request(acp.methods.client.elicitation.create, request)
      return { stopReason: "end_turn", _meta: { elicitation } }
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
