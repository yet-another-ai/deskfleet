import { client as platformClient, getClient } from "@deskfleet/client/platform"
import type { CentralApi } from "@deskfleet/client/central"
import type { SuperAgentApi } from "@deskfleet/client/desktop-api"
import type { ScheduleInput, ScheduledTask } from "@deskfleet/client/schedules"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { defineComponent, h } from "vue"
import { createMemoryHistory, createRouter, RouterView } from "vue-router"
import { afterEach, expect, test, vi } from "vitest"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import * as accountSessionModule from "../composables/useAccountSession.ts"
import { accountSessionKey, createAccountSession, type AccountSession } from "../composables/useAccountSession.ts"
import { platformClientKey } from "../composables/usePlatformClient.ts"
import { i18n } from "../i18n/index.ts"
import {
  clearFollowUpCacheForAccount, disableFollowUpOnMachine, enableFollowUpOnMachine,
  flushPendingRevocationsForAccount, getClientInstallationId, hasActiveGrantForInstallation,
  hasPendingFollowUpRevocation, listAuthorizedFollowUpScopes, listPendingRevocationsForAccount,
  revokeAllScopesForInstallation, syncAndFlushPendingRevocation,
} from "../services/workspace-agent-follow-up.ts"
import { createFollowUpMachineResolver } from "../services/workspace-agent-follow-up-resolver.ts"
import * as machineRuntimesModule from "../composables/useMachineRuntimes.ts"
import { machineRuntimesKey, type MachineRuntimes } from "../composables/useMachineRuntimes.ts"
import AccountShell from "../AccountShell.vue"
import { router as appRouter } from "../router/index.ts"
import { useWorkspaceAgentMode } from "../services/workspace-agent-navigation.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { useProvidersStore } from "../stores/providers.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import WorkspaceAgentSettings from "../components/settings/WorkspaceAgentSettings.vue"
import ScheduledTasksView from "./ScheduledTasksView.vue"
import WorkspaceAgentView from "./WorkspaceAgentView.vue"

const ConfigurationStub = defineComponent({
  name: "AgentConfigurationSelector",
  props: ["workspaceId", "sessionId", "providerId", "selection", "disabled"],
  emits: ["update:providerId", "update:selection"],
  template: "<div data-configuration />",
})

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
  useWorkspaceAgentMode().value = false
  localStorage.clear()
  i18n.global.locale.value = "en-US"
  vi.restoreAllMocks()
})

test("A9/M5 client follow-up service handles offline revocation, reconnect sync-first, and account isolation", async () => {
  const scope = { serverUrl: "https://deskfleet.test", userId: "u1", teamId: "t1", machineId: "m1" }
  const installationId = getClientInstallationId()
  expect(installationId).toBeTruthy()
  expect(getClientInstallationId()).toBe(installationId)

  // Offline revocation persists pending state and reports confirmed: false
  const offlineApi = { followUpAuth: vi.fn().mockRejectedValue(new Error("Offline")) } as unknown as SuperAgentApi
  const offResult = await disableFollowUpOnMachine(offlineApi, scope, { platform: "darwin" })
  expect(offResult.confirmed).toBe(false)
  expect(hasPendingFollowUpRevocation(scope)).toBe(true)

  // Reconnect flushes status + disable receipt FIRST before any new enable!
  const calls: unknown[] = []
  const onlineApi = {
    followUpAuth: vi.fn(async params => {
      calls.push(params)
      return {
        status: "applied",
        authVersion: calls.length + 1,
        authorized: params.action === "enable",
        activeDeviceCount: params.action === "enable" ? 1 : 0,
        stoppedAllBackground: params.action !== "enable",
        summary: {
          authorized: params.action === "enable", authVersion: calls.length + 1, globalDisabled: false,
          activeDeviceCount: params.action === "enable" ? 1 : 0, devices: [], autoEnrollOrdinarySessions: true,
          ordinarySessionRuleMode: "active", needsConsent: false, subscribedScheduleCount: 0, subscribedSessionCount: 0, pendingTriageCount: 0,
        },
      }
    }),
  } as unknown as SuperAgentApi

  const synced = await syncAndFlushPendingRevocation(onlineApi, scope)
  expect(synced?.stoppedAllBackground).toBe(true)
  expect(hasPendingFollowUpRevocation(scope)).toBe(false)
  expect(calls.map(c => (c as { action: string }).action)).toEqual(["status", "disable"])

  // Subsequent enable syncs status first then enables with expectedAuthVersion
  calls.length = 0
  const enabled = await enableFollowUpOnMachine(onlineApi, scope, { platform: "darwin" })
  expect(enabled.authorized).toBe(true)
  expect(calls.map(c => (c as { action: string }).action)).toEqual(["status", "enable"])

  // Account sign-out clears account cache cleanly
  clearFollowUpCacheForAccount("https://deskfleet.test", "u1")
  expect(hasPendingFollowUpRevocation(scope)).toBe(false)
})

