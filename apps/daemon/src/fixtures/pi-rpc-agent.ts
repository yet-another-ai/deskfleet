import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)
const logPath = process.env.DESKFLEET_TEST_PI_LOG!
const sessionArgument = args.indexOf("--session")
const sessionFile = sessionArgument >= 0 ? args[sessionArgument + 1]! : join(process.env.PI_CODING_AGENT_DIR!, "fixture-session.json")
const models = [
  { provider: "fixture", id: "first", name: "First model" },
  { provider: "fixture", id: "second", name: "Second model" },
]
type Message = { role: string; content: Array<{ type: string; text: string }> }
let state: { model: typeof models[number]; thinkingLevel: string; messages: Message[] } = existsSync(sessionFile)
  ? JSON.parse(readFileSync(sessionFile, "utf8"))
  : { model: models[0]!, thinkingLevel: "medium", messages: [] }
const record = (value: unknown) => appendFileSync(logPath, `${JSON.stringify(value)}\n`)
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
const save = () => writeFileSync(sessionFile, JSON.stringify(state))
// A real CLI can retain resources after stdin EOF. Only adapter disposal should stop it.
const keepAlive = setInterval(() => {}, 60_000)
process.on("SIGTERM", () => {
  record({ type: "exit", pid: process.pid, signal: "SIGTERM" })
  clearInterval(keepAlive)
  process.exit(0)
})
record({ type: "launch", pid: process.pid, args, cwd: process.cwd(), extra: process.env.DESKFLEET_TEST_VALUE, piCommand: process.env.PI_ACP_PI_COMMAND })
save()

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id: string; type: string; provider?: string; modelId?: string; level?: string; message?: string }
  record(request)
  let data: unknown = {}
  switch (request.type) {
    case "get_state":
      data = { model: state.model, thinkingLevel: state.thinkingLevel, sessionFile, isStreaming: false, messageCount: state.messages.length }
      break
    case "get_available_models":
      data = { models: process.env.DESKFLEET_TEST_PI_AUTH === "missing" ? [] : models }
      break
    case "get_available_thinking_levels":
      data = { levels: ["off", "low", "medium", "high"] }
      break
    case "set_model":
      state.model = models.find(model => model.provider === request.provider && model.id === request.modelId)!
      save()
      data = state.model
      break
    case "set_thinking_level":
      state.thinkingLevel = request.level!
      save()
      break
    case "get_commands":
      data = { commands: [] }
      break
    case "get_messages":
      data = { messages: state.messages }
      break
    case "get_session_stats":
      break
    case "prompt":
      state.messages.push(
        { role: "user", content: [{ type: "text", text: request.message! }] },
        { role: "assistant", content: [{ type: "text", text: "Pi fixture answer" }] },
      )
      save()
      break
    default:
      send({ type: "response", id: request.id, command: request.type, success: false, error: `Unsupported fixture command: ${request.type}` })
      continue
  }
  send({ type: "response", id: request.id, command: request.type, success: true, data })
  if (request.type === "prompt") {
    send({ type: "agent_start" })
    send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Pi fixture thought" } })
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Pi fixture answer" } })
    send({ type: "agent_end" })
    send({ type: "agent_settled" })
  }
}
