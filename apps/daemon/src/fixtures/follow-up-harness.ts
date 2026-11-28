import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BackendAgent } from "../../../../scripts/fixtures/backend-agent.ts"
import type { AgentActor } from "@deskfleet/protocol/agent"
import { AgentProviders } from "../providers/providers.ts"
import { AgentSessions } from "../agent/sessions.ts"
import { DaemonCatalog } from "../machine/catalog.ts"
import { TestAgentQuotas } from "./agent-quotas.ts"
import { MachineOperations } from "../machine/operations.ts"
import { ProviderSetup } from "../providers/setup.ts"
import { ScheduledTasks } from "../schedules/scheduled-tasks.ts"
import type { FollowUpAuthReceipt } from "@deskfleet/protocol/super-agent-follow-up"
import { LocalFollowUpStore } from "../super-agent/follow-up-store.ts"
import { SuperFollowUpService } from "../super-agent/follow-up.ts"
import { type SuperDecisionModel } from "../super-agent/router.ts"
import type { ScheduleCommandHost } from "../super-agent/schedule.ts"
import { SuperAgentService, type SuperUserState } from "../super-agent/service.ts"
import { LocalSuperStore } from "../super-agent/store.ts"
import type { TriageModel } from "../super-agent/triage.ts"
import { superWorkspaces } from "../super-agent/workspaces.ts"
import { TerminalSessions } from "../terminals/terminals.ts"

/** Shared scheduled follow-up harness: temporary SQLite, real scheduler, real Worker journal, scripted ACP provider. */
export async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    assert.ok(Date.now() < deadline, "Timed out waiting for expected state")
    await delay(15)
  }
}

export type ScriptedEvent =
  | { kind: "text"; text: string; phase?: "commentary" | "partial_answer" | "final_answer"; purpose?: "ack" | "activity" | "milestone" | "final_answer"; messageId?: string }
  | { kind: "tool"; title: string }

export interface ScriptedPlan {
  events?: ScriptedEvent[]
  text?: string
}

export function makeAcpToolBackend(planFor: (prompt: string) => ScriptedPlan) {
  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    return {
      ...conn,
      prompt: async params => {
        const promptText = params.prompt.flatMap(b => b.type === "text" ? [b.text] : []).join("\n")
        const plan = planFor(promptText)
        if (plan.events) {
          for (const step of plan.events) {
            if (step.kind === "tool") {
              const toolCallId = `tc-${randomUUID()}`
              await client.onUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId,
                  title: step.title,
                  kind: "read",
                  status: "in_progress",
                },
              })
              await client.onUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId,
                  title: step.title,
                  status: "completed",
                },
              })
            } else {
              const deskfleetMeta: Record<string, unknown> = {}
              if (step.phase) deskfleetMeta.phase = step.phase
              if (step.purpose) deskfleetMeta.purpose = step.purpose
              if (step.messageId) deskfleetMeta.messageId = step.messageId
              await client.onUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: step.text },
                  ...(Object.keys(deskfleetMeta).length ? { _meta: { deskfleet: deskfleetMeta } } : {}),
                },
              })
            }
          }
        } else if (plan.text !== undefined && plan.text.length > 0) {
          await client.onUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: plan.text } },
          })
        }
        return { stopReason: "end_turn" }
      },
    }
  }
  return backend
}

export type FollowUpHarness = Awaited<ReturnType<typeof openHarness>>