test("Unified Settings Switch & Copy: renders '自动跟进会话与定时任务', '将未归属的会话整理到项目', '查找未归属会话', and '没有需要整理的会话' while keeping existing behavior", async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  let authVersion = 1
  let activeDevices = 1
  let takeoverAllSessions = false // Upgraded Mac: already has active device grant, but unified takeover defaults OFF!
  let failNextEnable: "none" | "throw" | "stale" = "none"

  const followUpAuth = vi.fn(async (params: { action: string; takeoverAllSessions?: boolean }) => {
    if (params.action === "enable") {
      if (failNextEnable === "throw") {
        failNextEnable = "none"
        throw new Error("后台授权服务暂不可用")
      }
      if (failNextEnable === "stale") {
        failNextEnable = "none"
        return {
          status: "stale_ignored" as const, authVersion, authorized: activeDevices > 0, activeDeviceCount: activeDevices,
          stoppedAllBackground: activeDevices === 0,
          summary: {
            authorized: activeDevices > 0, authVersion, globalDisabled: false, activeDeviceCount: activeDevices,
            devices: [], autoEnrollOrdinarySessions: true, ordinarySessionRuleMode: "active" as const,
            takeoverAllSessions: false, adoptAllSchedules: false, pendingAuthScheduleCount: 0,
            needsConsent: false, subscribedScheduleCount: 0, subscribedSessionCount: 0, pendingTriageCount: 0,
          },
        }
      }
      authVersion++
      activeDevices = 2
      if (params.takeoverAllSessions !== undefined) takeoverAllSessions = params.takeoverAllSessions
    } else if (params.action === "disable") {
      authVersion++
      activeDevices = 1
    } else if (params.action === "configure" && params.takeoverAllSessions !== undefined) {
      authVersion++
      takeoverAllSessions = params.takeoverAllSessions
    }
    return {
      status: "applied" as const, authVersion, authorized: activeDevices > 0, activeDeviceCount: activeDevices,
      stoppedAllBackground: activeDevices === 0,
      summary: {
        authorized: activeDevices > 0, authVersion, globalDisabled: activeDevices === 0, activeDeviceCount: activeDevices,
        devices: [], autoEnrollOrdinarySessions: true, ordinarySessionRuleMode: "active" as const,
        takeoverAllSessions, adoptAllSchedules: takeoverAllSessions, pendingAuthScheduleCount: 0,
        needsConsent: false, subscribedScheduleCount: takeoverAllSessions ? 2 : 0, subscribedSessionCount: takeoverAllSessions ? 1 : 0, pendingTriageCount: 0,
      },
    }
  })
  const followUpSources = vi.fn(async () => ({
    workspaceId: null,
    auth: (await followUpAuth({ action: "status" })).summary,
    sources: [],
    adoptableSchedules: [{ id: "sched-old", title: "Legacy cron", workspaceId: "ws-1", enabled: true, targetKind: "directory" as const }],
    adoptableSessions: [{ id: "sess-old", title: "Active worker", workspaceId: "ws-1", updatedAt: "2026-11-23T00:00:00Z", lastEventSeq: "10" }],
  }))

  const history = vi.fn(async () => ({ links: {}, groups: [] }))
  useWorkspaceAgentMode().value = true
  const api = {
    ...getClient(),
    superAgent: {
      snapshot: vi.fn(), send: vi.fn(), correct: vi.fn(), settings: vi.fn(), history,
      followUpAuth, followUpSources, followUpUpdateSource: vi.fn(), followUpRuns: vi.fn(),
    },
  }
  const wrapper = mount(WorkspaceAgentSettings, {
    global: { plugins: [pinia, i18n], provide: { [platformClientKey as symbol]: api } },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })
  await flushPromises()

  // 1. Verbatim 4 Settings strings and ONLY ONE follow-up switch (no old entries, no adopt-all button, no per-session list!)
  expect(wrapper.text()).toContain("自动跟进会话与定时任务")
  expect(wrapper.text()).toContain("将未归属的会话整理到项目")
  expect(wrapper.text()).toContain("查找未归属会话")
  expect(wrapper.text()).not.toContain("让super agent 接管所有会话")
  expect(wrapper.text()).not.toContain("的历史会话")
  expect(wrapper.text()).not.toContain("重新检查")
  expect(wrapper.find("[data-follow-up-takeover-all]").exists()).toBe(true)
  expect(wrapper.find("[data-follow-up-enable]").exists()).toBe(false)
  expect(wrapper.find("[data-follow-up-stop-all]").exists()).toBe(false)
  expect(wrapper.find("[data-follow-up-adopt-all]").exists()).toBe(false)
  expect(wrapper.text()).not.toContain("接管全部定时任务")
  expect(wrapper.text()).not.toContain("Active worker")
  // Clicking "查找未归属会话" preserves history lookup behavior and renders exact empty state "没有需要整理的会话"
  const findBtn = wrapper.findAll("button").find(b => b.text() === "查找未归属会话")
  expect(findBtn?.exists()).toBe(true)
  await findBtn!.trigger("click")
  await flushPromises()
  expect(history).toHaveBeenCalledWith({ view: "groups", assign: undefined })
  expect(wrapper.text()).toContain("没有需要整理的会话")
  expect(wrapper.text()).not.toContain("没有需要整理的目录会话")
  expect(wrapper.findAll("button").some(b => b.text() === "查找未归属会话")).toBe(true)
  expect(wrapper.text()).not.toContain("重新检查")
  // Default OFF on upgraded Mac even when authorized === true!
  expect(wrapper.get("[data-follow-up-takeover-all]").attributes("aria-checked")).toBe("false")

  // 2. Authorization error (throw) MUST keep switch OFF and show error!
  failNextEnable = "throw"
  await wrapper.get("[data-follow-up-takeover-all]").trigger("click")
  await flushPromises()
  expect(wrapper.get("[data-follow-up-takeover-all]").attributes("aria-checked")).toBe("false")
  expect(wrapper.text()).toContain("后台授权服务暂不可用")

  // 3. Stale/rejected authorization MUST keep switch OFF!
  failNextEnable = "stale"
  await wrapper.get("[data-follow-up-takeover-all]").trigger("click")
  await flushPromises()
  expect(wrapper.get("[data-follow-up-takeover-all]").attributes("aria-checked")).toBe("false")
  expect(wrapper.text()).toContain("授权未成功")

  // 4. Successful toggle ON authorizes + enables unified takeover in one step!
  await wrapper.get("[data-follow-up-takeover-all]").trigger("click")
  await flushPromises()
  expect(followUpAuth).toHaveBeenCalledWith(expect.objectContaining({ action: "enable", takeoverAllSessions: true }))
  expect(wrapper.get("[data-follow-up-takeover-all]").attributes("aria-checked")).toBe("true")

  // 5. Toggle OFF stops proactive follow-up cleanly via configure { takeoverAllSessions: false }!
  await wrapper.get("[data-follow-up-takeover-all]").trigger("click")
  await flushPromises()
  expect(followUpAuth).toHaveBeenCalledWith({ action: "configure", takeoverAllSessions: false })
  expect(wrapper.get("[data-follow-up-takeover-all]").attributes("aria-checked")).toBe("false")

  // 6. Turning off SA mode on this device immediately restores classic mode and notes other device stays active!
  await wrapper.get('[aria-labelledby="workspace-agent-mode"]').trigger("click")
  await flushPromises()
  expect(useWorkspaceAgentMode().value).toBe(false)
  expect(wrapper.text()).toContain("台其他设备保持授权")
})

test("M1/M5/A11 ScheduleEditor shows SA follow-up controls only when SA is authorized, and recovers partial failure via Connect existing schedule", async () => {
  const supportedValuesOf = Intl.supportedValuesOf
  vi.spyOn(Intl, "supportedValuesOf").mockImplementation(key => key === "timeZone" ? ["Asia/Shanghai"] : supportedValuesOf(key))
  const pinia = createPinia()
  setActivePinia(pinia)
  const fake = fakeCentral({ machines: [machineFixture("machine-1", "team-1", "Mac Studio")] })
  const schedules: ScheduledTask[] = []
  const rpc = vi.fn(async (_t: string, _m: string, method: string, params: unknown): Promise<unknown> => {
    if (method === "scheduleList") return JSON.parse(JSON.stringify(schedules))
    if (method === "scheduleCreate") {
      const p = params as { schedule: ScheduleInput; operationId?: string; scheduleId?: string }
      const created: ScheduledTask = {
        ...p.schedule, id: p.scheduleId ?? "sched-1",
        createdAt: "2026-11-23T00:00:00Z", updatedAt: "2026-11-23T00:00:00Z", runs: [],
      }
      schedules.push(created)
      return created
    }
    throw new Error(`Unexpected ${method}`)
  })
  fake.central.rpc = rpc as CentralApi["rpc"]
  const account = createAccountSession(fake.central)
  await flushPromises()
  const fleet = useFleetStore()
  fleet.localDesktopTarget.online = true
  vi.spyOn(platformClient.catalog, "list").mockResolvedValue({
    teamId: "team-1", machineId: "machine-1", machineName: "Mac Studio",
    workspaces: [{ id: "ws-1", name: "DeskFleet", worktrees: [{ id: "wt-1", workspaceId: "ws-1", directories: [{ path: "/code/df" }] }] }],
    sessions: [], sessionIds: [],
  })
  await fleet.refreshLocalCatalog()
  const providers = useProvidersStore()
  providers.ready = true; providers.loaded = true
  providers.providers = [{ id: "codex", name: "Codex", template: "codex" }]; providers.selectedId = "codex"
  const agents = useAgentSessionsStore()
  agents.draftConfiguration = { provider: "codex" }

  useWorkspaceAgentMode().value = true
  let failConnectOnce = true
  const followUpUpdateSource = vi.fn(async () => {
    if (failConnectOnce) { failConnectOnce = false; throw new Error("Temporary follow-up store timeout") }
    return { id: "src-1", userId: "u1", workspaceId: "ws-1", sourceKind: "schedule" as const, sourceId: schedules[0]!.id, revision: 1, updatedAt: "2026-11-23T00:00:00Z", state: { enabled: true, deliveryPolicy: "exceptions_only" as const, ownerUserId: "u1" } }
  })
  const followUpSources = vi.fn(async () => ({
    workspaceId: null,
    auth: { authorized: true, authVersion: 1, globalDisabled: false, activeDeviceCount: 1, devices: [], autoEnrollOrdinarySessions: true, ordinarySessionRuleMode: "active" as const, needsConsent: false, subscribedScheduleCount: 0, subscribedSessionCount: 0, pendingTriageCount: 0 },
    sources: [], adoptableSchedules: [], adoptableSessions: [],
  }))
  const api = {
    ...platformClient,
    target: { id: "machine-1", local: true },
    superAgent: {
      snapshot: vi.fn(), send: vi.fn(), correct: vi.fn(), settings: vi.fn(),
      followUpAuth: vi.fn(), followUpSources, followUpUpdateSource, followUpRuns: vi.fn(),
    },
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/schedules/:scheduleId?", name: "schedules", component: ScheduledTasksView, props: true },
      { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: { template: "<div />" } },
      { path: "/sessions/:sessionId", name: "session", component: { template: "<div />" } },
    ],
  })
  await router.push("/schedules/new")
  const wrapper = mount(defineComponent({ render: () => h(RouterView) }), {
    attachTo: document.body,
    global: {
      plugins: [pinia, router, i18n],
      provide: { [accountSessionKey as symbol]: account, [platformClientKey as symbol]: api },
      stubs: { AgentConfigurationSelector: ConfigurationStub, PaneHeader: { template: "<header><slot /></header>" } },
    },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia); account.dispose() })
  await flushPromises()

  // SA follow-up toggle & team visibility hint are visible!
  expect(wrapper.find("[data-schedule-follow-up-toggle]").exists()).toBe(true)
  expect(wrapper.text()).toContain("team schedule visibility scope")

  await wrapper.get('[name="schedule-title"]').setValue("Nightly risk check")
  await wrapper.get('[name="schedule-prompt"]').setValue("Inspect yesterday commits and report only if risks exist")
  await wrapper.get("form").trigger("submit")
  await flushPromises()

  // First connect failed: scheduleCreate ran ONCE with operationId + scheduleId, and UI offers "Connect existing schedule"!
  const creates = rpc.mock.calls.filter(([, , method]) => method === "scheduleCreate")
  expect(creates).toHaveLength(1)
  expect((creates[0]![3] as { operationId?: string; scheduleId?: string }).operationId).toBeTruthy()
  expect((creates[0]![3] as { operationId?: string; scheduleId?: string }).scheduleId).toBeTruthy()
  expect(wrapper.find("[data-schedule-connect-existing]").exists()).toBe(true)

  // Clicking "Connect existing schedule" retries ONLY followUpUpdateSource, NOT scheduleCreate!
  await wrapper.get("[data-schedule-connect-existing]").trigger("click")
  await flushPromises()
  expect(rpc.mock.calls.filter(([, , method]) => method === "scheduleCreate")).toHaveLength(1)
  expect(followUpUpdateSource).toHaveBeenCalledTimes(2)
  expect(router.currentRoute.value.params.scheduleId).toBe(schedules[0]!.id)
})

