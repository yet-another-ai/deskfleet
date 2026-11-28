import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { configureClient, getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi, SuperAgentApi } from "@deskfleet/client/desktop-api"
import type { Machine } from "@deskfleet/client/central"
import {
  computeSaSummaryFromSnapshot,
  type FollowUpRunsPage,
  type SuperFeedbackProcessResult,
  type SuperFeedbackPush,
  type SuperMessage,
  type SuperSnapshot,
} from "@deskfleet/protocol/super-agent"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { computed, defineComponent, h, reactive, ref, shallowReactive } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { accountSessionKey, type AccountSession } from "../composables/useAccountSession.ts"
import { createHiddenWorkspaces } from "../composables/useHiddenWorkspaces.ts"
import { machineRuntimesKey, type MachineRuntime, type MachineRuntimes } from "../composables/useMachineRuntimes.ts"
import { platformClientKey } from "../composables/usePlatformClient.ts"
import { createSidebarFilter, useSidebarFilter } from "../composables/useSidebarFilter.ts"
import { createSidebarOrder } from "../composables/useSidebarOrder.ts"
import { createSidebarPanel } from "../composables/useSidebarPanel.ts"
import { createWorkspaceAgentSummary, workspaceAgentSummaryKey } from "../composables/useWorkspaceAgentSummary.ts"
import { i18n } from "../i18n/index.ts"
import { useWorkspaceAgentMode } from "../services/workspace-agent-navigation.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import type { AgentSessionSummary, MachineSummary } from "../stores/fleet-types.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { usePinnedSessionsStore } from "../stores/pinned-sessions.ts"
import { agentSnapshot } from "../test/agent.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import AppSidebar from "../components/sidebar/AppSidebar.vue"
import MachineSection from "../components/sidebar/MachineSection.vue"
import WorkspaceAgentView from "./WorkspaceAgentView.vue"

const originalClient = getClient()
const wrappers: VueWrapper[] = []
let activePinia: ReturnType<typeof createPinia> | undefined

const saMachineFixture = (id: string, teamId: string, name: string, online = true, superAgent = true): Machine => ({
  ...machineFixture(id, teamId, name, online),
  capabilities: { superAgent },
})

const superMessage = (id: string, extra: Partial<SuperMessage> = {}): SuperMessage => ({
  id,
  role: "user",
  text: id,
  createdAt: "2026-11-27T10:00:00.000Z",
  ...extra,
})

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: { template: "<div />" } },
      { path: "/projects/new", name: "new-project", component: { template: "<div />" } },
      { path: "/search", name: "search", component: { template: "<div />" } },
      { path: "/desktops", name: "remote-desktops", component: { template: "<div />" } },
      { path: "/schedules/:scheduleId?", name: "schedules", component: { template: "<div />" } },
      { path: "/sessions/archived", name: "archived-sessions", component: { template: "<div />" } },
      { path: "/sessions/:sessionId", name: "session", component: { template: "<div />" } },
      { path: "/terminals/:terminalId", name: "terminal", component: { template: "<div />" } },
      { path: "/machines/:machineId/control", name: "machine-control", component: { template: "<div />" } },
      { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: { template: "<div />" } },
      { path: "/settings/preferences", name: "settings", component: { template: "<div />" } },
    ],
  })
}

function makeAccount(options: {
  serverUrl?: string
  userId?: string
  teamId?: string
  machineId?: string
  machines?: Machine[]
  connected?: boolean
  central?: ReturnType<typeof fakeCentral>["central"]
} = {}) {
  const { central: defaultCentral } = fakeCentral({ machines: options.machines ?? [machineFixture("local-daemon", options.teamId ?? "team-1", "Studio Mac")] })
  const central = options.central ?? defaultCentral
  const machines = ref<Machine[]>(options.machines ?? [machineFixture("local-daemon", options.teamId ?? "team-1", "Studio Mac")])
  const machineId = ref(options.machineId ?? machines.value[0]?.id ?? "local-daemon")
  const connected = ref(options.connected ?? true)
  const account = ref({
    serverUrl: options.serverUrl ?? "https://fleet.example",
    user: { id: options.userId ?? "alice", name: "Alice", email: "alice@example.test" },
    siteAdmin: false,
  })
  const teamId = ref(options.teamId ?? "team-1")
  return {
    central,
    account,
    connected,
    members: ref([]),
    teamId,
    localMachineId: ref("local-daemon"),
    machineId,
    machine: computed(() => machines.value.find(m => m.id === machineId.value)),
    machines,
    enrollment: ref({ teamId: teamId.value, machineId: "local-daemon" }),
    superAgentEnabled: computed(() => false),
    openMachineRoute: vi.fn(),
    refreshMachines: vi.fn(async () => {}),
    dialog: ref(undefined),
  } as unknown as AccountSession
}

afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  if (activePinia) {
    disposePinia(activePinia)
    activePinia = undefined
  }
  useWorkspaceAgentMode().value = false
  localStorage.clear()
  configureClient(originalClient)
  i18n.global.locale.value = "en-US"
  vi.useRealTimers()
  vi.restoreAllMocks()
  await flushPromises()
})

