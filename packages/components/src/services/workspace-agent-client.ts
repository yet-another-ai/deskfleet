import type { AgentSignalingApi } from "@deskfleet/client/agent"
import type { SuperAgentApi } from "@deskfleet/client/desktop-api"
import type { SuperSnapshot } from "../../../../apps/daemon/src/super-agent-protocol.ts"
import { AgentClient } from "./agent-client.ts"

/** Each authenticated machine channel has its own ACP handshake. Reconnects never replay mutations. */
export function createWorkspaceAgentClient(signaling: AgentSignalingApi, available: () => boolean) {
  let initialized: Promise<unknown> | undefined
  const client = new AgentClient(signaling, state => {
    if (state === "idle" || state === "error") initialized = undefined
  }, () => {})
  async function call<K extends keyof SuperAgentApi>(name: K, params: Parameters<SuperAgentApi[K]>[0]) {
    if (!available()) throw new Error("Workspace Agent is unavailable on this machine")
    const ready = initialized ??= client.call("initialize", { protocolVersion: 1 })
    try { await ready }
    catch (error) {
      if (initialized === ready) client.close()
      throw error
    }
    if (!available() || initialized !== ready) throw new Error("Workspace Agent connection changed before dispatch")
    return client.call<SuperSnapshot>(`_deskfleet/super-agent/${name}`, params)
  }
  const api: SuperAgentApi = {
    snapshot: params => call("snapshot", params), send: params => call("send", params),
    correct: params => call("correct", params), settings: params => call("settings", params),
  }
  return { api, close: () => client.close() }
}
