import { readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk/unstable"

if (process.argv[2] === "--version") { console.log("codex-cli 0.171.0"); process.exit(0) }
if (process.argv[2] === "debug" && process.argv[3] === "models") {
  console.log(JSON.stringify({ models: [{ slug: "native", display_name: "Native", visibility: "list", supported_in_api: true,
    default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }] }] }))
  process.exit(0)
}

let capabilities: acp.ClientCapabilities | undefined
let session: acp.NewSessionRequest
let model = "quick"
let effort = "low"
function config(): acp.SessionConfigOption[] {
  const choices = (values: string[]) => values.map(value => ({ value, name: value }))
  return [
    { id: "model", category: "model", name: "Model", type: "select", currentValue: model, options: choices(["quick", "deep"]) },
    { id: "effort", category: "thought_level", name: "Reasoning", type: "select", currentValue: effort,
      options: choices(model === "quick" ? ["low"] : ["medium", "high"]) },
  ]
}
const connection = acp.agent({ name: "routing-fixture" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    capabilities = params.clientCapabilities
    return { protocolVersion: acp.PROTOCOL_VERSION, authMethods: [{ id: "cached_token", name: "Existing fixture account" }], agentCapabilities: {
      sessionCapabilities: { systemPrompt: { mode: { override: {} } } }, promptCapabilities: { image: true },
    } }
  })
  .onRequest(acp.methods.agent.authenticate, () => ({}))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    session = params
    return { sessionId: "ephemeral", configOptions: config() }
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    if (params.configId === "model") { model = String(params.value); effort = model === "deep" ? "medium" : "low" }
    else effort = String(params.value)
    return { configOptions: config() }
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const { sessionId } = params
    const block = params.prompt.find(item => item.type === "text")
    const packet = JSON.parse(block?.text ?? "{}")
    if (packet.stall) return new Promise<acp.PromptResponse>(() => {})
    if (packet.tool) await client.notify(acp.methods.client.session.update, { sessionId, update: {
      sessionUpdate: "tool_call", toolCallId: "call", title: "Rejected tool", status: "pending",
    } })
    const args = process.argv.slice(2)
    const name = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : undefined
    const profile = name && await readFile(join(session.cwd, ".agents", "agents", name + ".md"), "utf8")
    const denied = await client.request(acp.methods.client.session.requestPermission, {
      sessionId, options: [{ optionId: "yes", name: "Grant", kind: "allow_once" }], toolCall: { toolCallId: "probe" },
    })
    let fileDenied = false
    try { await client.request(acp.methods.client.fs.writeTextFile, { sessionId, path: join(session.cwd, "should-not-exist"), content: "probe" }) }
    catch { fileDenied = true }
    const value = { model, effort, packet, account: process.env.TEST_ROUTER_INSTANCE, capabilities, denied, fileDenied,
      sameDirectory: process.cwd() === await realpath(session.cwd), cwd: session.cwd, mcp: session.mcpServers,
      instructions: session.systemPrompt?.mode, args, profile, image: params.prompt.some(item => item.type === "image") }
    const text = packet.invalid ? "not a routing decision" : JSON.stringify(value)
    await client.notify(acp.methods.client.session.update, { sessionId, update: {
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private thought" },
    } })
    for (const chunk of [text.slice(0, 10), text.slice(10)]) await client.notify(acp.methods.client.session.update, {
      sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
    })
    return { stopReason: "end_turn", usage: { totalTokens: 25, inputTokens: 20, outputTokens: 5 } }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>))
await connection.closed
