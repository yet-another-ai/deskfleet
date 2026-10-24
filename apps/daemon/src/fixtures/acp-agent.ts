import { writeFileSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

const mode = process.env.DESKFLEET_TEST_AGENT_MODE
const exitFile = process.env.DESKFLEET_TEST_EXIT_FILE
if (exitFile) process.once("exit", code => writeFileSync(exitFile, String(code)))

let completePrompt: ((response: acp.PromptResponse) => void) | undefined
let model = "fixture-model"
const configOptions = (): acp.SessionConfigOption[] => [{
  id: "model", name: "Model", type: "select", category: "model", currentValue: model,
  options: [{ value: "fixture-model", name: "Fixture model" }, { value: "other-model", name: "Other model" }],
}]
const connection = acp.agent({ name: "deskfleet-test-agent" })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => {
    if (mode === "exit-init") process.exit(12)
    if (mode === "wait-init") await new Promise(() => {})
    return {
      protocolVersion: acp.PROTOCOL_VERSION + (mode === "wrong-version" ? 1 : 0),
      agentInfo: { name: "deskfleet-test-agent", version: "1.0.0" },
      agentCapabilities: { promptCapabilities: { image: true } },
      _meta: {
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
    return { sessionId: "fixture-session", configOptions: configOptions(), _meta: { request: params } }
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    if (params.configId !== "model" || typeof params.value !== "string") throw new Error("Unknown configuration")
    model = params.value
    return { configOptions: configOptions() }
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const pending = mode === "wait"
      ? new Promise<acp.PromptResponse>(resolve => { completePrompt = resolve })
      : undefined
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ready" } },
      _meta: { source: "fixture" },
    })
    if (pending) return pending
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
  .onNotification(acp.methods.agent.session.cancel, () => {
    completePrompt?.({ stopReason: "cancelled" })
  })
  .connect(acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ))

await connection.closed
process.exit(0)
