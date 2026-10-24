import type * as acp from "@agentclientprotocol/sdk"
import type { AgentConfigOption, AgentConfiguration, AgentConfigurationParams } from "./agent-configuration-protocol.ts"
import type { AgentConnection, AgentProvider } from "./agents/acp.ts"
import { codexProvider } from "./agents/codex.ts"

function selectOption(options: acp.SessionConfigOption[], category: string, id: string): AgentConfigOption | null {
  const option = options.find(option => option.category === category && option.type === "select")
    ?? options.find(option => option.id === id && option.type === "select")
  if (!option || option.type !== "select") return null
  return {
    id: option.id,
    currentValue: option.currentValue,
    options: option.options.flatMap(value => "group" in value ? value.options : [value])
      .map(value => ({ id: value.value, name: value.name })),
  }
}

/** Discover draft choices without starting a prompt or allocating a managed worktree. */
export async function readAgentConfiguration(
  params: AgentConfigurationParams,
  cwd: string,
  dependencies: { provider?: AgentProvider; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AgentConfiguration> {
  if (params.provider !== "codex") throw new Error("Unsupported agent provider")
  const provider = dependencies.provider ?? codexProvider
  const controller = new AbortController()
  const signal = dependencies.signal ? AbortSignal.any([controller.signal, dependencies.signal]) : controller.signal
  signal.throwIfAborted()
  const timeout = setTimeout(() => controller.abort(new Error("Agent configuration request timed out")), dependencies.timeoutMs ?? 45_000)
  let agent: AgentConnection | undefined
  let aborted!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
  })
  const connecting = Promise.resolve().then(() => provider.connect({ name: "Codex" }, { onUpdate() {}, signal }))
  const discovery = (async () => {
    agent = await connecting
    signal.throwIfAborted()
    const session = await agent.newSession({ cwd, mcpServers: [] })
    let options = session.configOptions ?? []
    for (const [category, id, value] of [
      ["model", "model", params.model],
      ["thought_level", "reasoning_effort", params.reasoningEffort],
    ] as const) {
      signal.throwIfAborted()
      if (value === undefined) continue
      const option = selectOption(options, category, id)
      if (!option || !option.options.some(choice => choice.id === value)) throw new Error(`Unsupported agent ${id}: ${value}`)
      if (option.currentValue !== value) {
        options = (await agent.setConfigOption({ sessionId: session.sessionId, configId: option.id, value })).configOptions
      }
    }
    return {
      provider: { id: provider.id, name: "Codex" },
      models: selectOption(options, "model", "model"),
      reasoningEfforts: selectOption(options, "thought_level", "reasoning_effort"),
    }
  })()
  try {
    return await Promise.race([discovery, cancelled])
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener("abort", aborted)
    // Providers observe the signal while initializing; once connected, close()
    // settles any outstanding session request and waits for process shutdown.
    const connection = agent ?? await connecting.catch(() => undefined)
    await connection?.close()
  }
}
