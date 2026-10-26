import type * as acp from "@agentclientprotocol/sdk/unstable"
import { agentConfiguration, selectAgentOption, selectReasoningEffort, type AgentConfiguration, type AgentConfigurationParams, type AgentConfigurationSelection } from "./agent-configuration-protocol.ts"
import type { AgentConfig, AgentConnection, AgentProvider } from "./agents/acp.ts"
import { codexProvider } from "./agents/codex.ts"

/** Apply dependent choices against the provider's latest confirmed configuration. */
export async function applyAgentConfiguration(
  agent: AgentConnection, sessionId: string, options: acp.SessionConfigOption[],
  selection: AgentConfigurationSelection,
  changed: (options: acp.SessionConfigOption[]) => void | Promise<void> = () => {},
  force = false,
): Promise<acp.SessionConfigOption[]> {
  for (const step of [
    { value: selection.model, errorId: "model", find: (current: acp.SessionConfigOption[]) => selectAgentOption(current, "model", "model") },
    { value: selection.reasoningEffort, errorId: "reasoning_effort", find: selectReasoningEffort },
    { value: selection.mode, errorId: "mode", find: (current: acp.SessionConfigOption[]) => selectAgentOption(current, "mode", "mode") },
  ]) {
    if (step.value === undefined) continue
    const option = step.find(options)
    if (!option || !option.options.some(choice => choice.id === step.value)) throw new Error(`Unsupported agent ${step.errorId}: ${step.value}`)
    if (force || option.currentValue !== step.value) {
      options = (await agent.setConfigOption({ sessionId, configId: option.id, value: step.value }, options)).configOptions
      // A successful response replaces historical metadata with live state.
      force = false
      await changed(options)
    }
  }
  return options
}

/** Discover choices without starting a prompt or allocating a managed worktree. */
export async function readAgentConfiguration(
  params: AgentConfigurationParams,
  cwd: string,
  dependencies: {
    provider?: AgentProvider; config?: AgentConfig; signal?: AbortSignal; timeoutMs?: number; recoverSelection?: boolean
    onOptions?: (options: acp.SessionConfigOption[]) => void
  } = {},
): Promise<AgentConfiguration> {
  if (!dependencies.provider && params.provider !== "codex") throw new Error("Unsupported agent provider")
  const provider = dependencies.provider ?? codexProvider
  const config = dependencies.config ?? { name: "Codex" }
  const controller = new AbortController()
  const signal = dependencies.signal ? AbortSignal.any([controller.signal, dependencies.signal]) : controller.signal
  signal.throwIfAborted()
  const timeout = setTimeout(() => controller.abort(new Error("Agent configuration request timed out")), dependencies.timeoutMs ?? 45_000)
  let agent: AgentConnection | undefined
  let notifiedOptions: acp.SessionConfigOption[] | undefined
  let aborted!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
  })
  const connecting = Promise.resolve().then(() => provider.connect(config, {
    onUpdate({ update }) {
      if (update.sessionUpdate === "config_option_update") notifiedOptions = update.configOptions
    },
    signal,
  }))
  const discovery = (async () => {
    agent = await connecting
    signal.throwIfAborted()
    const session = await agent.newSession({ cwd, mcpServers: [] })
    let options = session.configOptions ?? notifiedOptions ?? []
    if (dependencies.recoverSelection) {
      // Recovery only inspects choices. A rejected saved model must not prevent
      // selecting its replacement, and a stale effort must not hide model options.
      const model = selectAgentOption(options, "model", "model")
      if (model?.options.some(option => option.id === params.model)) {
        try { options = await applyAgentConfiguration(agent, session.sessionId, options, { model: params.model }) }
        catch { signal.throwIfAborted() }
      }
    } else options = await applyAgentConfiguration(agent, session.sessionId, options, params)
    signal.throwIfAborted()
    dependencies.onOptions?.(options)
    return agentConfiguration(options, { id: params.provider, name: config.name })
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
