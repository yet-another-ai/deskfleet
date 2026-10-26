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
let parameterizedModelPicker = false
let cursorModel = "composer-2.5"
let cursorEffort = "high"
let grokModel = "grok-4.5"
let grokEffort: string | undefined
const cursorMode = mode === "cursor" || mode === "cursor-test" || mode === "cursor-test-signed-out"
const deepseekHarnessMode = mode === "deepseek-harness"
const grokEffortMode = mode === "grok-effort"
const grokMode = mode === "grok" || mode === "grok-cached" || mode === "grok-login"
const grokReasoning = [
  { id: "low", label: "Low", description: "Faster replies" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High", default: true },
]
function cursorConfigOptions(): acp.SessionConfigOption[] {
  if (!parameterizedModelPicker) {
    return [{
      id: "model", category: "model", name: "Model", type: "select", currentValue: `${cursorModel}[fast=true]`,
      options: [
        { value: "composer-2.5[fast=true]", name: "Composer 2.5 Fast" },
        { value: "grok-4.6[effort=high,fast=true]", name: "Grok 4.6 Fast" },
      ],
    }]
  }
  return [
    {
      id: "model", category: "model", name: "Model", type: "select", currentValue: cursorModel,
      options: [{ value: "composer-2.5", name: "Composer 2.5" }, { value: "grok-4.6", name: "Grok 4.6" }],
    },
    {
      id: "effort", category: "thought_level", name: "Reasoning", type: "select", currentValue: cursorEffort,
      options: ["low", "medium", "high", "xhigh"].map(value => ({ value, name: value })),
    },
    { id: "fast", category: "model_config", name: "Fast", type: "boolean", currentValue: true },
  ]
}
function grokCatalog(): { currentModelId: string; availableModels: Array<{ modelId: string; name: string; _meta: Record<string, unknown> }> } {
  return {
    currentModelId: grokModel,
    availableModels: [
      {
        modelId: "grok-4.5", name: "Grok 4.5",
        _meta: {
          supportsReasoningEffort: true,
          reasoningEffort: grokModel === "grok-4.5" && grokEffort ? grokEffort : "high",
          reasoningEfforts: grokReasoning,
        },
      },
      { modelId: "grok-fast", name: "Grok Fast", _meta: { supportsReasoningEffort: false, reasoningEfforts: [] } },
    ],
  }
}
function grokSessionMeta(authenticatedSession = false): Record<string, unknown> {
  return {
    ...(authenticatedSession ? { authenticated, authMethod, headless: authHeadless } : {}),
    models: grokCatalog(),
    "x.ai/sessionConfig": {
      options: [
        {
          id: "model", name: "Model", category: "model", type: "select", currentValue: grokModel,
          options: [{ value: "grok-4.5", name: "Grok 4.5" }, { value: "grok-fast", name: "Grok Fast" }],
        },
        {
          id: "reasoning_effort", name: "Reasoning", category: "mode", type: "select", currentValue: "xhigh",
          options: [{ value: "xhigh", name: "Stale extra high" }],
        },
      ],
    },
  }
}
function grokAuthMethods(): acp.AuthMethod[] {
  if (mode === "grok") return [{ id: "xai.api_key", name: "xai.api_key" }, { id: "cached_token", name: "cached_token" }]
  if (mode === "grok-cached") return [{ id: "cached_token", name: "cached_token" }]
  return [{ id: "grok.com", name: "Grok", type: "terminal" }]
}
const connection = acp.agent({ name: "deskfleet-test-agent" })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => {
    if (mode === "wait-init") await new Promise(() => {})
    if (mode === "exit-init") process.exit(12)
    parameterizedModelPicker = params.clientCapabilities?._meta?.parameterizedModelPicker === true
    return {
      protocolVersion: acp.PROTOCOL_VERSION + (mode === "wrong-version" ? 1 : 0),
      agentInfo: {
        name: cursorMode ? "cursor-agent" : grokMode ? "grok" : deepseekHarnessMode ? "deepseek-harness" : "deskfleet-test-agent",
        version: "1.0.0",
        ...(deepseekHarnessMode ? { title: "DeepSeek Harness" } : {}),
      },
      agentCapabilities: cursorMode ? {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {} },
      } : deepseekHarnessMode ? {
        promptCapabilities: { image: true },
        mcpCapabilities: { http: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
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
    if (mode?.startsWith("cursor-test")) throw new Error("Test connection must not request login")
    authenticated = true
    authMethod = params.methodId
    authHeadless = params._meta?.headless
    return {}
  })
  .onRequest(acp.methods.agent.session.new, async ({ params }) => {
    if (mode === "cursor-test-signed-out") throw acp.RequestError.authRequired()
    if (mode === "test-no-login" && process.env.DEFAULT_AUTH_REQUEST) throw new Error("Test connection inherited automatic login")
    if (mode === "wait-session") await new Promise(() => {})
    if (mode === "session-error") throw acp.RequestError.internalError({ details: `fixture cannot open ${params.cwd}` })
    if (cursorMode && mode !== "cursor-test" && !authenticated) throw acp.RequestError.internalError({ details: "authenticate required" })
    const sessionId = `fixture-session-${++nextSession}`
    if (grokEffortMode) {
      return { sessionId, models: grokCatalog(), _meta: { request: params, ...grokSessionMeta() } }
    }
    return {
      sessionId,
      ...(cursorMode ? { configOptions: cursorConfigOptions() } : {}),
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
          configOptions: cursorConfigOptions(),
        },
      })
    }
    return { _meta: { method: "session/load", request: params } }
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    if (cursorMode && (params.configId === "model" || params.configId === "effort") && typeof params.value === "string") {
      if (params.configId === "model") cursorModel = params.value
      else cursorEffort = params.value
      return { configOptions: cursorConfigOptions() }
    }
    return {
      configOptions: [{ id: params.configId, category: "model", name: "Model", type: "select", currentValue: String(params.value), options: [{ value: String(params.value), name: "Model" }] }],
    }
  })
  .onRequest(acp.methods.agent.session.setMode, ({ params }) => {
    if (!grokEffortMode) throw acp.RequestError.methodNotFound("session/set_mode")
    grokEffort = params.modeId
    return {}
  })
  .onRequest("session/set_model", (params: unknown) => {
    if (!params || typeof params !== "object") throw new Error("invalid set_model")
    return params as { sessionId: string; modelId: string }
  }, ({ params }) => {
    if (!grokEffortMode) throw acp.RequestError.methodNotFound("session/set_model")
    if (params.modelId !== "grok-4.5" && params.modelId !== "grok-fast") throw acp.RequestError.invalidParams({ details: "unknown model" })
    grokModel = params.modelId
    grokEffort = undefined
    return { models: grokCatalog(), _meta: grokSessionMeta() }
  })
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