test("A8/M5 WorkspaceAgentView shows upgraded consent banner without auto-enabling and renders schedule/session provenance links", async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  let authorized = false
  const makeSnapshot = (): SuperSnapshot => ({
    workspaceId: "ws-1",
    provider: "codex",
    supportsProactiveFollowUp: true,
    supportsScheduleCommands: true,
    followUp: {
      authorized, authVersion: authorized ? 1 : 0, globalDisabled: false,
      activeDeviceCount: authorized ? 1 : 0, devices: [], autoEnrollOrdinarySessions: true,
      ordinarySessionRuleMode: "active", takeoverAllSessions: authorized, needsConsent: !authorized,
      subscribedScheduleCount: 1, subscribedSessionCount: 0, pendingTriageCount: 0,
    },
    tickets: [],
    messages: [{
      id: "msg-receipt", role: "assistant", createdAt: "2026-11-23T01:00:00Z",
      text: "Created scheduled task Daily Commit Check.",
      provenance: {
        origin: "schedule_receipt", sourceKind: "schedule", sourceId: "sched-9",
        scheduleId: "sched-9", scheduleTitle: "Daily Commit Check", sessionId: "sess-9",
        evidenceAvailability: "available",
      },
    }],
  })

  const followUpAuth = vi.fn(async (params: { action: string; takeoverAllSessions?: boolean }) => {
    if (params.action === "enable") authorized = true
    const snap = makeSnapshot()
    snap.followUp!.takeoverAllSessions = authorized && params.takeoverAllSessions !== false
    return { status: "applied" as const, authVersion: snap.followUp!.authVersion, authorized, activeDeviceCount: authorized ? 1 : 0, stoppedAllBackground: !authorized, summary: snap.followUp! }
  })
  const superApi: SuperAgentApi = {
    snapshot: vi.fn(async () => makeSnapshot()),
    send: vi.fn(async () => makeSnapshot()),
    correct: vi.fn(async () => makeSnapshot()),
    settings: vi.fn(async () => makeSnapshot()),
    followUpAuth,
    followUpSources: vi.fn(async () => ({ workspaceId: "ws-1", auth: makeSnapshot().followUp!, sources: [], adoptableSchedules: [], adoptableSessions: [] })),
    followUpUpdateSource: vi.fn(),
    followUpRuns: vi.fn(async () => ({ runs: [] })),
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: { template: "<div />" } },
      { path: "/schedules/:scheduleId?", name: "schedules", component: { template: "<div />" } },
      { path: "/sessions/:sessionId", name: "session", component: { template: "<div />" } },
      { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: { template: "<div />" } },
    ],
  })
  const wrapper = mount(WorkspaceAgentView, {
    props: { api: superApi, workspaceId: "ws-1" },
    global: {
      plugins: [pinia, router, i18n],
      provide: { [platformClientKey as symbol]: { ...getClient(), superAgent: superApi } },
      stubs: { PaneHeader: { template: "<header><slot /><slot name='actions' /></header>" }, AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" }, SessionComposer: { template: "<div />" }, ProjectModelMenu: { template: "<div />" } },
    },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })
  await flushPromises()

  // Consent banner shown; NOT auto-authorized!
  expect(wrapper.find("[data-follow-up-consent-banner]").exists()).toBe(true)
  expect(followUpAuth).not.toHaveBeenCalled()
  // Provenance links rendered on message!
  expect(wrapper.find("[data-message-open-schedule]").exists()).toBe(true)
  expect(wrapper.find("[data-message-open-session]").exists()).toBe(true)

  // Explicit user click enables background follow-up!
  await wrapper.get("[data-follow-up-consent-enable]").trigger("click")
  await flushPromises()
  expect(authorized).toBe(true)
  expect(wrapper.find("[data-follow-up-consent-banner]").exists()).toBe(false)
})