// 1. Classic mode baseline + zero SA subscription
test("classic mode baseline: projectHome=false uses Worker lastCompletedSeq/lastReadSeq, working state, filter counts, and never calls SA APIs", async () => {
  useWorkspaceAgentMode().value = false
  activePinia = createPinia()
  setActivePinia(activePinia)

  const saApi: SuperAgentApi = {
    snapshot: vi.fn(),
    summary: vi.fn(),
    markRead: vi.fn(),
    send: vi.fn(),
    correct: vi.fn(),
    settings: vi.fn(),
  }
  const client: DeskfleetDesktopApi = {
    ...originalClient,
    superAgent: saApi,
  }
  configureClient(client)

  const router = createTestRouter()
  await router.push("/")

  const sessions = reactive<AgentSessionSummary[]>([
    { id: "w-unread", title: "Unread worker", provider: "Codex", archiveState: "active", lastCompletedSeq: "6", lastReadSeq: "5" },
    { id: "w-working", title: "Working worker", provider: "Codex", archiveState: "active", lastCompletedSeq: "3", lastReadSeq: "3" },
  ])
  const machine = reactive<MachineSummary>({
    id: "local-daemon",
    name: "Studio Mac",
    local: true,
    online: true,
    desktop: false,
    terminals: [],
    sessions: [],
    workspaces: [
      { id: "ws-1", name: "Alpha", directories: [{ path: "/code/alpha" }], terminals: [], sessions },
    ],
  })

  const agents = useAgentSessionsStore(activePinia)
  const liveWorking = agentSnapshot()
  liveWorking.session.id = "w-working"
  liveWorking.turns = [{ id: "t-1", sessionId: "w-working", initialInputId: "i-1", dispatchCommandId: "c-1", runGeneration: 1, state: "running", startedAt: "now" }]
  agents.views["w-working"] = { snapshot: liveWorking, events: [], loading: false, error: null, historySeq: "0", snapshotSeq: "0" }

  const wrapper = mount(MachineSection, {
    props: { machine },
    attachTo: document.body,
    global: {
      plugins: [activePinia, router, i18n],
      provide: { [platformClientKey as symbol]: client },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()

  const filter = useSidebarFilter()
  expect(wrapper.find('[data-workspace-id="ws-1"]').exists()).toBe(true)
  expect(wrapper.find('[data-project-workspace="ws-1"]').exists()).toBe(false)
  expect(wrapper.get('a[href="/sessions/w-unread"]').find("[data-session-unread]").exists()).toBe(true)
  expect(wrapper.get('a[href="/sessions/w-working"]').get("[data-session-working]").attributes("data-session-working")).toBe("working")
  expect(filter.totalUnread.value).toBe(1)
  expect(filter.totalWorking.value).toBe(1)

  filter.filter.value = "unread"
  await flushPromises()
  expect(wrapper.find('a[href="/sessions/w-unread"]').exists()).toBe(true)
  expect(wrapper.find('a[href="/sessions/w-working"]').exists()).toBe(false)

  filter.filter.value = "working"
  await flushPromises()
  expect(wrapper.find('a[href="/sessions/w-unread"]').exists()).toBe(false)
  expect(wrapper.find('a[href="/sessions/w-working"]').exists()).toBe(true)

  sessions[0]!.lastReadSeq = "6"
  await flushPromises()
  expect(filter.totalUnread.value).toBe(0)
  expect(saApi.snapshot).not.toHaveBeenCalled()
  expect(saApi.summary).not.toHaveBeenCalled()
  expect(saApi.markRead).not.toHaveBeenCalled()
  expect(saApi.send).not.toHaveBeenCalled()
})

// 2. Required first acceptance test: cross-mode unread boundary
test("cross-mode acceptance: reading an SA direct reply clears the project red dot in SA mode while preserving the same project's unread Worker red dot in classic mode", async () => {
  activePinia = createPinia()
  setActivePinia(activePinia)

  const saSnapshot = ref<SuperSnapshot>({
    workspaceId: "ws-1",
    provider: "codex",
    tickets: [],
    messages: [
      superMessage("u-1", { role: "user", text: "What branch are we on?", state: "answered" }),
      superMessage("a-1", { role: "assistant", sourceMessageId: "u-1", text: "We are on personal/0.23.", visibleSeq: 1 }),
    ],
  })

  const saApi: SuperAgentApi = {
    snapshot: vi.fn(async () => saSnapshot.value),
    summary: vi.fn(async () => ({
      workspaces: [computeSaSummaryFromSnapshot(saSnapshot.value)],
      generatedAt: "2026-11-27T10:00:05.000Z",
    })),
    markRead: vi.fn(async params => {
      saSnapshot.value = {
        ...saSnapshot.value,
        lastRead: { key: params.key, order: params.order, messageId: params.messageId },
      }
      return computeSaSummaryFromSnapshot(saSnapshot.value)
    }),
    send: vi.fn(async () => saSnapshot.value),
    correct: vi.fn(async () => saSnapshot.value),
    settings: vi.fn(async () => saSnapshot.value),
  }

  const client: DeskfleetDesktopApi = {
    ...originalClient,
    platform: "darwin",
    superAgent: saApi,
  }
  configureClient(client)

  const router = createTestRouter()
  await router.push("/machines/local-daemon/control")

  const account = makeAccount({
    machines: [saMachineFixture("local-daemon", "team-1", "Studio Mac", true, true)],
  })

  const fleet = useFleetStore(activePinia)
  const agents = useAgentSessionsStore(activePinia)
  const markReadSpy = vi.spyOn(agents, "markRead").mockResolvedValue()

  fleet.localDesktopTarget = { id: "local-daemon", name: "Studio Mac", online: true, desktop: false }
  fleet.catalogReady = true
  fleet.catalog = {
    teamId: "team-1",
    machineId: "local-daemon",
    machineName: "Studio Mac",
    workspaces: [
      { id: "ws-1", name: "Project A", worktrees: [{ id: "wt-main", workspaceId: "ws-1", directories: [{ path: "/code/a" }] }] },
    ],
    sessions: [],
    sessionIds: ["worker-1"],
  }
  // Same project has an unread Worker result (lastCompletedSeq 6 > lastReadSeq 5).
  agents.sessions["worker-1"] = {
    ...agentSnapshot().session,
    id: "worker-1",
    workspaceId: "ws-1",
    title: "Background worker",
    archiveState: "active",
    lastCompletedSeq: "6",
    lastReadSeq: "5",
  }

  useWorkspaceAgentMode().value = true
  const showSaConversation = ref(false)
  const Shell = defineComponent({
    setup() {
      return () => h("div", { class: "flex" }, [
        h(AppSidebar),
        showSaConversation.value
          ? h(WorkspaceAgentView, { api: saApi, workspaceId: "ws-1" })
          : h("div", { "data-other-view": "true" }),
      ])
    },
  })

  const wrapper = mount(Shell, {
    attachTo: document.body,
    global: {
      plugins: [activePinia, router, i18n],
      provide: {
        [platformClientKey as symbol]: client,
        [accountSessionKey as symbol]: account,
      },
      stubs: {
        WindowToolbar: true,
        TeamSwitcher: true,
        SidebarNavigation: true,
        PinnedSessions: true,
        AccountNotices: true,
        ProviderUpdateNotice: true,
        AppUpdateNotice: true,
        SidebarFooter: true,
        PaneHeader: { template: '<header><slot /><slot name="actions" /></header>' },
        AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" },
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()

  // Project A has an unread SA direct reply -> project row red dot MUST be visible BEFORE opening SA page!
  expect(wrapper.find('[data-project-workspace="ws-1"] [data-open-project] [data-session-unread]').exists()).toBe(true)

  // Opening SA page while document is hidden MUST NOT clear SA unread!
  const visibilitySpy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  document.dispatchEvent(new Event("visibilitychange"))
  await router.push({ name: "workspace-agent", params: { workspaceId: "ws-1" }, query: { machine: "local-daemon", team: "team-1" } })
  showSaConversation.value = true
  await flushPromises()
  expect(wrapper.find('[data-project-workspace="ws-1"] [data-open-project] [data-session-unread]').exists()).toBe(true)

  // Now the SA page becomes visible and the SA direct reply is in the viewport -> SA unread clears.
  visibilitySpy.mockReturnValue("visible")
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()

  // Project A red dot MUST disappear after reading the SA direct reply!
  expect(wrapper.find('[data-project-workspace="ws-1"] [data-open-project] [data-session-unread]').exists()).toBe(false)
  // Reading SA MUST NOT mark the Worker read!
  expect(markReadSpy).not.toHaveBeenCalled()
  expect(agents.sessions["worker-1"]!.lastReadSeq).toBe("5")

  // Switch back to classic mode -> the Worker red dot MUST still be present!
  showSaConversation.value = false
  useWorkspaceAgentMode().value = false
  await flushPromises()

  expect(wrapper.find('[data-workspace-id="ws-1"]').exists()).toBe(true)
  expect(wrapper.get('a[href="/sessions/worker-1"]').find("[data-session-unread]").exists()).toBe(true)
  expect(wrapper.get('[data-sidebar-filter="unread"]').text()).toContain("1")
})

// 3. Dual-mode replay of the same event set + deduplication + filter expansion + default workspace + collapsed machine + pinned session
test("dual-mode replay & unified sidebar counts: deduplicates same dispatched result across project/child/pinned/header, auto-expands Worker hits, keeps SA hits collapsed, and points unassigned sessions to session route", async () => {
  const runScenario = async (saEnabled: boolean) => {
    localStorage.clear()
    useWorkspaceAgentMode().value = saEnabled
    const pinia = createPinia()
    setActivePinia(pinia)

    const ws1Snapshot: SuperSnapshot = {
      workspaceId: "ws-1",
      provider: "codex",
      delegatedCompletedSeqs: { "worker-delegated": "20" },
      tickets: [{ id: "t-1", title: "Fix bug", scope: "Fix bug", summary: "Done", provider: "codex", sessionId: "worker-delegated", updatedAt: "2026-11-27T10:00:05.000Z" }],
      messages: [
        superMessage("u-1", { role: "user", text: "Fix bug", state: "assigned", ticketId: "t-1" }),
        superMessage("worker:t-1:20", { role: "worker", workerEvent: "result", ticketId: "t-1", sessionId: "worker-delegated", sourceMessageId: "u-1", text: "Fixed.", visibleSeq: 1 }),
      ],
    }
    const ws2Snapshot: SuperSnapshot = {
      workspaceId: "ws-2",
      provider: "codex",
      tickets: [],
      messages: [
        superMessage("u-2", { role: "user", text: "Explain build", state: "answered" }),
        superMessage("a-2", { role: "assistant", sourceMessageId: "u-2", text: "Build uses pnpm.", visibleSeq: 2 }),
      ],
    }
    const defaultSnapshot: SuperSnapshot = {
      workspaceId: null,
      provider: "codex",
      tickets: [],
      messages: [
        superMessage("u-def", { role: "user", text: "Hello", state: "answered" }),
        superMessage("a-def", { role: "assistant", sourceMessageId: "u-def", text: "Hi from default SA!", visibleSeq: 3 }),
      ],
    }

    const saApi: SuperAgentApi = {
      snapshot: vi.fn(async ({ workspaceId }) => workspaceId === "ws-1" ? ws1Snapshot : workspaceId === "ws-2" ? ws2Snapshot : defaultSnapshot),
      summary: vi.fn(async () => ({
        workspaces: [
          computeSaSummaryFromSnapshot(defaultSnapshot),
          computeSaSummaryFromSnapshot(ws1Snapshot),
          computeSaSummaryFromSnapshot(ws2Snapshot),
        ],
        generatedAt: "2026-11-27T10:00:10.000Z",
      })),
      send: vi.fn(),
      correct: vi.fn(),
      settings: vi.fn(),
    }

    const client: DeskfleetDesktopApi = { ...originalClient, platform: "darwin", superAgent: saApi }
    configureClient(client)
    const account = makeAccount({
      machines: [saMachineFixture("local-daemon", "team-1", "Studio Mac", true, true)],
    })
    const router = createTestRouter()
    await router.push("/")

    const fleet = useFleetStore(pinia)
    const agents = useAgentSessionsStore(pinia)
    fleet.localDesktopTarget = { id: "local-daemon", name: "Studio Mac", online: true, desktop: false }
    fleet.catalogReady = true
    fleet.catalog = {
      teamId: "team-1",
      machineId: "local-daemon",
      machineName: "Studio Mac",
      workspaces: [
        { id: "ws-1", name: "Project Delegated", worktrees: [{ id: "wt-1", workspaceId: "ws-1", directories: [{ path: "/code/1" }] }] },
        { id: "ws-2", name: "Project Direct", worktrees: [{ id: "wt-2", workspaceId: "ws-2", directories: [{ path: "/code/2" }] }] },
      ],
      sessions: [{ id: "unassigned-1", sessionId: "unassigned-1", directories: [{ path: "/tmp/loose" }] }],
      sessionIds: ["worker-delegated", "worker-independent", "unassigned-1"],
    }
    agents.sessions["worker-delegated"] = {
      ...agentSnapshot().session, id: "worker-delegated", workspaceId: "ws-1", title: "Delegated Worker", archiveState: "active", lastCompletedSeq: "20", lastReadSeq: "0",
    }
    agents.sessions["worker-independent"] = {
      ...agentSnapshot().session, id: "worker-independent", workspaceId: "ws-1", title: "Independent Worker", archiveState: "active", lastCompletedSeq: "12", lastReadSeq: "5",
    }
    agents.sessions["unassigned-1"] = {
      ...agentSnapshot().session, id: "unassigned-1", workspaceId: undefined, title: "Loose Session", archiveState: "active", lastCompletedSeq: "8", lastReadSeq: "0",
    }
    const wrapper = mount(AppSidebar, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router, i18n],
        provide: { [platformClientKey as symbol]: client, [accountSessionKey as symbol]: account },
        stubs: { WindowToolbar: true, TeamSwitcher: true, SidebarNavigation: true, AccountNotices: true, ProviderUpdateNotice: true, AppUpdateNotice: true, SidebarFooter: true },
      },
    })
    // Pin the same delegated Worker session using the real store API (needs account injection inside component tree)
    usePinnedSessionsStore(pinia).pin("local-daemon", "worker-delegated", "Delegated Worker")
    await flushPromises()

    const filter = useSidebarFilter()
    const totalUnread = filter.totalUnread.value
    const summaryCalls = (saApi.summary as ReturnType<typeof vi.fn>).mock.calls.length

    let details: Record<string, unknown> = { totalUnread, summaryCalls }
    if (saEnabled) {
      // Expand pinned section to inspect delegated Worker pin dot
      await wrapper.get('[data-pinned-sessions] button').trigger("click")
      await flushPromises()
      const pinnedDelegatedUnread = wrapper.get('[data-pinned-session="worker-delegated"]').find("[data-session-unread]").exists()

      // Switch to Unread filter:
      // - ws-1 has SA reply (1) + independent Worker (1) [delegated Worker NOT double-counted!] -> auto-expands to show independent Worker only!
      // - ws-2 has SA-only reply (1) -> stays collapsed, clicking enters project SA!
      // - default workspace has SA reply (1)
      // - unassigned-1 has unread (1) -> auto-expands & links to /sessions/unassigned-1
      // Total unread = 5 (NOT 6!)
      filter.filter.value = "unread"
      await flushPromises()
      const ws1ChildLinks = wrapper.findAll('[data-project-workspace="ws-1"] a[href*="/sessions/"]').map(a => a.attributes("href"))
      const ws2ChildLinks = wrapper.findAll('[data-project-workspace="ws-2"] a[href*="/sessions/"]').map(a => a.attributes("href"))
      const defaultHasUnread = wrapper.find('[data-default-workspace] [data-open-default-workspace] [data-session-unread]').exists()
      const unassignedLink = wrapper.find('a[href*="/sessions/unassigned-1"]').attributes("href")

      // Collapse machine -> machine header shows unread indicator from shared summary
      filter.filter.value = "all"
      fleet.toggleMachine("local-daemon")
      await flushPromises()
      const collapsedHeaderUnread = wrapper.find('[data-machine-id="local-daemon"] > div [data-session-unread]').exists()

      details = { ...details, pinnedDelegatedUnread, ws1ChildLinks, ws2ChildLinks, defaultHasUnread, unassignedLink, collapsedHeaderUnread }
    }

    wrapper.unmount()
    disposePinia(pinia)
    return details
  }

  // Classic mode: 3 unread Worker sessions (worker-delegated, worker-independent, unassigned-1), ZERO SA calls
  const classic = await runScenario(false)
  expect(classic.totalUnread).toBe(3)
  expect(classic.summaryCalls).toBe(0)

  // SA mode: 1 (default SA) + 1 (ws-1 SA) + 1 (ws-1 independent Worker) + 1 (ws-2 SA) + 1 (unassigned-1) = 5 (delegated Worker deduplicated!)
  const sa = await runScenario(true)
  expect(sa.totalUnread).toBe(5)
  expect(sa.summaryCalls).toBeGreaterThan(0)
  expect(sa.pinnedDelegatedUnread).toBe(false)
  expect(sa.ws1ChildLinks).toEqual([expect.stringContaining("/sessions/worker-independent")])
  expect(sa.ws2ChildLinks).toEqual([])
  expect(sa.defaultHasUnread).toBe(true)
  expect(sa.unassignedLink).toContain("/sessions/unassigned-1")
  expect(sa.collapsedHeaderUnread).toBe(true)
})

// 4. Viewport read advancement: scrolling up to older messages MUST NOT clear newer SA unread below viewport
test("viewport read advancement: viewing older messages scrolled up does not clear newer SA unread until the newer message enters the viewport", async () => {
  activePinia = createPinia()
  setActivePinia(activePinia)
  useWorkspaceAgentMode().value = true

  const saSnapshot = ref<SuperSnapshot>({
    workspaceId: "ws-1",
    provider: "codex",
    tickets: [],
    messages: [
      superMessage("u-1", { role: "user", text: "Old question", state: "answered" }),
      superMessage("a-1", { role: "assistant", sourceMessageId: "u-1", text: "Old answer", visibleSeq: 1 }),
      superMessage("u-2", { role: "user", text: "New question", state: "answered" }),
      superMessage("a-2", { role: "assistant", sourceMessageId: "u-2", text: "Brand new answer below fold", visibleSeq: 2 }),
    ],
  })
  const markReadCalls: Array<{ key: string; order: number; messageId: string }> = []
  const saApi: SuperAgentApi = {
    snapshot: vi.fn(async () => saSnapshot.value),
    summary: vi.fn(async () => ({ workspaces: [computeSaSummaryFromSnapshot(saSnapshot.value)], generatedAt: "2026-11-27T10:00:05.000Z" })),
    markRead: vi.fn(async params => {
      markReadCalls.push({ key: params.key, order: params.order, messageId: params.messageId })
      saSnapshot.value = { ...saSnapshot.value, lastRead: { key: params.key, order: params.order, messageId: params.messageId } }
      return computeSaSummaryFromSnapshot(saSnapshot.value)
    }),
    send: vi.fn(),
    correct: vi.fn(),
    settings: vi.fn(),
  }

  const client: DeskfleetDesktopApi = { ...originalClient, platform: "darwin", superAgent: saApi }
  configureClient(client)
  const account = makeAccount({ machines: [saMachineFixture("local-daemon", "team-1", "Studio Mac", true, true)] })
  const summaryStore = createWorkspaceAgentSummary({ host: client, session: account })

  const router = createTestRouter()
  await router.push({ name: "workspace-agent", params: { workspaceId: "ws-1" }, query: { machine: "local-daemon", team: "team-1" } })

  // Mock viewport geometry: viewport is y=[0..300]; a-1 is in viewport [20..80]; a-2 is BELOW the fold [500..560].
  let a2Top = 500
  const origRect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-session-scroll-viewport")) {
      return { top: 0, bottom: 300, left: 0, right: 600, width: 600, height: 300, x: 0, y: 0, toJSON: () => {} } as DOMRect
    }
    const id = this.getAttribute("data-super-message")
    if (id === "a-1") return { top: 20, bottom: 80, left: 0, right: 500, width: 500, height: 60, x: 0, y: 20, toJSON: () => {} } as DOMRect
    if (id === "a-2") return { top: a2Top, bottom: a2Top + 60, left: 0, right: 500, width: 500, height: 60, x: 0, y: a2Top, toJSON: () => {} } as DOMRect
    return origRect.call(this)
  })

  const wrapper = mount(WorkspaceAgentView, {
    props: { api: saApi, workspaceId: "ws-1" },
    attachTo: document.body,
    global: {
      plugins: [activePinia, router, i18n],
      provide: {
        [platformClientKey as symbol]: client,
        [accountSessionKey as symbol]: account,
        [workspaceAgentSummaryKey as symbol]: summaryStore,
      },
      stubs: {
        PaneHeader: { template: '<header><slot /><slot name="actions" /></header>' },
        AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" },
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()

  // Only a-1 (order 1) entered viewport; a-2 (order 2) is below fold -> workspace MUST still be unread!
  expect(summaryStore.machineState("local-daemon")?.workspaces["ws-1"]?.lastRead?.messageId).toBe("a-1")
  expect(summaryStore.machineState("local-daemon")?.workspaces["ws-1"]?.unread).toBe(true)

  // Now scroll down so a-2 enters viewport [180..240]
  a2Top = 180
  const vp = wrapper.get("[data-session-scroll-viewport]")
  await vp.trigger("scroll")
  await flushPromises()

  expect(summaryStore.machineState("local-daemon")?.workspaces["ws-1"]?.lastRead?.messageId).toBe("a-2")
  expect(summaryStore.machineState("local-daemon")?.workspaces["ws-1"]?.unread).toBe(false)
  expect(markReadCalls.at(-1)?.messageId).toBe("a-2")
})

// 5. Unopened machine lightweight summary + unknown-not-zero state
test("unopened machine in SA mode reports unknown until lightweight summary arrives and never loads full conversations", async () => {
  activePinia = createPinia()
  setActivePinia(activePinia)
  useWorkspaceAgentMode().value = true

  let resolveSessions!: (value: unknown[]) => void
  const sessionsPromise = new Promise<unknown[]>(resolve => { resolveSessions = resolve })
  const m2 = saMachineFixture("m-remote", "team-1", "Remote Box", true, false)
  const { central } = fakeCentral({ machines: [m2] })
  const sessionsSpy = vi.fn(() => sessionsPromise)
  const fullSessionSpy = vi.fn()
  const eventsSpy = vi.fn()
  Object.assign(central, { sessions: sessionsSpy, session: fullSessionSpy, events: eventsSpy })

  const account = makeAccount({ machines: [m2], machineId: "m-local", central })
  const client: DeskfleetDesktopApi = { ...originalClient, platform: "darwin", remoteWorkspaceAgent: true }
  configureClient(client)

  const sidebarFilter = createSidebarFilter()
  const summaryStore = createWorkspaceAgentSummary({ host: client, session: account })
  const runtimes: MachineRuntimes = {
    opened: shallowReactive(new Map()),
    sidebarScrollTop: 0,
    sidebarFilter,
    sidebarOrder: createSidebarOrder(computed(() => "scope")),
    sidebarPanel: createSidebarPanel(),
    hiddenWorkspaces: createHiddenWorkspaces(computed(() => "scope")),
    workspaceAgentSummary: summaryStore,
    open: vi.fn(),
  }

  const router = createTestRouter()
  await router.push("/")
  const wrapper = mount(AppSidebar, {
    attachTo: document.body,
    global: {
      plugins: [activePinia, router, i18n],
      provide: {
        [platformClientKey as symbol]: client,
        [accountSessionKey as symbol]: account,
        [machineRuntimesKey as symbol]: runtimes,
        [workspaceAgentSummaryKey as symbol]: summaryStore,
      },
      stubs: { WindowToolbar: true, TeamSwitcher: true, SidebarNavigation: true, PinnedSessions: true, AccountNotices: true, ProviderUpdateNotice: true, AppUpdateNotice: true, SidebarFooter: true },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()

  // Before summary resolves: status is UNKNOWN, NOT zero!
  expect(sidebarFilter.hasUnknown.value).toBe(true)
  expect(wrapper.find('[data-machine-id="m-remote"][data-machine-summary="unknown"]').exists()).toBe(true)
  sidebarFilter.filter.value = "unread"
  await flushPromises()
  // Unknown summary must NOT render "No unread sessions" empty state!
  expect(wrapper.find('[data-filter-unknown]').exists()).toBe(true)
  expect(wrapper.text()).not.toContain(i18n.global.t("sidebar.filterEmptyUnread"))
  expect(sessionsSpy).toHaveBeenCalledWith("team-1", "m-remote")
  expect(fullSessionSpy).not.toHaveBeenCalled()
  expect(eventsSpy).not.toHaveBeenCalled()

  // Resolve lightweight session metadata with 1 unread session
  resolveSessions([{
    session: { ...agentSnapshot().session, id: "s-remote-1", workspaceId: "ws-r", archiveState: "active", lastCompletedSeq: "9", lastReadSeq: "4" },
    turns: [],
    permissions: [],
    elicitations: [],
  }])
  await flushPromises()

  expect(sidebarFilter.hasUnknown.value).toBe(false)
  expect(sidebarFilter.totalUnread.value).toBe(1)
  expect(wrapper.find('[data-machine-id="m-remote"] [data-session-unread]').exists()).toBe(true)
  expect(fullSessionSpy).not.toHaveBeenCalled()
  expect(eventsSpy).not.toHaveBeenCalled()
})

// 6. Working state: SA routing without Worker + permission/question not occluded + Desktop & Web offline pause/resume + read failure keeps stopping
test("SA working icons, permission precedence, Desktop/Web explicit offline pause & draft preservation, and read failure not rewriting stopping", async () => {
  // Part A: SA routing without Worker + permission > working precedence + offline pauses working animation/count while preserving unread
  activePinia = createPinia()
  setActivePinia(activePinia)
  useWorkspaceAgentMode().value = true

  const ws1Snap: SuperSnapshot = {
    workspaceId: "ws-1",
    provider: "codex",
    tickets: [],
    messages: [superMessage("u-route", { role: "user", text: "Answer directly", state: "routing" })],
  }
  const ws2Snap: SuperSnapshot = {
    workspaceId: "ws-2",
    provider: "codex",
    tickets: [{ id: "t-2", title: "Need approval", scope: "Run shell", summary: "", status: "attention", provider: "codex", sessionId: "w-2", updatedAt: "now" }],
    messages: [
      superMessage("u-2", { role: "user", text: "Run shell", state: "routing" }),
      superMessage("a-old", { role: "assistant", sourceMessageId: "u-0", text: "Earlier reply", visibleSeq: 1 }),
    ],
    pendingRequests: [{
      kind: "permission",
      ticketId: "t-2",
      item: { id: "perm-1", sessionId: "w-2", turnId: "turn-1", runGeneration: 1, state: "pending", createdAt: "now", request: { sessionId: "w-2", toolCall: { toolCallId: "tc-1", title: "Run rm" }, options: [] } },
    }],
  }
  const saApi: SuperAgentApi = {
    snapshot: vi.fn(async ({ workspaceId }) => workspaceId === "ws-1" ? ws1Snap : ws2Snap),
    summary: vi.fn(async () => ({
      workspaces: [computeSaSummaryFromSnapshot(ws1Snap), computeSaSummaryFromSnapshot(ws2Snap)],
      generatedAt: "2026-11-27T10:00:05.000Z",
    })),
    send: vi.fn(),
    correct: vi.fn(),
    settings: vi.fn(),
  }
  const client: DeskfleetDesktopApi = { ...originalClient, platform: "darwin", superAgent: saApi }
  configureClient(client)

  const machine = reactive<MachineSummary>({
    id: "local-daemon", name: "Studio Mac", local: true, online: true, desktop: false, terminals: [], sessions: [],
    workspaces: [
      { id: "ws-1", name: "Routing Only", directories: [{ path: "/code/1" }], terminals: [], sessions: [] },
      { id: "ws-2", name: "Waiting Approval", directories: [{ path: "/code/2" }], terminals: [], sessions: [] },
    ],
  })
  const router = createTestRouter()
  await router.push("/")
  const wrapper = mount(MachineSection, {
    props: { machine },
    attachTo: document.body,
    global: { plugins: [activePinia, router, i18n], provide: { [platformClientKey as symbol]: client } },
  })
  wrappers.push(wrapper)
  await flushPromises()

  const filter = useSidebarFilter()
  // SA routing without any Worker still shows working spinner on ws-1 and counts working!
  expect(wrapper.get('[data-project-workspace="ws-1"] [data-session-working]').attributes("data-session-working")).toBe("working")
  // ws-2 has BOTH routing AND pending permission -> permission icon MUST win over working spinner!
  expect(wrapper.get('[data-project-workspace="ws-2"] [data-session-working]').attributes("data-session-working")).toBe("permission")
  expect(filter.totalWorking.value).toBe(2)
  expect(filter.totalUnread.value).toBe(1)

  // Explicit offline: pauses working animations & sets working count to 0, while preserving unread!
  machine.online = false
  await flushPromises()
  expect(wrapper.find('[data-project-workspace="ws-1"] [data-session-working]').exists()).toBe(false)
  expect(wrapper.find('[data-project-workspace="ws-2"] [data-session-working]').exists()).toBe(false)
  expect(wrapper.find('[data-project-workspace="ws-2"] [data-open-project] [data-session-unread]').exists()).toBe(true)
  expect(filter.totalWorking.value).toBe(0)
  expect(filter.totalUnread.value).toBe(1)

  wrapper.unmount()
  disposePinia(activePinia)

  // Part B: Desktop & Web WorkspaceAgentView explicit offline pauses polling, preserves draft, recovers on reconnect;
  // AND a single read failure does NOT rewrite "stopping" to "unconfirmed"!
  for (const platform of ["darwin", "web"] as const) {
    vi.useFakeTimers()
    activePinia = createPinia()
    setActivePinia(activePinia)
    useWorkspaceAgentMode().value = true

    const liveMachine = reactive(saMachineFixture("m-1", "team-1", "Dev Box", true, true))
    const account = makeAccount({ machines: [liveMachine], machineId: "m-1" })
    let failSnapshot = false
    const stoppingSnap = (): SuperSnapshot => ({
      workspaceId: "ws-1",
      provider: "codex",
      supportsStop: true,
      tickets: [{ id: "t-1", title: "Task", scope: "Task", summary: "", status: "working", provider: "codex", sessionId: "s-1", updatedAt: "now" }],
      messages: [
        superMessage("u-stop", { role: "user", text: "Run build", state: "assigned", ticketId: "t-1", revision: 0 }),
        superMessage("d-stop", { role: "assistant", kind: "dispatch", ticketId: "t-1", sourceMessageId: "u-stop", text: "Task", reason: "dispatch", stopState: "stopping" }),
      ],
    })
    const snapshotMock = vi.fn(async () => {
      if (failSnapshot) throw new Error("Temporary network hiccup")
      return stoppingSnap()
    })
    const viewApi: SuperAgentApi = {
      snapshot: snapshotMock,
      send: vi.fn(),
      stop: vi.fn(),
      correct: vi.fn(),
      settings: vi.fn(),
    }
    const viewClient: DeskfleetDesktopApi = {
      ...originalClient,
      platform,
      remoteWorkspaceAgent: platform === "web",
      target: { id: "m-1", teamId: "team-1", local: platform === "darwin" },
      superAgent: viewApi,
    }
    configureClient(viewClient)
    const viewRouter = createTestRouter()
    await viewRouter.push({ name: "workspace-agent", params: { workspaceId: "ws-1" }, query: { machine: "m-1", team: "team-1" } })

    const view = mount(WorkspaceAgentView, {
      props: { api: viewApi, workspaceId: "ws-1" },
      attachTo: document.body,
      global: {
        plugins: [activePinia, viewRouter, i18n],
        provide: { [platformClientKey as symbol]: viewClient, [accountSessionKey as symbol]: account },
        stubs: { PaneHeader: { template: "<header><slot /></header>" }, AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" } },
      },
    })
    wrappers.push(view)
    await flushPromises()
    expect(snapshotMock).toHaveBeenCalledTimes(1)

    // Type draft text
    const textarea = view.get("textarea")
    await textarea.setValue("Draft that must survive offline")

    // Read failure while stopping: reports error, MUST NOT rewrite "stopping" to "unconfirmed"!
    failSnapshot = true
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()
    expect(view.text()).toContain("Temporary network hiccup")
    expect(view.text()).toContain(i18n.global.t("superAgent.progress.stopping"))
    expect(view.text()).not.toContain(i18n.global.t("superAgent.progress.unconfirmed"))

    // Explicit offline: pauses polling completely and preserves draft!
    failSnapshot = false
    const callsBeforeOffline = snapshotMock.mock.calls.length
    liveMachine.online = false
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()
    expect(snapshotMock.mock.calls.length).toBe(callsBeforeOffline)
    expect((view.get("textarea").element as HTMLTextAreaElement).value).toBe("Draft that must survive offline")

    // Reconnect: immediately recovers with a fresh snapshot and still preserves draft!
    liveMachine.online = true
    await flushPromises()
    expect(snapshotMock.mock.calls.length).toBeGreaterThan(callsBeforeOffline)
    expect((view.get("textarea").element as HTMLTextAreaElement).value).toBe("Draft that must survive offline")

    view.unmount()
    disposePinia(activePinia)
    activePinia = undefined
    vi.useRealTimers()
  }
})

// 7. Catalog refresh button: reflects ONLY initial/manual/retry catalog requests, ignores running background tasks
test("SA sidebar refresh button tracks manual refresh and failure retry catalog requests and restores immediately despite running background tasks", async () => {
  activePinia = createPinia()
  setActivePinia(activePinia)
  useWorkspaceAgentMode().value = true

  let resolveCatalog!: () => void
  let resolveMachines!: () => void
  const m1 = saMachineFixture("m1", "team-1", "Mac Studio", true, true)
  const account = makeAccount({ machines: [m1], machineId: "m1" })
  account.refreshMachines = vi.fn(() => new Promise<void>(resolve => { resolveMachines = resolve }))

  const refreshCatalog = vi.fn(() => new Promise<void>(resolve => { resolveCatalog = resolve }))
  const runtime = { refreshCatalog, mount: vi.fn(() => () => {}) } as unknown as MachineRuntime
  const sidebarFilter = createSidebarFilter()
  // Simulate an active background task (working count = 1) running continuously
  sidebarFilter.counts.set("m1", { unread: 0, working: 1 })
  const runtimes: MachineRuntimes = {
    opened: shallowReactive(new Map([["m1", runtime]])),
    sidebarScrollTop: 0,
    sidebarFilter,
    sidebarOrder: createSidebarOrder(computed(() => "scope")),
    sidebarPanel: createSidebarPanel(),
    hiddenWorkspaces: createHiddenWorkspaces(computed(() => "scope")),
    workspaceAgentSummary: createWorkspaceAgentSummary({ session: account }),
    open: vi.fn(() => runtime),
  }
  const client: DeskfleetDesktopApi = { ...originalClient, platform: "darwin", localChannels: { open: vi.fn(), close: vi.fn(), send: vi.fn(), onEvent: vi.fn() } }
  configureClient(client)

  const router = createTestRouter()
  await router.push("/")
  const wrapper = mount(AppSidebar, {
    attachTo: document.body,
    global: {
      plugins: [activePinia, router, i18n],
      provide: { [platformClientKey as symbol]: client, [accountSessionKey as symbol]: account, [machineRuntimesKey as symbol]: runtimes },
      stubs: { WindowToolbar: true, TeamSwitcher: true, SidebarNavigation: true, PinnedSessions: true, MachineSection: true, MachineSidebarSurface: true, AccountNotices: true, ProviderUpdateNotice: true, AppUpdateNotice: true, SidebarFooter: true },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()

  const refreshBtn = () => wrapper.get('button[aria-label="Refresh"]')
  // Background task is running (working=1), yet refresh button is NOT spinning/disabled
  expect(refreshBtn().attributes("data-catalog-refreshing")).toBeUndefined()
  expect(refreshBtn().find("svg").classes()).not.toContain("animate-spin")

  // Manual refresh click -> spinning & disabled while catalog request is in flight
  await refreshBtn().trigger("click")
  await flushPromises()
  expect(refreshBtn().attributes("data-catalog-refreshing")).toBe("true")
  expect(refreshBtn().find("svg").classes()).toContain("animate-spin")
  expect(refreshBtn().attributes("aria-disabled")).toBe("true")

  // Catalog + machines finish -> refresh button immediately restores even while background task is STILL working!
  resolveCatalog()
  resolveMachines()
  await flushPromises()
  expect(refreshBtn().attributes("data-catalog-refreshing")).toBeUndefined()
  expect(refreshBtn().find("svg").classes()).not.toContain("animate-spin")
  expect(sidebarFilter.totalWorking.value).toBe(1)

  // Failure retry button also drives the same catalog refresh feedback and restores upon settlement
  const fleet = useFleetStore(activePinia)
  fleet.catalogError = "Catalog timeout"
  await flushPromises()
  await wrapper.get("[data-catalog-retry]").trigger("click")
  await flushPromises()
  expect(refreshBtn().attributes("data-catalog-refreshing")).toBe("true")
  resolveCatalog()
  resolveMachines()
  await flushPromises()
  expect(refreshBtn().attributes("data-catalog-refreshing")).toBeUndefined()
})

// 8. Resync atomic replacement with smaller cursor + snapshot_dirty coalescing during in-flight stop/send/read
test("useWorkspaceConversation: resyncRequired atomically replaces generation, smaller cursor, and old previews, then continues new pushes; snapshot_dirty during in-flight stop coalesces into one follow-up fetch", async () => {
  activePinia = createPinia()
  setActivePinia(activePinia)
  useWorkspaceAgentMode().value = true

  let pushCb: ((push: SuperFeedbackPush) => void) | undefined
  let closeCb: (() => void) | undefined
  let subCall = 0
  let snapshotPhase: "initial" | "resync" | "post_stop_dirty" = "initial"

  const makeSnap = (phase: typeof snapshotPhase): SuperSnapshot => {
    if (phase === "initial") {
      return {
        workspaceId: "ws-1",
        provider: "codex",
        supportsStop: true,
        supportsReplyFeedback: true,
        feedback: {
          previewGeneration: "gen-1",
          cursor: 50,
          items: [{
            itemId: "stale-preview", kind: "final_preview", sourceMessageId: "u-1", revision: 0,
            text: "STALE_OLD_PREVIEW", status: "streaming", seq: 50, createdAt: "2026-11-27T10:00:00Z", updatedAt: "2026-11-27T10:00:00Z",
          }],
          processes: [],
        },
        tickets: [{ id: "t-1", title: "Job", scope: "Job", summary: "", status: "working", provider: "codex", sessionId: "s-1", updatedAt: "now" }],
        messages: [
          superMessage("u-1", { role: "user", text: "Run job", state: "assigned", ticketId: "t-1", revision: 0 }),
          superMessage("d-1", { role: "assistant", kind: "dispatch", ticketId: "t-1", sourceMessageId: "u-1", text: "Job", reason: "go", canStop: true }),
        ],
      }
    }
    if (phase === "resync") {
      return {
        workspaceId: "ws-1",
        provider: "codex",
        supportsStop: true,
        supportsReplyFeedback: true,
        feedback: {
          previewGeneration: "gen-2",
          cursor: 2, // SMALLER cursor than 50!
          items: [{
            itemId: "fresh-preview", kind: "final_preview", sourceMessageId: "u-1", revision: 0,
            text: "FRESH_BASE", status: "streaming", seq: 2, createdAt: "2026-11-27T10:01:00Z", updatedAt: "2026-11-27T10:01:00Z",
          }],
          processes: [],
        },
        tickets: [{ id: "t-1", title: "Job", scope: "Job", summary: "", status: "working", provider: "codex", sessionId: "s-1", updatedAt: "now" }],
        messages: [
          superMessage("u-1", { role: "user", text: "Run job", state: "assigned", ticketId: "t-1", revision: 0 }),
          superMessage("d-1", { role: "assistant", kind: "dispatch", ticketId: "t-1", sourceMessageId: "u-1", text: "Job", reason: "go", canStop: true }),
        ],
      }
    }
    return {
      workspaceId: "ws-1",
      provider: "codex",
      supportsStop: true,
      supportsReplyFeedback: true,
      feedback: { previewGeneration: "gen-2", cursor: 5, items: [], processes: [] },
      tickets: [{ id: "t-1", title: "Job", scope: "Job", summary: "Stopped cleanly", status: "stopped", provider: "codex", sessionId: "s-1", updatedAt: "now" }],
      messages: [
        superMessage("u-1", { role: "user", text: "Run job", state: "assigned", ticketId: "t-1", revision: 0 }),
        superMessage("d-1", { role: "assistant", kind: "dispatch", ticketId: "t-1", sourceMessageId: "u-1", text: "Job", reason: "go", stopState: "stopped" }),
        superMessage("worker:t-1:9", { role: "worker", workerEvent: "result", ticketId: "t-1", sessionId: "s-1", sourceMessageId: "u-1", text: "STOP_CONFIRMED_RESULT", stopState: "stopped" }),
      ],
    }
  }

  let resolveResyncSnapshot: ((snap: SuperSnapshot) => void) | undefined
  let resolveStop: ((snap: SuperSnapshot) => void) | undefined
  const snapshotSpy = vi.fn(async () => {
    if (snapshotPhase === "resync" && !resolveResyncSnapshot) {
      return new Promise<SuperSnapshot>(resolve => { resolveResyncSnapshot = resolve })
    }
    return makeSnap(snapshotPhase)
  })
  const saApi: SuperAgentApi = {
    snapshot: snapshotSpy,
    subscribeFeedback: vi.fn(async (_params, onPush, onClose) => {
      subCall++
      pushCb = onPush
      closeCb = onClose
      if (subCall === 1) {
        return { initial: { subscriptionId: "sub-1", workspaceId: "ws-1", previewGeneration: "gen-1", cursor: 50, resyncRequired: false, events: [] }, unsubscribe: vi.fn(async () => {}) }
      }
      return { initial: { subscriptionId: "sub-2", workspaceId: "ws-1", previewGeneration: "gen-2", cursor: 2, resyncRequired: true, events: [] }, unsubscribe: vi.fn(async () => {}) }
    }),
    stop: vi.fn(() => new Promise<SuperSnapshot>(resolve => { resolveStop = resolve })),
    send: vi.fn(),
    correct: vi.fn(),
    settings: vi.fn(),
  }

  const client: DeskfleetDesktopApi = { ...originalClient, platform: "darwin", superAgent: saApi }
  configureClient(client)
  const router = createTestRouter()
  await router.push({ name: "workspace-agent", params: { workspaceId: "ws-1" } })

  const view = mount(WorkspaceAgentView, {
    props: { api: saApi, workspaceId: "ws-1" },
    attachTo: document.body,
    global: {
      plugins: [activePinia, router, i18n],
      provide: { [platformClientKey as symbol]: client },
      stubs: { PaneHeader: { template: "<header><slot /></header>" }, AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" } },
    },
  })
  wrappers.push(view)
  await flushPromises()
  expect(view.text()).toContain("STALE_OLD_PREVIEW")

  // Simulate daemon reconnect with resyncRequired=true and smaller cursor (2 < 50)
  closeCb?.()
  snapshotPhase = "resync"
  // Re-trigger refresh to resubscribe (simulating reconnect)
  const triggerReconnectSnap = makeSnap("initial")
  snapshotSpy.mockResolvedValueOnce(triggerReconnectSnap)
  // Emit online event to trigger useConnectionResume -> refresh -> subscribeFeedback #2 (resyncRequired: true)
  window.dispatchEvent(new Event("online"))
  await flushPromises()

  // While resync snapshot is still in flight, a gen-2 cursor=3 push arrives!
  pushCb?.({
    subscriptionId: "sub-2",
    workspaceId: "ws-1",
    previewGeneration: "gen-2",
    cursor: 3,
    event: {
      type: "item_delta",
      itemId: "fresh-preview",
      kind: "final_preview",
      sourceMessageId: "u-1",
      revision: 0,
      offset: "FRESH_BASE".length,
      delta: "+PUSH3",
      status: "streaming",
      updatedAt: "2026-11-27T10:01:01Z",
    },
  })

  // Now resync snapshot (gen-2, cursor=2) arrives -> replaces stale preview, drops cursor to 2, replays cursor=3 push!
  resolveResyncSnapshot!(makeSnap("resync"))
  resolveResyncSnapshot = undefined
  await flushPromises()

  expect(view.text()).not.toContain("STALE_OLD_PREVIEW")
  expect(view.text()).toContain("FRESH_BASE+PUSH3")

  // Subsequent gen-2 cursor=4 push continues smoothly!
  pushCb?.({
    subscriptionId: "sub-2",
    workspaceId: "ws-1",
    previewGeneration: "gen-2",
    cursor: 4,
    event: {
      type: "item_delta",
      itemId: "fresh-preview",
      kind: "final_preview",
      sourceMessageId: "u-1",
      revision: 0,
      offset: "FRESH_BASE+PUSH3".length,
      delta: "+PUSH4",
      status: "streaming",
      updatedAt: "2026-11-27T10:01:02Z",
    },
  })
  await flushPromises()
  expect(view.text()).toContain("FRESH_BASE+PUSH3+PUSH4")

  // Now click Stop; while stop() is in flight, multiple snapshot_dirty notifications arrive ->
  // MUST NOT be dropped, and MUST coalesce into ONE follow-up snapshot() call after stop() settles!
  const callsBeforeStop = snapshotSpy.mock.calls.length
  const stopBtn = view.get(`button[aria-label="${i18n.global.t("superAgent.stop.request")}"]`)
  await stopBtn.trigger("click")
  await flushPromises()

  snapshotPhase = "post_stop_dirty"
  pushCb?.({ subscriptionId: "sub-2", workspaceId: "ws-1", previewGeneration: "gen-2", cursor: 5, event: { type: "snapshot_dirty" } })
  pushCb?.({ subscriptionId: "sub-2", workspaceId: "ws-1", previewGeneration: "gen-2", cursor: 6, event: { type: "snapshot_dirty" } })
  await flushPromises()
  // Still in flight -> hasn't fetched yet
  expect(snapshotSpy.mock.calls.length).toBe(callsBeforeStop)

  // Stop resolves with intermediate stopping snapshot -> coalesced follow-up fetch fires ONCE immediately!
  resolveStop!(makeSnap("resync"))
  await flushPromises()

  expect(snapshotSpy.mock.calls.length).toBe(callsBeforeStop + 1)
  expect(view.text()).toContain("STOP_CONFIRMED_RESULT")
})

// 9. Request isolation: loadProcess by (sourceMessageId, revision) & loadFollowUpRuns by (serverUrl, userId, teamId, machineId, workspaceId)
test("request isolation: stale loadProcess and loadFollowUpRuns success, error, and finally never mutate newer revision or scope", async () => {
  activePinia = createPinia()
  setActivePinia(activePinia)
  useWorkspaceAgentMode().value = true

  // Part A: loadProcess isolated by (sourceMessageId, revision)
  let resolveProcRev0!: (value: SuperFeedbackProcessResult) => void
  let rejectProcRev0Err!: (err: Error) => void
  let resolveProcRev1!: (value: SuperFeedbackProcessResult) => void
  let procCall = 0
  let currentRev = 0

  const procSnap = (): SuperSnapshot => ({
    workspaceId: "ws-1",
    provider: "codex",
    supportsReplyFeedback: true,
    feedback: {
      previewGeneration: "gen-1",
      cursor: currentRev + 1,
      items: [],
      processes: [{ sourceMessageId: "u-1", revision: currentRev, branches: [], activityCount: 1 }],
    },
    tickets: [],
    messages: [superMessage("u-1", { role: "user", text: "Check", state: "answered", revision: currentRev })],
  })

  // Part B: loadFollowUpRuns isolated by account/team/machine/workspace scope
  let resolveRunsScopeA!: (value: FollowUpRunsPage) => void
  let rejectRunsScopeA!: (err: Error) => void
  let resolveRunsScopeB!: (value: FollowUpRunsPage) => void
  let runCall = 0

  const account = makeAccount({
    serverUrl: "https://server-a.example",
    userId: "user-a",
    teamId: "team-a",
    machineId: "m-a",
    machines: [
      saMachineFixture("m-a", "team-a", "Machine A", true, true),
      saMachineFixture("m-b", "team-b", "Machine B", true, true),
    ],
  })

  const saApi: SuperAgentApi = {
    snapshot: vi.fn(async () => ({ ...procSnap(), supportsProactiveFollowUp: true })),
    feedbackProcess: vi.fn(() => {
      procCall++
      if (procCall === 1) return new Promise<SuperFeedbackProcessResult>((resolve, reject) => { resolveProcRev0 = resolve; rejectProcRev0Err = reject })
      return new Promise<SuperFeedbackProcessResult>(resolve => { resolveProcRev1 = resolve })
    }),
    followUpRuns: vi.fn(() => {
      runCall++
      if (runCall === 1) return new Promise<FollowUpRunsPage>((resolve, reject) => { resolveRunsScopeA = resolve; rejectRunsScopeA = reject })
      return new Promise<FollowUpRunsPage>(resolve => { resolveRunsScopeB = resolve })
    }),
    send: vi.fn(),
    correct: vi.fn(),
    settings: vi.fn(),
  }

  const client: DeskfleetDesktopApi = { ...originalClient, platform: "darwin", target: { id: "m-a", teamId: "team-a", local: true }, superAgent: saApi }
  configureClient(client)
  const router = createTestRouter()
  await router.push({ name: "workspace-agent", params: { workspaceId: "ws-1" }, query: { machine: "m-a", team: "team-a" } })

  const view = mount(WorkspaceAgentView, {
    props: { api: saApi, workspaceId: "ws-1" },
    attachTo: document.body,
    global: {
      plugins: [activePinia, router, i18n],
      provide: { [platformClientKey as symbol]: client, [accountSessionKey as symbol]: account },
      stubs: { PaneHeader: { template: '<header><slot /><slot name="actions" /></header>' }, AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" } },
    },
  })
  wrappers.push(view)
  await flushPromises()

  // Initial followUpRuns for Scope A is in flight (runCall === 1)
  expect(runCall).toBe(1)

  // Open "View process" for rev-0 (procCall === 1 in flight)
  await view.get("[data-toggle-progress-details]").trigger("click")
  await flushPromises()
  expect(procCall).toBe(1)

  // Advance message to rev-1 via snapshot refresh -> rev-1 process load MUST NOT be blocked by in-flight rev-0!
  currentRev = 1
  window.dispatchEvent(new Event("online"))
  await flushPromises()
  await view.get("[data-toggle-progress-details]").trigger("click")
  await flushPromises()
  if (procCall < 2) {
    await view.get("[data-toggle-progress-details]").trigger("click")
    await flushPromises()
  }
  expect(procCall).toBe(2)

  // Stale rev-0 fails late -> MUST NOT show error or clear loading on rev-1!
  rejectProcRev0Err(new Error("STALE_REV0_ERROR"))
  await flushPromises()
  expect(view.text()).not.toContain("STALE_REV0_ERROR")

  // Rev-1 succeeds -> displays rev-1 process item cleanly!
  resolveProcRev1({
    sourceMessageId: "u-1",
    revision: 1,
    hasMore: false,
    items: [{
      itemId: "act-rev1", kind: "activity", sourceMessageId: "u-1", revision: 1,
      text: "REV1_PROCESS_STEP", status: "completed", seq: 1, createdAt: "2026-11-27T10:02:00Z", updatedAt: "2026-11-27T10:02:00Z",
    }],
  })
  await flushPromises()
  expect(view.text()).toContain("REV1_PROCESS_STEP")

  // Switch account/serverUrl/team scope while Scope A followUpRuns (#1) is STILL in flight!
  account.account.value = { serverUrl: "https://server-b.example", user: { id: "user-b", name: "Bob", email: "bob@example.test" }, siteAdmin: false }
  account.teamId.value = "team-b"
  await flushPromises()

  // Trigger snapshot refresh in Scope B -> MUST NOT be blocked by Scope A's in-flight request!
  window.dispatchEvent(new Event("online"))
  await flushPromises()
  expect(runCall).toBe(2)

  // Scope A stale request fails late -> MUST NOT leak Scope A run or error into Scope B!
  rejectRunsScopeA(new Error("STALE_SCOPE_A_ERROR"))
  await flushPromises()
  expect(view.text()).not.toContain("STALE_SCOPE_A_ERROR")

  // Scope B resolves cleanly!
  resolveRunsScopeB({
    runs: [{
      id: "run-b", userId: "user-b", workspaceId: "ws-1", sourceKind: "schedule", sourceId: "sched-b",
      runKey: "r-b", scheduleTitle: "Scope B Run", status: "completed", deliveryPolicy: "every_run", delivered: true,
      summary: "SCOPE_B_SUMMARY", evidenceAvailability: "available", startedAt: "2026-11-27T10:03:00Z", createdAt: "2026-11-27T10:03:00Z", updatedAt: "2026-11-27T10:03:00Z",
    }],
  })
  await flushPromises()
  await view.get("[data-tickets-menu]").trigger("click")
  await flushPromises()
  expect(document.body.textContent).toContain("SCOPE_B_SUMMARY")
  expect(document.body.textContent).not.toContain("STALE_SCOPE_A_ERROR")

  // Suppress unused variable warning
  void resolveProcRev0
  void resolveRunsScopeA
})
