import type * as acp from "@agentclientprotocol/sdk"
import { agentConfiguration, selectAgentOption, type AgentConfiguration, type AgentConfigurationParams, type AgentConfigurationSelection } from "./agent-configuration-protocol.ts"
import type { AgentConnection, AgentProvider } from "./agents/acp.ts"
import { codexProvider } from "./agents/codex.ts"

/** A model change can replace the available reasoning choices and their default. */
export async function applyAgentConfiguration(
  agent: AgentConnection, sessionId: string, options: acp.SessionConfigOption[],
  selection: AgentConfigurationSelection,
  changed: (options: acp.SessionConfigOption[]) => void | Promise<void> = () => {},
): Promise<acp.SessionConfigOption[]> {
  for (const [category, id, value] of [
    ["model", "model", selection.model],
    ["thought_level", "reasoning_effort", selection.reasoningEffort],
  ] as const) {
    if (value === undefined) continue
    const option = selectAgentOption(options, category, id)
    if (!option || !option.options.some(choice => choice.id === value)) throw new Error(`Unsupported agent ${id}: ${value}`)
    if (option.currentValue !== value) {
      options = (await agent.setConfigOption({ sessionId, configId: option.id, value })).configOptions
      await changed(options)
    }
  }
  return options
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
    const options = await applyAgentConfiguration(agent, session.sessionId, session.configOptions ?? [], params)
    signal.throwIfAborted()
    return agentConfiguration(options, provider.id)
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