test("Phase 1 UI: WorkspaceAgentView shows pending-auth auto-attach banner for SA-created schedules and exposes unified adoptAllSchedules", async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  let authorized = false
  let adoptAllSchedules = false
  const makeSnapshot = (): SuperSnapshot => ({
    workspaceId: "ws-1",
    provider: "codex",
    supportsProactiveFollowUp: true,
    supportsScheduleCommands: true,
    followUp: {
      authorized, authVersion: authorized ? 2 : 1, globalDisabled: false,
      activeDeviceCount: authorized ? 1 : 0, devices: [], autoEnrollOrdinarySessions: true,
      ordinarySessionRuleMode: "active", takeoverAllSessions: authorized, adoptAllSchedules,
      pendingAuthScheduleCount: authorized ? 0 : 1,
      needsConsent: false,
      subscribedScheduleCount: authorized ? 1 : 0, subscribedSessionCount: 0, pendingTriageCount: 0,
    },
    tickets: [],
    messages: [],
  })
  const followUpAuth = vi.fn(async (params: { action: string; adoptAllSchedules?: boolean }) => {
    if (params.action === "enable") authorized = true
    if (params.action === "configure" && params.adoptAllSchedules !== undefined) adoptAllSchedules = params.adoptAllSchedules
    const snap = makeSnapshot()
    return { status: "applied" as const, authVersion: snap.followUp!.authVersion, authorized, activeDeviceCount: authorized ? 1 : 0, stoppedAllBackground: !authorized, summary: snap.followUp! }
  })
  const superApi: SuperAgentApi = {
    snapshot: vi.fn(async () => makeSnapshot()),
    send: vi.fn(async () => makeSnapshot()),
    correct: vi.fn(async () => makeSnapshot()),
    settings: vi.fn(async () => makeSnapshot()),
    followUpAuth,
    followUpSources: vi.fn(async () => ({
      workspaceId: "ws-1",
      auth: makeSnapshot().followUp!,
      sources: [{
        id: "src-1", userId: "u1", workspaceId: "ws-1", sourceKind: "schedule" as const, sourceId: "sched-1",
        revision: 1, updatedAt: "2026-11-24T00:00:00Z",
        state: {
          enabled: authorized,
          ...(authorized ? {} : { pausedReason: "awaiting_authorization" as const }),
          deliveryPolicy: "every_run" as const,
          ownerUserId: "u1",
          scheduleTitle: "Pre-release Check",
        },
      }],
      adoptableSchedules: [],
      adoptableSessions: [],
    })),
    followUpUpdateSource: vi.fn(),
    followUpRuns: vi.fn(async () => ({ runs: [] })),
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: { template: "<div />" } },
      { path: "/schedules/:scheduleId?", name: "schedules", component: { template: "<div />" } },
      { path: "/sessions/:sessionId", name: "session", component: { template: "<div />" } },
      { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: { template: "<div />" } },
    ],
  })
  const wrapper = mount(WorkspaceAgentView, {
    props: { api: superApi, workspaceId: "ws-1" },
    global: {
      plugins: [pinia, router, i18n],
      provide: { [platformClientKey as symbol]: { ...getClient(), superAgent: superApi } },
      stubs: { PaneHeader: { template: "<header><slot /><slot name='actions' /></header>" }, AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" }, SessionComposer: { template: "<div />" }, ProjectModelMenu: { template: "<div />" } },
    },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })
  await flushPromises()

  // Pending-auth banner appears when a schedule is waiting for authorization (even when needsConsent is false).
  expect(wrapper.find("[data-follow-up-consent-banner]").exists()).toBe(true)
  expect(wrapper.text()).toContain("waiting for background follow-up authorization")
  expect(followUpAuth).not.toHaveBeenCalled()

  // Authorizing once clears the banner cleanly!
  await wrapper.get("[data-follow-up-consent-enable]").trigger("click")
  await flushPromises()
  expect(authorized).toBe(true)
  expect(followUpAuth).toHaveBeenCalledWith(expect.objectContaining({ action: "enable" }))
  expect(wrapper.find("[data-follow-up-consent-banner]").exists()).toBe(false)
})

test("A8 mixed-version compatibility: new client against old daemon degrades gracefully without breaking classic UX", async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  useWorkspaceAgentMode().value = true

  // Old daemon: snapshot lacks supportsProactiveFollowUp & supportsScheduleCommands, and followUp* RPCs are absent
  const oldSuperApi: SuperAgentApi = {
    snapshot: vi.fn(async () => ({ workspaceId: "ws-1", provider: "codex", tickets: [], messages: [] })),
    send: vi.fn(async () => ({ workspaceId: "ws-1", provider: "codex", tickets: [], messages: [] })),
    correct: vi.fn(async () => ({ workspaceId: "ws-1", provider: "codex", tickets: [], messages: [] })),
    settings: vi.fn(async () => ({ workspaceId: "ws-1", provider: "codex", tickets: [], messages: [] })),
  }
  const settingsWrapper = mount(WorkspaceAgentSettings, {
    global: {
      plugins: [pinia, i18n],
      provide: { [platformClientKey as symbol]: { ...getClient(), superAgent: oldSuperApi } },
    },
  })
  cleanup.push(() => { settingsWrapper.unmount(); disposePinia(pinia) })
  await flushPromises()
  // Settings clearly informs user that execution machine needs an update for proactive follow-up!
  expect(settingsWrapper.text()).toContain("Update DeskFleet on localhost to enable proactive follow-up and chat scheduling.")
  expect(settingsWrapper.find("[data-follow-up-stop-all]").exists()).toBe(false)
})

test("P1-3 client store: classic mode omits followUpInstallationId while SA-authorized device sends it on create and fork", async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const scope = { serverUrl: "https://deskfleet.test", userId: "u1", teamId: "t1", machineId: "m1" }
  const installationId = getClientInstallationId()
  const mockAuthApi = {
    followUpAuth: vi.fn(async (params: { action: string }) => ({
      status: "applied" as const,
      authVersion: 2,
      authorized: params.action === "enable",
      activeDeviceCount: params.action === "enable" ? 1 : 0,
      stoppedAllBackground: params.action !== "enable",
      summary: {
        authorized: params.action === "enable",
        authVersion: 2,
        globalDisabled: false,
        activeDeviceCount: params.action === "enable" ? 1 : 0,
        devices: [{ installationId, enabled: params.action === "enable", authVersion: 2, updatedAt: "2026-11-23T00:00:00Z" }],
        autoEnrollOrdinarySessions: true,
        ordinarySessionRuleMode: "active" as const,
        needsConsent: false,
        subscribedScheduleCount: 0,
        subscribedSessionCount: 0,
        pendingTriageCount: 0,
      },
    })),
  } as unknown as SuperAgentApi

  const rpcCalls: [string, unknown][] = []
  const fakeSnap = {
    session: {
      id: "sess-1", workspaceId: "ws-1", provider: "codex", title: "Worker", context: "directory",
      lifecycle: "ready", archiveState: "active", lastEventSeq: "1", createdAt: "2026-11-23T00:00:00Z", updatedAt: "2026-11-23T00:00:00Z",
    },
    runs: [], inputs: [], turns: [], permissions: [], elicitations: [],
  }
  const fakeClient = {
    ...getClient(),
    target: { id: "m1", teamId: "t1", local: true },
    agent: {
      ...getClient().agent,
      control: vi.fn(async (method: string, params: unknown) => {
        rpcCalls.push([method, params])
        return fakeSnap
      }),
    },
  }
  const fakeAccount = {
    account: { value: { serverUrl: "https://deskfleet.test", user: { id: "u1", name: "Ada" } } },
    teamId: { value: "t1" },
  }

  let store!: ReturnType<typeof useAgentSessionsStore>
  const Harness = defineComponent({
    setup() {
      store = useAgentSessionsStore()
      return () => h("div")
    },
  })
  const wrapper = mount(Harness, {
    global: {
      plugins: [pinia],
      provide: {
        [platformClientKey as symbol]: fakeClient,
        [accountSessionKey as symbol]: fakeAccount,
      },
    },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })

  // 1. Even if this installation was authorized earlier, switching device to Classic mode OMITS followUpInstallationId!
  await enableFollowUpOnMachine(mockAuthApi, scope)
  expect(hasActiveGrantForInstallation(scope)).toBe(true)
  useWorkspaceAgentMode().value = false
  await store.create("ws-1", "Classic task", "directory", "codex")
  expect((rpcCalls.at(-1)![1] as Record<string, unknown>).followUpInstallationId).toBeUndefined()

  // 2. SA mode ON + authorized grant -> BOTH create AND fork attach verified installationId!
  useWorkspaceAgentMode().value = true
  await store.create("ws-1", "SA task", "directory", "codex")
  expect((rpcCalls.at(-1)![1] as Record<string, unknown>).followUpInstallationId).toBe(installationId)
  await store.fork("sess-1", "directory")
  expect((rpcCalls.at(-1)![1] as Record<string, unknown>).followUpInstallationId).toBe(installationId)

  // 3. After disabling grant on this device -> SA mode ON no longer attaches followUpInstallationId!
  await disableFollowUpOnMachine(mockAuthApi, scope)
  expect(hasActiveGrantForInstallation(scope)).toBe(false)
  await store.create("ws-1", "Unconsented task", "directory", "codex")
  expect((rpcCalls.at(-1)![1] as Record<string, unknown>).followUpInstallationId).toBeUndefined()
})

