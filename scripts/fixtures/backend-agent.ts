import type { AgentClient, AgentConnection, AgentProvider } from "../../apps/daemon/src/agents/acp.ts"

/** Fixture ACP provider deliberately waits for approval so archive must cancel a live turn. */
export class BackendAgent implements AgentProvider {
  id = "codex"
  starts = 0
  closes = 0
  prompts: string[] = []
  resumes: string[] = []
  blockNextCreation = false
  blockedCreations = 0
  async connect(_config: unknown, client: AgentClient): Promise<AgentConnection> {
    this.starts++
    let releaseCreation: (() => void) | undefined
    return {
      initialization: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } },
      newSession: async () => {
        if (this.blockNextCreation) {
          this.blockNextCreation = false; this.blockedCreations++
          await new Promise<void>(resolve => { releaseCreation = resolve })
        }
        return { sessionId: "fixture-conversation", configOptions: [] }
      },
      resume: async params => { this.resumes.push(params.sessionId); return { configOptions: [] } },
      setConfigOption: async () => ({ configOptions: [] }),
      prompt: async params => {
        this.prompts.push(params.prompt.map(block => block.type === "text" ? block.text : "").join(""))
        await client.onUpdate({ sessionId: params.sessionId, update: {
          sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fixture Agent is waiting for approval. 中文\n" },
        } })
        await client.onUpdate({ sessionId: params.sessionId, update: {
          sessionUpdate: "tool_call", toolCallId: "fixture-tool", title: "Read fixture file", status: "pending", rawInput: { path: "README.md" },
        } })
        const decision = await client.requestPermission!({
          sessionId: params.sessionId, toolCall: { toolCallId: "fixture-tool", title: "Read fixture file" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        }, new AbortController().signal)
        return { stopReason: decision.outcome.outcome === "cancelled" ? "cancelled" : "end_turn" }
      },
      steer: async () => ({ outcome: "inactive" }),
      cancel: async () => {},
      close: async () => { this.closes++; releaseCreation?.() },
    }
  }
}
