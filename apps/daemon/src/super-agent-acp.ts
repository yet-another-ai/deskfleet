import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { applyAgentConfiguration } from "./agent-configuration.ts"
import { selectAgentOption, selectReasoningEffort } from "./agent-configuration-protocol.ts"
import type { AgentClient, AgentConfig, AgentConnection, AgentProvider } from "./agents/acp.ts"
import { superDecisionInstructions, superDecisionSchema } from "./super-agent-model.ts"
import type { SuperCoordinatorOptions, SuperCoordinatorUsage } from "./super-agent-protocol.ts"
import type { SuperDecisionModel } from "./super-agent-router.ts"

type Instance = { provider: AgentProvider; config: AgentConfig; prepareConfig?: (cwd: string) => Promise<AgentConfig> }
type Session = { agent: AgentConnection; sessionId: string; options: acp.SessionConfigOption[] }
const instructions = superDecisionInstructions + "\nNever invoke tools. Return exactly one JSON object matching this schema:\n" + JSON.stringify(superDecisionSchema)
const instructionBlock = { type: "text" as const, text: instructions }

/** Fresh connection for either metadata or one decision. It never enters the Worker journal. */
async function withRoutingSession<T>(
  instance: Instance, signal: AbortSignal, onUpdate: AgentClient["onUpdate"] | undefined, use: (session: Session) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const cwd = await mkdtemp(join(tmpdir(), "deskfleet-routing-"))
  let agent: AgentConnection | undefined
  let notified: acp.SessionConfigOption[] | undefined
  try {
    const config = instance.prepareConfig ? await instance.prepareConfig(cwd) : instance.config
    agent = await instance.provider.connect({ ...config, cwd, authentication: "existing" }, {
      signal, inferenceOnly: { cwd }, capabilities: { configOptions: true },
      onUpdate(notification) {
        if (notification.update.sessionUpdate === "config_option_update") notified = notification.update.configOptions
        return onUpdate?.(notification)
      },
    })
    signal.throwIfAborted()
    const system = onUpdate && agent.initialization.agentCapabilities?.sessionCapabilities?.systemPrompt
    const session = await agent.newSession({ cwd, mcpServers: [],
      ...(system && { systemPrompt: { mode: system.mode?.override ? "override" : "append", content: [instructionBlock] } }),
    })
    signal.throwIfAborted()
    const result = await use({ agent, sessionId: session.sessionId, options: session.configOptions ?? notified ?? [] })
    signal.throwIfAborted()
    return result
  } finally {
    try { await agent?.close() }
    finally { await rm(cwd, { recursive: true, force: true }) }
  }
}

export function acpCoordinatorOptions(instance: Instance, selected?: string, abort?: AbortSignal): Promise<SuperCoordinatorOptions> {
  const timeout = AbortSignal.timeout(30_000)
  return withRoutingSession(instance, abort ? AbortSignal.any([abort, timeout]) : timeout, undefined, async ({ agent, sessionId, options }) => {
    const models = selectAgentOption(options, "model", "model")
    const defaultModel = models?.currentValue
    const defaults = selectReasoningEffort(options)
    // Ask about the selected model in this same session. Switching a model can replace its effort catalog.
    const other = selected && selected !== defaultModel && models?.options.some(item => item.id === selected)
      ? selectReasoningEffort(await applyAgentConfiguration(agent, sessionId, options, { model: selected })) : undefined
    return {
      defaultModel, defaultReasoningEfforts: defaults?.options.map(item => item.id) ?? [],
      models: (models?.options ?? []).map(({ id, name }) => {
        const efforts = id === defaultModel ? defaults : id === selected ? other : undefined
        return { id, name, reasoningEfforts: efforts?.options.map(item => item.id) ?? [], defaultReasoningEffort: efforts?.currentValue }
      }),
    }
  })
}

export function acpCoordinatorModel(instance: Instance): SuperDecisionModel {
  return async (packet, abort, images, settings) => {
    const deadline = AbortSignal.timeout(120_000)
    const signal = abort ? AbortSignal.any([abort, deadline]) : deadline
    let root: string | undefined
    let output = ""
    let bytes = 0
    let usage: SuperCoordinatorUsage | undefined
    return withRoutingSession(instance, signal, ({ sessionId, update }) => {
      if (sessionId !== root) return
      if (update.sessionUpdate === "usage_update" && update.used > 0) {
        usage = { used: update.used, ...(update.size > 0 && { size: update.size }) }
      }
      if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return
      bytes += Buffer.byteLength(update.content.text)
      if (bytes > 256 * 1024) throw new Error("The routing response exceeded the size limit")
      output += update.content.text
    }, async ({ agent, sessionId, options }) => {
      if (images?.length && !agent.initialization.agentCapabilities?.promptCapabilities?.image) throw new Error("The selected coordinator does not support image input")
      const selection = settings?.selection ?? {}
      const applied = await applyAgentConfiguration(agent, sessionId, options, selection)
      if ((selection.model && selectAgentOption(applied, "model", "model")?.currentValue !== selection.model)
        || (selection.reasoningEffort && selectReasoningEffort(applied)?.currentValue !== selection.reasoningEffort)) {
        throw new Error("The routing agent did not confirm the selected model or reasoning effort")
      }
      signal.throwIfAborted()
      root = sessionId
      const system = agent.initialization.agentCapabilities?.sessionCapabilities?.systemPrompt
      const turn = await agent.prompt({ sessionId, prompt: [
        ...(system ? [] : [instructionBlock]), { type: "text", text: JSON.stringify(packet) }, ...(images ?? []),
      ] })
      signal.throwIfAborted()
      if (turn.stopReason !== "end_turn") throw new Error("The routing agent stopped before completing its decision (" + turn.stopReason + ")")
      const json = output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu, "$1")
      let decision: unknown
      try { decision = JSON.parse(json) }
      catch { throw new Error("The selected routing agent did not return a JSON decision") }
      settings?.onUsage?.(usage ?? (turn.usage && turn.usage.totalTokens > 0 ? { used: turn.usage.totalTokens } : undefined))
      return decision
    })
  }
}