test("P1-4 multi-machine & multi-team revocation: turning off SA or signing out revokes unopened machines, preserves offline pending revocations across sign-out, isolates accounts, and distinguishes remaining-device vs last-device revocation", async () => {
  const scopeM1 = { serverUrl: "https://deskfleet.test", userId: "user-a", teamId: "team-1", machineId: "mac-studio" }
  const scopeM2 = { serverUrl: "https://deskfleet.test", userId: "user-a", teamId: "team-2", machineId: "linux-box" }
  const inst = getClientInstallationId()

  // Track server-side grant state on BOTH machines independently (Mac Studio ALSO has another device authorized; Linux Box has ONLY this device!)
  const serverGrants: Record<string, Set<string>> = {
    "team-1/mac-studio": new Set(["other-mac-inst"]),
    "team-2/linux-box": new Set(),
  }
  const machineOnline: Record<string, boolean> = {
    "team-1/mac-studio": true,
    "team-2/linux-box": true,
  }
  const makeMachineApi = (key: string): SuperAgentApi => ({
    followUpAuth: vi.fn(async (params: { action: string; installationId?: string }) => {
      if (!machineOnline[key]) throw new Error("Machine is offline")
      const grants = serverGrants[key]!
      if (params.action === "enable" && params.installationId) grants.add(params.installationId)
      if (params.action === "disable" && params.installationId) grants.delete(params.installationId)
      return {
        status: "applied" as const,
        authVersion: 3,
        authorized: grants.size > 0,
        activeDeviceCount: grants.size,
        stoppedAllBackground: grants.size === 0,
        summary: {
          authorized: grants.size > 0,
          authVersion: 3,
          globalDisabled: false,
          activeDeviceCount: grants.size,
          devices: [...grants].map(id => ({ installationId: id, enabled: true, authVersion: 3, updatedAt: "2026-11-23T00:00:00Z" })),
          autoEnrollOrdinarySessions: true,
          ordinarySessionRuleMode: "active" as const,
          needsConsent: false,
          subscribedScheduleCount: 0,
          subscribedSessionCount: 0,
          pendingTriageCount: 0,
        },
      }
    }),
  } as unknown as SuperAgentApi)

  const apiM1 = makeMachineApi("team-1/mac-studio")
  const apiM2 = makeMachineApi("team-2/linux-box")
  const resolveApi = async (scope: { teamId?: string; machineId?: string }) => {
    const key = `${scope.teamId}/${scope.machineId}`
    if (key === "team-1/mac-studio") return { api: apiM1 }
    if (key === "team-2/linux-box") return { api: apiM2 }
    return undefined
  }

  // Authorize BOTH machines across TWO DIFFERENT teams!
  await enableFollowUpOnMachine(apiM1, scopeM1)
  await enableFollowUpOnMachine(apiM2, scopeM2)
  expect(serverGrants["team-1/mac-studio"]!.has(inst)).toBe(true)
  expect(serverGrants["team-2/linux-box"]!.has(inst)).toBe(true)

  // Case 1: Turn OFF SA while Machine 2 (Team 2) was NEVER opened in this session (online)
  // -> BOTH machines receive disable; Machine 1 still has other-mac-inst active; Machine 2 drops to 0 (last grant revoked)!
  const offBothOnline = await revokeAllScopesForInstallation({
    serverUrl: "https://deskfleet.test",
    userId: "user-a",
    resolveApi,
    extraScopes: [scopeM1], // Only M1 is currently open; M2 is discovered from durable grant ledger!
  })
  expect(offBothOnline.allConfirmed).toBe(true)
  expect(offBothOnline.anyOtherDeviceActive).toBe(true)
  expect(offBothOnline.maxOtherActiveDevices).toBe(1)
  expect(serverGrants["team-1/mac-studio"]!.has(inst)).toBe(false)
  expect(serverGrants["team-1/mac-studio"]!.has("other-mac-inst")).toBe(true)
  expect(serverGrants["team-2/linux-box"]!.size).toBe(0)

  // Case 2: Re-authorize both, take Machine 2 OFFLINE, then SIGN OUT (revokeAll + clearFollowUpCacheForAccount)!
  await enableFollowUpOnMachine(apiM1, scopeM1)
  await enableFollowUpOnMachine(apiM2, scopeM2)
  machineOnline["team-2/linux-box"] = false

  const signOutOutcome = await revokeAllScopesForInstallation({
    serverUrl: "https://deskfleet.test",
    userId: "user-a",
    resolveApi,
    extraScopes: [scopeM1],
  })
  clearFollowUpCacheForAccount("https://deskfleet.test", "user-a")

  // Machine 1 confirmed immediately; Machine 2's pending revocation MUST SURVIVE clearFollowUpCacheForAccount!
  expect(signOutOutcome.allConfirmed).toBe(false)
  expect(signOutOutcome.pendingCount).toBe(1)
  expect(hasPendingFollowUpRevocation(scopeM1)).toBe(false)
  expect(hasPendingFollowUpRevocation(scopeM2)).toBe(true)
  expect(serverGrants["team-1/mac-studio"]!.has(inst)).toBe(false)
  expect(serverGrants["team-2/linux-box"]!.has(inst)).toBe(true)

  // Another account (user-b) signing in on this device MUST NOT see or flush user-a's pending revocations!
  expect(listPendingRevocationsForAccount("https://deskfleet.test", "user-b")).toEqual([])
  const userBFlush = await flushPendingRevocationsForAccount({ serverUrl: "https://deskfleet.test", userId: "user-b", resolveApi })
  expect(userBFlush).toEqual([])
  expect(hasPendingFollowUpRevocation(scopeM2)).toBe(true)

  // Same account (user-a) signs back in and Machine 2 comes back online -> pending revocation flushes automatically and clears ONLY after host receipt!
  machineOnline["team-2/linux-box"] = true
  const userAFlush = await flushPendingRevocationsForAccount({ serverUrl: "https://deskfleet.test", userId: "user-a", resolveApi })
  expect(userAFlush).toHaveLength(1)
  expect(userAFlush[0]!.confirmed).toBe(true)
  expect(hasPendingFollowUpRevocation(scopeM2)).toBe(false)
  expect(serverGrants["team-2/linux-box"]!.has(inst)).toBe(false)
  expect(serverGrants["team-2/linux-box"]!.size).toBe(0)
})

test("P1-4 WorkspaceAgentSettings switch-off revokes all authorized machines across teams and reflects offline pending confirmation accurately", async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const fake = fakeCentral({
    machines: [
      { ...machineFixture("m1", "t1", "Mac Studio", true), capabilities: { superAgent: true } },
      { ...machineFixture("m2", "t1", "Offline Build Box", false), capabilities: { superAgent: true } },
    ],
  })
  const account = createAccountSession(fake.central)
  await flushPromises()
  const scopeM1 = { serverUrl: account.account.value.serverUrl, userId: account.account.value.user?.id, teamId: "t1", machineId: "m1" }
  const scopeM2 = { serverUrl: account.account.value.serverUrl, userId: account.account.value.user?.id, teamId: "t1", machineId: "m2" }

  const m1Auth = vi.fn(async (params: { action: string }) => ({
    status: "applied" as const, authVersion: 2, authorized: params.action === "enable",
    activeDeviceCount: params.action === "enable" ? 1 : 0, stoppedAllBackground: params.action !== "enable",
    summary: {
      authorized: params.action === "enable", authVersion: 2, globalDisabled: false,
      activeDeviceCount: params.action === "enable" ? 1 : 0,
      devices: params.action === "enable" ? [{ installationId: getClientInstallationId(), enabled: true, authVersion: 2, updatedAt: "now" }] : [],
      autoEnrollOrdinarySessions: true, ordinarySessionRuleMode: "active" as const,
      needsConsent: false, subscribedScheduleCount: 0, subscribedSessionCount: 0, pendingTriageCount: 0,
    },
  }))
  const m1Super: SuperAgentApi = {
    snapshot: vi.fn(), send: vi.fn(), correct: vi.fn(), settings: vi.fn(),
    followUpAuth: m1Auth, followUpSources: vi.fn(async () => ({ workspaceId: null, auth: (await m1Auth({ action: "status" })).summary, sources: [], adoptableSchedules: [], adoptableSessions: [] })),
    followUpUpdateSource: vi.fn(), followUpRuns: vi.fn(),
  }

  // Record grants on BOTH m1 (open/online) and m2 (never opened & currently offline!)
  await enableFollowUpOnMachine(m1Super, scopeM1)
  await enableFollowUpOnMachine(m1Super, scopeM2)
  m1Auth.mockClear()

  const fakeRuntimes = {
    opened: new Map([["m1", { api: { ...getClient(), target: { id: "m1", teamId: "t1", local: false }, superAgent: m1Super } } as never]]),
    sidebarScrollTop: 0,
    open: vi.fn(),
  } as unknown as MachineRuntimes
  const fleet = useFleetStore()
  fleet.localDesktopTarget.id = "m1"
  fleet.localDesktopTarget.name = "Mac Studio"
  useWorkspaceAgentMode().value = true

  const wrapper = mount(WorkspaceAgentSettings, {
    global: {
      plugins: [pinia, i18n],
      provide: {
        [platformClientKey as symbol]: { ...getClient(), target: { id: "m1", teamId: "t1", local: false }, superAgent: m1Super },
        [accountSessionKey as symbol]: account,
        [machineRuntimesKey as symbol]: fakeRuntimes,
      },
    },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia); account.dispose() })
  await flushPromises()

  // Turn OFF SA switch -> m1 confirmed, m2 offline stays pending confirmation, so UI MUST show waiting-for-confirmation (NOT "stopped")!
  await wrapper.get('[role="switch"]').trigger("click")
  await flushPromises()
  expect(useWorkspaceAgentMode().value).toBe(false)
  expect(hasPendingFollowUpRevocation(scopeM1)).toBe(false)
  expect(hasPendingFollowUpRevocation(scopeM2)).toBe(true)
  expect(wrapper.text()).toContain("Waiting for Mac Studio to confirm stopping background follow-up")
  expect(createFollowUpMachineResolver({ host: getClient(), session: account, runtimes: fakeRuntimes })).toBeTypeOf("function")
})

