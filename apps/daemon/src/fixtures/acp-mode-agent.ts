import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

const nativeMode = process.env.DESKFLEET_TEST_NATIVE_MODE === "true"
const loadSession = process.env.DESKFLEET_TEST_LOAD_SESSION === "true"
const omitResume = process.env.DESKFLEET_TEST_OMIT_RESUME === "true"
let currentMode = "default"
let currentModel = "model-a"
const modes: acp.SessionModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Agent", description: "Use the agent tools" },
    { id: "plan", name: "Plan", description: "Plan before editing" },
    { id: "fallback", name: "Unavailable mode" },
    { id: "rejected", name: "Rejected mode" },
  ],
}

function options(): acp.SessionConfigOption[] {
  return [{
    id: "model", category: "model", name: "Model", type: "select", currentValue: currentModel,
    options: [{ value: "model-a", name: "Model A" }, { value: "model-b", name: "Model B" }],
  }, ...nativeMode ? [{
    id: "native-mode", category: "mode", name: "Native mode", type: "select" as const,
    currentValue: currentMode, options: [{ value: "default", name: "Agent" }, { value: "plan", name: "Plan" }],
  }] : []]
}

const connection = acp.agent({ name: "deskfleet-mode-fixture" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: loadSession ? { loadSession: true } : { sessionCapabilities: { resume: {} } },
  }))
  .onRequest(acp.methods.agent.session.new, () => ({
    sessionId: "modes-session", configOptions: options(), modes,
  }))
  .onRequest(acp.methods.agent.session.resume, () => ({
    ...omitResume ? {} : { configOptions: options(), modes: { ...modes, currentModeId: currentMode } },
    _meta: { currentMode, currentModel },
  }))
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "history" } },
    })
    currentMode = "plan"
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: currentMode },
    })
    return { configOptions: options(), modes: { ...modes, currentModeId: currentMode } }
  })
  .onRequest(acp.methods.agent.session.setMode, async ({ params, client }) => {
    if (nativeMode) throw acp.RequestError.internalError({ details: "Native config must take precedence" })
    if (params.modeId === "rejected") throw acp.RequestError.internalError({ details: "Mode rejected" })
    currentMode = params.modeId === "fallback" ? "default" : params.modeId
    if (params.modeId === "fallback") await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: currentMode },
    })
    return {}
  })
  .onRequest(acp.methods.agent.session.setConfigOption, async ({ params, client }) => {
    if (params.configId === "model") currentModel = String(params.value)
    else if (nativeMode && params.configId === "native-mode") currentMode = String(params.value)
    else throw acp.RequestError.internalError({ details: "Legacy mode requires session/set_mode" })
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: options() },
    })
    return { configOptions: options() }
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    currentMode = "plan"
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: currentMode },
    })
    return { stopReason: "end_turn" }
  })
  .connect(acp.ndJsonStream(
    Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ))

await connection.closed
