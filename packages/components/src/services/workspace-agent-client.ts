import type { AgentSignalingApi } from "@deskfleet/client/agent"
import type { SuperAgentApi } from "@deskfleet/client/desktop-api"
import type { SuperHistory, SuperSnapshot } from "../../../../apps/daemon/src/super-agent-protocol.ts"
import { AgentClient } from "./agent-client.ts"

/** Each authenticated machine channel has its own ACP handshake. Reconnects never replay mutations. */
export function createWorkspaceAgentClient(signaling: AgentSignalingApi, available: () => boolean) {
  let initialized: Promise<unknown> | undefined
  const client = new AgentClient(signaling, state => {
    if (state === "idle" || state === "error") initialized = undefined
  }, () => {})
  async function call<R = SuperSnapshot>(name: keyof SuperAgentApi, params: unknown) {
    if (!available()) throw new Error("Workspace Agent is unavailable on this machine")
    const ready = initialized ??= client.call("initialize", { protocolVersion: 1 })
    try { await ready }
    catch (error) {
      if (initialized === ready) client.close()
      throw error
    }
    if (!available() || initialized !== ready) throw new Error("Workspace Agent connection changed before dispatch")
    return client.call<R>(`_deskfleet/super-agent/${name}`, params)
  }
  const api: SuperAgentApi = {
    history: params => call<SuperHistory>("history", params),
    snapshot: params => call("snapshot", params), send: params => call("send", params),
    stop: params => call("stop", params),
    correct: params => call("correct", params), settings: params => call("settings", params),
  }
  return { api, close: () => client.close() }
}