test("R2 14-P1 client AccountShell: classic device that never enabled SA sends ZERO disable RPCs and creates ZERO pending revocations on sign-out, leaving authorized Mac untouched", async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const serverUrl = "https://deskfleet.test"
  const fake = fakeCentral({
    machines: [
      { ...machineFixture("m-mac", "t1", "Authorized Mac", true), capabilities: { superAgent: true } },
      { ...machineFixture("m-offline", "t1", "Offline Box", false), capabilities: { superAgent: true } },
    ],
  })
  fake.central.status = vi.fn(async () => ({ serverUrl, siteAdmin: false, user: { id: "user-a", name: "Ada", email: "ada@deskfleet.test" } }))

  // Server-side Mac state: Mac's own installation ("mac-inst") is authorized at authVersion = 1.
  let macAuthVersion = 1
  const macServerGrants = new Set<string>(["mac-inst"])
  const macFollowUpAuth = vi.fn(async (params: { action: string; installationId?: string }) => {
    if (params.action === "enable" && params.installationId) {
      macAuthVersion += 1
      macServerGrants.add(params.installationId)
    } else if (params.action === "disable" && params.installationId && macServerGrants.has(params.installationId)) {
      macAuthVersion += 1
      macServerGrants.delete(params.installationId)
    }
    return {
      status: "applied" as const,
      authVersion: macAuthVersion,
      authorized: macServerGrants.size > 0,
      activeDeviceCount: macServerGrants.size,
      stoppedAllBackground: macServerGrants.size === 0,
      summary: {
        authorized: macServerGrants.size > 0,
        authVersion: macAuthVersion,
        globalDisabled: false,
        activeDeviceCount: macServerGrants.size,
        devices: [...macServerGrants].map(id => ({ installationId: id, enabled: true, authVersion: macAuthVersion, updatedAt: "now" })),
        autoEnrollOrdinarySessions: true,
        ordinarySessionRuleMode: "active" as const,
        needsConsent: false,
        subscribedScheduleCount: 1,
        subscribedSessionCount: 0,
        pendingTriageCount: 0,
      },
    }
  })
  const offlineFollowUpAuth = vi.fn(async () => { throw new Error("Offline") })

  const macSuper: SuperAgentApi = {
    snapshot: vi.fn(), send: vi.fn(), correct: vi.fn(), settings: vi.fn(),
    followUpAuth: macFollowUpAuth, followUpSources: vi.fn(), followUpUpdateSource: vi.fn(), followUpRuns: vi.fn(),
  }
  const offlineSuper: SuperAgentApi = {
    snapshot: vi.fn(), send: vi.fn(), correct: vi.fn(), settings: vi.fn(),
    followUpAuth: offlineFollowUpAuth, followUpSources: vi.fn(), followUpUpdateSource: vi.fn(), followUpRuns: vi.fn(),
  }

  let capturedSession!: AccountSession
  const realCreateSession = accountSessionModule.createAccountSession
  vi.spyOn(accountSessionModule, "createAccountSession").mockImplementation((...args) => {
    capturedSession = realCreateSession(...args)
    return capturedSession
  })

  const openedRuntimes = {
    opened: new Map([
      ["m-mac", { api: { ...getClient(), target: { id: "m-mac", teamId: "t1", local: false }, superAgent: macSuper } } as never],
      ["m-offline", { api: { ...getClient(), target: { id: "m-offline", teamId: "t1", local: false }, superAgent: offlineSuper } } as never],
    ]),
    sidebarScrollTop: 0,
    open: vi.fn(),
  } as unknown as MachineRuntimes
  vi.spyOn(machineRuntimesModule, "createMachineRuntimes").mockReturnValue(openedRuntimes)

  // 1. Classic device (SA never enabled, zero grants in localStorage) signs out while BOTH m-mac (online) and m-offline (offline) are open!
  useWorkspaceAgentMode().value = false
  expect(listAuthorizedFollowUpScopes(serverUrl, "user-a")).toEqual([])

  const wrapper1 = mount(AccountShell, {
    props: { host: { ...getClient(), platform: "web", central: fake.central } },
    global: {
      plugins: [pinia, appRouter, i18n],
      stubs: {
        MachineSurface: { template: "<div />" },
        WorkspaceAgentSetupView: { template: "<div />" },
        TeamSwitcher: { template: "<div />" },
        AccountFooter: { template: "<div />" },
        AccountNotices: { template: "<div />" },
        AppUpdateNotice: { template: "<div />" },
      },
    },
  })
  cleanup.push(() => { wrapper1.unmount(); disposePinia(pinia) })
  await flushPromises()

  await capturedSession.signOut()
  await flushPromises()

  // ZERO disable RPCs to either machine, ZERO pending revocations persisted, and Mac's authVersion + active grant remain completely intact!
  expect(macFollowUpAuth).not.toHaveBeenCalled()
  expect(offlineFollowUpAuth).not.toHaveBeenCalled()
  expect(listPendingRevocationsForAccount(serverUrl, "user-a")).toEqual([])
  expect(macAuthVersion).toBe(1)
  expect([...macServerGrants]).toEqual(["mac-inst"])

  // 2. Contrast: An SA-authorized device that DID authorize m-mac (but NOT m-offline) signs out -> revokes ONLY m-mac (its own grant), never m-offline!
  const scopeMac = { serverUrl, userId: "user-a", teamId: "t1", machineId: "m-mac" }
  await enableFollowUpOnMachine(macSuper, scopeMac, { platform: "web" })
  macFollowUpAuth.mockClear()
  expect(macServerGrants.has(getClientInstallationId())).toBe(true)

  // Restore signed-in status on central before second AccountShell sign-out
  fake.central.status = vi.fn(async () => ({ serverUrl, siteAdmin: false, user: { id: "user-a", name: "Ada", email: "ada@deskfleet.test" } }))
  await capturedSession.reload()
  await flushPromises()
  await capturedSession.signOut()
  await flushPromises()

  expect(macFollowUpAuth.mock.calls.some(([p]) => (p as { action: string }).action === "disable")).toBe(true)
  expect(offlineFollowUpAuth).not.toHaveBeenCalled()
  expect(macServerGrants.has(getClientInstallationId())).toBe(false)
  expect(macServerGrants.has("mac-inst")).toBe(true)
  expect(listPendingRevocationsForAccount(serverUrl, "user-a")).toEqual([])
})