export async function openHarness(directory: string, options: {
  backend?: BackendAgent
  model?: SuperDecisionModel
  triageModel?: (userId: string) => TriageModel | undefined
  followUpAuthorize?: (actor: AgentActor) => Promise<AgentActor>
  now?: () => Date
  retryBaseMs?: number
  retryMaxMs?: number
  stallThresholdMs?: number
  stallCheckIntervalMs?: number
} = {}) {
  const catalog = new DaemonCatalog(directory)
  await catalog.init()
  const backend = options.backend ?? new BackendAgent()
  const providers = new AgentProviders(directory, backend)
  await providers.init()
  const quotas = new TestAgentQuotas()
  const agents = new AgentSessions(catalog, catalog.native, backend, providers, undefined, undefined, quotas)
  await agents.init()
  const terminals = new TerminalSessions({ directory: join(directory, "terminals") })
  await terminals.init()
  const setup = new ProviderSetup(terminals, { directory })
  const scheduleAuth = async (actor: AgentActor) => actor
  const followUpAuth = options.followUpAuthorize ?? scheduleAuth
  const superStore = new LocalSuperStore<SuperUserState>(catalog.native)
  await superStore.init()
  const followUpStore = new LocalFollowUpStore(catalog.native)
  await followUpStore.init()
  const schedules = new ScheduledTasks(directory, {
    agents, catalog, providers, authorize: scheduleAuth, now: options.now,
    isSubscribed: (scheduleId, ownerUserId) => {
      const sources = followUpStore.listSources().filter(src => src.sourceKind === "schedule" && src.sourceId === scheduleId)
      const isActive = (uid: string) => {
        const auth = followUpStore.getAuth(uid)
        return !!auth && !auth.globalDisabled && auth.takeoverAllSessions === true && Object.values(auth.grants).some(g => g.enabled)
      }
      if (sources.some(src => src.state.enabled && !src.state.pausedReason && isActive(src.userId))) return true
      if (ownerUserId && isActive(ownerUserId) && !sources.some(src => src.userId === ownerUserId)) {
        return true
      }
      return false
    },
    shouldEmitCreated: ownerUserId => {
      const auth = followUpStore.getAuth(ownerUserId)
      return !!auth && !auth.globalDisabled && auth.takeoverAllSessions === true && Object.values(auth.grants).some(g => g.enabled)
    },
  })
  await schedules.init()
  const operations = new MachineOperations({ agents, catalog, providers, terminals, setup, schedules, capabilities: async () => ({ displays: [], audio: false }) })
  const ws = superWorkspaces(catalog, directory)
  let frontDesk: SuperAgentService | undefined
  const followUp = new SuperFollowUpService({
    followUpStore, superStore, agents, schedules, authorize: followUpAuth,
    workspaces: ws.workspaces,
    historyCatalog: ws.historyCatalog,
    onCatalogChanged: listener => catalog.onChange(() => listener()),
    triageModel: options.triageModel,
    onRoomChanged: (uid, wid, sourceId) => frontDesk?.notifySnapshotDirty(uid, wid, sourceId),
    now: options.now,
    retryBaseMs: options.retryBaseMs ?? 60_000,
    retryMaxMs: options.retryMaxMs ?? 60_000,
    stallThresholdMs: options.stallThresholdMs,
    stallCheckIntervalMs: options.stallCheckIntervalMs ?? 0,
  })
  const scheduleHost: ScheduleCommandHost = {
    handleSchedule: (method, params, actor) => operations.handle(method, params, actor),
    listSchedules: () => schedules.snapshot(),
    subscribeSchedule: params => followUp.subscribeSchedule(params).then(() => {}),
    setAdoptAllSchedules: (enabled, actor, opts) => followUp.setAdoptAllSchedules(enabled, actor, opts),
    isFollowUpAuthorized: uid => followUp.isTakeoverActive(uid),
    getScheduleSubscription: (uid, wid, sid) => followUp.getScheduleSubscription(uid, wid, sid),
    listScheduleRuns: async (uid, wid, sid, limit) => (await followUp.listRuns({ userId: uid, workspaceId: wid, sourceKind: "schedule", sourceId: sid, limit })).runs,
    getScheduleRun: (uid, wid, sid, runId) => followUp.getScheduleRun(uid, wid, sid, runId),
  }
  frontDesk = new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "machine-1" }),
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => options.model ?? (async () => ({ reason: "default", actions: [{ kind: "answer", text: "ok" }] })),
    agents, store: superStore, followUp, schedules: scheduleHost, authorize: followUpAuth,
    providers: () => providers.metadata().providers, ...ws,
  })
  await followUp.init()
  await frontDesk.init()
  return {
    catalog, providers, agents, schedules, operations, superStore, followUpStore, followUp, frontDesk,
    enableAuth: (actor: AgentActor, installationId: string, opts?: { takeoverAllSessions?: boolean }) =>
      frontDesk.handle("_deskfleet/super-agent/followUpAuth", {
        action: "enable",
        installationId,
        deviceLabel: installationId,
        takeoverAllSessions: opts?.takeoverAllSessions ?? true,
      }, actor) as Promise<FollowUpAuthReceipt>,
    disableAuth: (actor: AgentActor, installationId: string) =>
      frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "disable", installationId }, actor) as Promise<FollowUpAuthReceipt>,
    setTakeover: (actor: AgentActor, enabled: boolean, installationId?: string) =>
      enabled
        ? frontDesk.handle("_deskfleet/super-agent/followUpAuth", {
            action: "enable",
            installationId: installationId ?? "inst-default",
            deviceLabel: installationId ?? "inst-default",
            takeoverAllSessions: true,
          }, actor) as Promise<FollowUpAuthReceipt>
        : frontDesk.handle("_deskfleet/super-agent/followUpAuth", {
            action: "configure",
            takeoverAllSessions: false,
          }, actor) as Promise<FollowUpAuthReceipt>,
    async close() {
      await followUp.close()
      await frontDesk.close()
      await schedules.close()
      await agents.close()
      await terminals.close()
      await catalog.close()
    },
  }
}
