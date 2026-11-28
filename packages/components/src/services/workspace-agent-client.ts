import type { AgentSignalingApi } from "@deskfleet/client/agent"
import type { SuperAgentApi, SuperFeedbackHandle } from "@deskfleet/client/desktop-api"
import type {
  FollowUpAuthReceipt, FollowUpRunsPage, FollowUpSourceRecord, FollowUpSourcesResponse,
  SuperFeedbackProcessParams, SuperFeedbackProcessResult, SuperFeedbackPush,
  SuperFeedbackSubscribeParams, SuperFeedbackSubscribeResult,
  SuperHistory, SuperMachineSummary, SuperMarkReadParams, SuperSnapshot, SuperWorkspaceSummary,
} from "@deskfleet/protocol/super-agent"
import { AgentClient } from "./agent-client.ts"

interface FeedbackListener {
  workspaceId: SuperFeedbackSubscribeParams["workspaceId"]
  onEvent: (push: SuperFeedbackPush) => void
  onDisconnect?: () => void
}

/** Each authenticated machine channel has its own ACP handshake. Reconnects never replay mutations. */
export function createWorkspaceAgentClient(signaling: AgentSignalingApi, available: () => boolean) {
  let initialized: Promise<unknown> | undefined
  const feedbackListeners = new Map<string, FeedbackListener>()
  const client = new AgentClient(signaling, state => {
    if (state === "idle" || state === "error") {
      initialized = undefined
      if (feedbackListeners.size) {
        const active = [...feedbackListeners.values()]
        feedbackListeners.clear()
        for (const listener of active) listener.onDisconnect?.()
      }
    }
  }, notification => {
    if (notification.method !== "_deskfleet/super-agent/feedback") return
    const push = notification.params as SuperFeedbackPush | undefined
    if (!push || typeof push.subscriptionId !== "string") return
    const listener = feedbackListeners.get(push.subscriptionId)
    if (!listener || listener.workspaceId !== push.workspaceId) return
    listener.onEvent(push)
  })
  async function call<R = SuperSnapshot>(name: string, params: unknown) {
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
  async function subscribeFeedback(
    params: SuperFeedbackSubscribeParams,
    onEvent: (push: SuperFeedbackPush) => void,
    onDisconnect?: () => void,
  ): Promise<SuperFeedbackHandle> {
    const initial = await call<SuperFeedbackSubscribeResult>("feedbackSubscribe", params)
    const subscriptionId = initial.subscriptionId
    feedbackListeners.set(subscriptionId, { workspaceId: params.workspaceId, onEvent, onDisconnect })
    return {
      initial,
      unsubscribe: async () => {
        if (!feedbackListeners.delete(subscriptionId)) return
        if (!available()) return
        try { await call<null>("feedbackUnsubscribe", { subscriptionId }) }
        catch { /* Closing or disconnected channels automatically release server subscriptions. */ }
      },
    }
  }
  const api: SuperAgentApi = {
    history: params => call<SuperHistory>("history", params),
    snapshot: params => call("snapshot", params), send: params => call("send", params),
    stop: params => call("stop", params),
    archiveTicket: params => call("archiveTicket", params),
    linkMessage: params => call("linkMessage", params),
    createTicket: params => call("createTicket", params),
    correct: params => call("correct", params), settings: params => call("settings", params),
    followUpAuth: params => call<FollowUpAuthReceipt>("followUpAuth", params),
    followUpSources: params => call<FollowUpSourcesResponse>("followUpSources", params),
    followUpUpdateSource: params => call<FollowUpSourceRecord>("followUpUpdateSource", params),
    followUpRuns: params => call<FollowUpRunsPage>("followUpRuns", params),
    subscribeFeedback,
    feedbackProcess: (params: SuperFeedbackProcessParams) => call<SuperFeedbackProcessResult>("feedbackProcess", params),
    summary: () => call<SuperMachineSummary>("summary", {}),
    markRead: (params: SuperMarkReadParams) => call<SuperWorkspaceSummary>("markRead", params),
  }
  return { api, close: () => { feedbackListeners.clear(); client.close() } }
}