test("D5a copy: WorkspaceAgentView main-chat consent and pending-auth banners use verbatim '自动跟进会话与定时任务' in zh-cmn-Hans-CN", async () => {
  const prevLocale = i18n.global.locale.value
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  cleanup.push(() => { i18n.global.locale.value = prevLocale })

  const mountBanner = async (pendingAuthScheduleCount: number) => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const snap: SuperSnapshot = {
      workspaceId: "ws-1",
      provider: "codex",
      supportsProactiveFollowUp: true,
      supportsScheduleCommands: true,
      followUp: {
        authorized: false, authVersion: 1, globalDisabled: false,
        activeDeviceCount: 0, devices: [], autoEnrollOrdinarySessions: true,
        ordinarySessionRuleMode: "active", takeoverAllSessions: false, adoptAllSchedules: false,
        pendingAuthScheduleCount, needsConsent: pendingAuthScheduleCount === 0,
        subscribedScheduleCount: 0, subscribedSessionCount: 0, pendingTriageCount: 0,
      },
      tickets: [],
      messages: [],
    }
    const superApi: SuperAgentApi = {
      snapshot: vi.fn(async () => snap),
      send: vi.fn(async () => snap),
      correct: vi.fn(async () => snap),
      settings: vi.fn(async () => snap),
      followUpAuth: vi.fn(),
      followUpSources: vi.fn(async () => ({ workspaceId: "ws-1", auth: snap.followUp!, sources: [], adoptableSchedules: [], adoptableSessions: [] })),
      followUpUpdateSource: vi.fn(),
      followUpRuns: vi.fn(async () => ({ runs: [] })),
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/", name: "new-session", component: { template: "<div />" } },
        { path: "/schedules/:scheduleId?", name: "schedules", component: { template: "<div />" } },
        { path: "/sessions/:sessionId", name: "session", component: { template: "<div />" } },
        { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: { template: "<div />" } },
      ],
    })
    const wrapper = mount(WorkspaceAgentView, {
      props: { api: superApi, workspaceId: "ws-1" },
      global: {
        plugins: [pinia, router, i18n],
        provide: { [platformClientKey as symbol]: { ...getClient(), superAgent: superApi } },
        stubs: { PaneHeader: { template: "<header><slot /><slot name='actions' /></header>" }, AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" }, SessionComposer: { template: "<div />" }, ProjectModelMenu: { template: "<div />" } },
      },
    })
    cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })
    await flushPromises()
    return wrapper
  }

  // 1. Standard consent banner
  const consentBanner = (await mountBanner(0)).get("[data-follow-up-consent-banner]")
  expect(consentBanner.get("[data-follow-up-consent-enable]").text()).toBe("自动跟进会话与定时任务")
  expect(consentBanner.text()).toContain("自动跟进会话与定时任务")
  expect(consentBanner.text()).toContain("无需逐条选择")
  expect(consentBanner.text()).not.toContain("在 localhost 上开启后台跟进")

  // 2. Pending-auth banner (SA created schedule before authorization)
  const pendingBanner = (await mountBanner(2)).get("[data-follow-up-consent-banner]")
  expect(pendingBanner.get("[data-follow-up-consent-enable]").text()).toBe("自动跟进会话与定时任务")
  expect(pendingBanner.text()).toContain("自动跟进会话与定时任务")
  expect(pendingBanner.text()).toContain("无需重建或逐条选择")
})

test("Follow-up UI redesign: top bar removes standalone panel, integrates runs into 事项 without duplicates or cross-run mixups, and layers SA summary vs expandable execution details", async () => {
  const prevLocale = i18n.global.locale.value
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  cleanup.push(() => { i18n.global.locale.value = prevLocale })

  const pinia = createPinia()
  setActivePinia(pinia)
  const snap: SuperSnapshot = {
    workspaceId: "ws-1",
    provider: "codex",
    workerProviders: [{ id: "codex", name: "Codex" }, { id: "antigravity", name: "Antigravity" }],
    supportsProactiveFollowUp: true,
    supportsScheduleCommands: true,
    followUp: {
      authorized: true, authVersion: 2, globalDisabled: false,
      activeDeviceCount: 1, devices: [], autoEnrollOrdinarySessions: true,
      ordinarySessionRuleMode: "active", takeoverAllSessions: true, adoptAllSchedules: true,
      pendingAuthScheduleCount: 0, needsConsent: false,
      subscribedScheduleCount: 2, subscribedSessionCount: 0, pendingTriageCount: 0,
    },
    tickets: [
      {
        id: "ticket-existing",
        title: "修复登录回调",
        scope: "跟踪登录回调异常并验证修复",
        summary: "已修复并验证",
        provider: "codex",
        sessionId: "sess-ticket",
        updatedAt: "2026-11-26T08:00:00Z",
      },
    ],
    followUpRuns: [
      {
        id: "run-rec-linked",
        userId: "u1",
        workspaceId: "ws-1",
        sourceKind: "schedule",
        sourceId: "sched-login",
        runKey: "run:r-linked",
        scheduleId: "sched-login",
        scheduleTitle: "登录回归巡检",
        runId: "r-linked",
        sessionId: "sess-ticket",
        provider: "codex",
        startedAt: "2026-11-26T08:30:00Z",
        finishedAt: "2026-11-26T08:31:00Z",
        status: "completed",
        deliveryPolicy: "every_run",
        delivered: true,
        deliveredMessageId: "msg-linked",
        ticketId: "ticket-existing",
        summary: "登录回归巡检已完成：回调全部通过，暂无需操作。",
        detail: "LOGIN_LINKED_RAW_DETAIL_200_OK",
        evidenceAvailability: "available",
        createdAt: "2026-11-26T08:30:00Z",
        updatedAt: "2026-11-26T08:31:00Z",
      },
      {
        id: "run-rec-2",
        userId: "u1",
        workspaceId: "ws-1",
        sourceKind: "schedule",
        sourceId: "sched-update",
        runKey: "run:r-2",
        scheduleId: "sched-update",
        scheduleTitle: "检查 deskfleet 更新",
        runId: "r-2",
        sessionId: "sess-run-2",
        provider: "antigravity",
        startedAt: "2026-11-26T10:00:00Z",
        finishedAt: "2026-11-26T10:02:00Z",
        status: "failed",
        deliveryPolicy: "every_run",
        delivered: true,
        deliveredMessageId: "msg-run-2",
        summary: "第二次「检查 deskfleet 更新」执行失败：GitHub API 超时，未完成版本核对，需要你重试或打开执行会话排查。",
        detail: "RUN_2_RAW_ERROR_TRACE_GITHUB_504",
        error: "GitHub API timeout (504)",
        evidenceAvailability: "available",
        createdAt: "2026-11-26T10:00:00Z",
        updatedAt: "2026-11-26T10:02:00Z",
      },
      {
        id: "run-rec-1",
        userId: "u1",
        workspaceId: "ws-1",
        sourceKind: "schedule",
        sourceId: "sched-update",
        runKey: "run:r-1",
        scheduleId: "sched-update",
        scheduleTitle: "检查 deskfleet 更新",
        runId: "r-1",
        sessionId: "sess-run-1",
        provider: "antigravity",
        startedAt: "2026-11-26T09:00:00Z",
        finishedAt: "2026-11-26T09:02:00Z",
        status: "completed",
        deliveryPolicy: "every_run",
        delivered: true,
        deliveredMessageId: "msg-run-1",
        summary: "第一次「检查 deskfleet 更新」结论：最新正式版仍为 v0.23.0，建议暂缓整并 main；未完成合入；需确认是否先合入终端修复。",
        detail: "RUN_1_FULL_RAW_REPORT_TABLE_CONFLICT_18",
        evidenceAvailability: "available",
        createdAt: "2026-11-26T09:00:00Z",
        updatedAt: "2026-11-26T09:02:00Z",
      },
    ],
    messages: [
      {
        id: "msg-linked",
        role: "assistant",
        createdAt: "2026-11-26T08:31:00Z",
        ticketId: "ticket-existing",
        sessionId: "sess-ticket",
        text: "登录回归巡检已完成：回调全部通过，暂无需操作。",
        provenance: {
          origin: "sa_follow_up",
          sourceKind: "schedule",
          sourceId: "sched-login",
          scheduleId: "sched-login",
          scheduleTitle: "登录回归巡检",
          runId: "r-linked",
          runKey: "run:r-linked",
          runStatus: "completed",
          provider: "codex",
          detail: "LOGIN_LINKED_RAW_DETAIL_200_OK",
          sessionId: "sess-ticket",
          evidenceAvailability: "available",
        },
      },
      {
        id: "msg-run-1",
        role: "assistant",
        createdAt: "2026-11-26T09:02:00Z",
        sessionId: "sess-run-1",
        text: "第一次「检查 deskfleet 更新」结论：最新正式版仍为 v0.23.0，建议暂缓整并 main；未完成合入；需确认是否先合入终端修复。",
        provenance: {
          origin: "sa_follow_up",
          sourceKind: "schedule",
          sourceId: "sched-update",
          scheduleId: "sched-update",
          scheduleTitle: "检查 deskfleet 更新",
          runId: "r-1",
          runKey: "run:r-1",
          runStatus: "completed",
          provider: "antigravity",
          detail: "RUN_1_FULL_RAW_REPORT_TABLE_CONFLICT_18",
          sessionId: "sess-run-1",
          evidenceAvailability: "available",
        },
      },
      {
        id: "msg-run-2",
        role: "assistant",
        createdAt: "2026-11-26T10:02:00Z",
        sessionId: "sess-run-2",
        text: "第二次「检查 deskfleet 更新」执行失败：GitHub API 超时，未完成版本核对，需要你重试或打开执行会话排查。",
        provenance: {
          origin: "sa_follow_up",
          sourceKind: "schedule",
          sourceId: "sched-update",
          scheduleId: "sched-update",
          scheduleTitle: "检查 deskfleet 更新",
          runId: "r-2",
          runKey: "run:r-2",
          runStatus: "failed",
          provider: "antigravity",
          detail: "RUN_2_RAW_ERROR_TRACE_GITHUB_504",
          sessionId: "sess-run-2",
          evidenceAvailability: "available",
        },
      },
    ],
  }

  const superApi: SuperAgentApi = {
    snapshot: vi.fn(async () => snap),
    send: vi.fn(async () => snap),
    correct: vi.fn(async () => snap),
    settings: vi.fn(async () => snap),
    followUpAuth: vi.fn(),
    followUpSources: vi.fn(),
    followUpUpdateSource: vi.fn(),
    followUpRuns: vi.fn(async () => ({ runs: [] })),
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: { template: "<div />" } },
      { path: "/schedules/:scheduleId?", name: "schedules", component: { template: "<div />" } },
      { path: "/sessions/:sessionId", name: "session", component: { template: "<div />" } },
      { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: { template: "<div />" } },
    ],
  })
  const wrapper = mount(WorkspaceAgentView, {
    props: { api: superApi, workspaceId: "ws-1" },
    attachTo: document.body,
    global: {
      plugins: [pinia, router, i18n],
      provide: { [platformClientKey as symbol]: { ...getClient(), superAgent: superApi } },
      stubs: {
        PaneHeader: { template: "<header><slot /><slot name='actions' /></header>" },
        AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" },
        SessionComposer: { template: "<div />" },
        ProjectModelMenu: { template: "<div />" },
      },
    },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })
  await flushPromises()

  // 1. Top bar: NO "主动跟进与运行记录" button/panel; "事项" stays in place with deduplicated count (1 existing ticket + 2 standalone runs = 3, NOT 4!)
  expect(wrapper.find("[data-follow-up-menu]").exists()).toBe(false)
  expect(wrapper.get("header").text()).not.toContain("主动跟进与运行记录")
  const ticketsBtn = wrapper.get("[data-tickets-menu]")
  expect(ticketsBtn.text()).toBe("事项（3）")

  // 2. Main chat: collapsed shows ONLY SA summary (no raw detail leaked); expanding shows THIS run's details & session link!
  const msg1 = wrapper.get('[data-super-message="msg-run-1"]')
  const msg2 = wrapper.get('[data-super-message="msg-run-2"]')
  expect(msg1.text()).toContain("第一次「检查 deskfleet 更新」结论")
  expect(msg1.text()).not.toContain("RUN_1_FULL_RAW_REPORT_TABLE_CONFLICT_18")
  expect(msg1.find("[data-execution-details]").exists()).toBe(false)
  expect(msg1.get("[data-execution-toggle]").text()).toContain("检查 deskfleet 更新")

  await msg1.get("[data-execution-toggle]").trigger("click")
  await flushPromises()
  const details1 = msg1.get("[data-execution-details]")
  expect(details1.text()).toContain("Antigravity")
  expect(details1.text()).toContain("已完成")
  expect(details1.text()).toContain("RUN_1_FULL_RAW_REPORT_TABLE_CONFLICT_18")
  expect(details1.text()).not.toContain("RUN_2_RAW_ERROR_TRACE_GITHUB_504")
  expect(details1.get("[data-message-open-session]").attributes("href")).toContain("/sessions/sess-run-1")
  expect(details1.get("[data-message-open-schedule]").attributes("href")).toContain("/schedules/sched-update")

  // Expanding run 2 shows run 2's OWN failure details and sess-run-2 (zero cross-run conflation!)
  await msg2.get("[data-execution-toggle]").trigger("click")
  await flushPromises()
  const details2 = msg2.get("[data-execution-details]")
  expect(details2.text()).toContain("执行失败")
  expect(details2.text()).toContain("RUN_2_RAW_ERROR_TRACE_GITHUB_504")
  expect(details2.text()).not.toContain("RUN_1_FULL_RAW_REPORT_TABLE_CONFLICT_18")
  expect(details2.get("[data-message-open-session]").attributes("href")).toContain("/sessions/sess-run-2")

  // 3. Open 事项 popover: linked run is folded inside existing ticket (NO duplicate in standalone runs!),
  //    and the 2 runs of "检查 deskfleet 更新" appear as 2 distinct items pointing to sess-run-1 and sess-run-2!
  await ticketsBtn.trigger("click")
  await flushPromises()
  const panel = document.body.querySelector('[aria-label="事项"]') as HTMLElement
  expect(panel).toBeTruthy()
  const linkedSection = panel.querySelector("[data-ticket-linked-runs]") as HTMLElement
  expect(linkedSection).toBeTruthy()
  expect(linkedSection.querySelectorAll('[data-ticket-run="run-rec-linked"]')).toHaveLength(1)
  const runsSection = panel.querySelector("[data-ticket-runs-section]") as HTMLElement
  expect(runsSection).toBeTruthy()
  expect(runsSection.querySelector('[data-ticket-run="run-rec-linked"]')).toBeNull()
  const run1Item = runsSection.querySelector('[data-ticket-run="run-rec-1"]') as HTMLElement
  const run2Item = runsSection.querySelector('[data-ticket-run="run-rec-2"]') as HTMLElement
  expect(run1Item).toBeTruthy()
  expect(run2Item).toBeTruthy()
  expect(run1Item.textContent).toContain("RUN_1_FULL_RAW_REPORT_TABLE_CONFLICT_18")
  expect(run1Item.querySelector("[data-ticket-run-open-session]")?.getAttribute("href")).toContain("/sessions/sess-run-1")
  expect(run2Item.textContent).toContain("RUN_2_RAW_ERROR_TRACE_GITHUB_504")
  expect(run2Item.querySelector("[data-ticket-run-open-session]")?.getAttribute("href")).toContain("/sessions/sess-run-2")
})
