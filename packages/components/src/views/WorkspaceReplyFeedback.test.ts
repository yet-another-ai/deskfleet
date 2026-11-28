import type { SuperAgentApi, SuperFeedbackHandle } from "@deskfleet/client/desktop-api"
import { dispatchAppForeground } from "@deskfleet/client/app-foreground"
import { getClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { ref } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import type {
  SuperFeedbackItem,
  SuperFeedbackProcessResult,
  SuperFeedbackPush,
  SuperFeedbackSubscribeParams,
  SuperMessage,
  SuperSnapshot,
  SuperTicket,
} from "@deskfleet/protocol/super-agent"
import { accountSessionKey } from "../composables/useAccountSession.ts"
import { platformClientKey } from "../composables/usePlatformClient.ts"
import { i18n } from "../i18n/index.ts"
import { useWorkspaceAgentMode } from "../services/workspace-agent-navigation.ts"
import {
  applyFeedbackPush,
  applySnapshotFeedback,
  buildRequestFeedbackMap,
  applyFeedbackEvent,
  createFeedbackState,
  mergeLoadedProcess,
} from "../services/workspace-feedback.ts"
import WorkspaceAgentView from "./WorkspaceAgentView.vue"
import WorkspaceEntryView from "./WorkspaceEntryView.vue"

const ticket = (id: string, extra: Partial<SuperTicket> = {}): SuperTicket => ({
  id, title: id, scope: id, summary: "", provider: "codex", status: "working", updatedAt: "now", ...extra,
})
const message = (id: string, extra: Partial<SuperMessage> = {}): SuperMessage => ({
  id, role: "user", text: id, createdAt: "now", ...extra,
})
const room = (extra: Partial<SuperSnapshot> = {}): SuperSnapshot => ({
  workspaceId: "A", provider: "codex", tickets: [], messages: [], ...extra,
})

let wrappers: VueWrapper[] = []
let pinia: ReturnType<typeof createPinia> | undefined

function createRouterFixture() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: {} },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/settings/agents", name: "settings-agents", component: {} },
    ],
  })
}

async function mountWorkspace(options: {
  initial: SuperSnapshot
  ios?: boolean
  withFeedbackChannel?: boolean
  processResult?: SuperFeedbackProcessResult
  processHandler?: NonNullable<SuperAgentApi["feedbackProcess"]>
}) {
  let state = options.initial
  let activePush: ((push: SuperFeedbackPush) => void) | undefined
  let activeDisconnect: (() => void) | undefined
  let activeSubId = ""
  const unsubscribe = vi.fn(async () => {
    activePush = undefined
    activeDisconnect = undefined
  })
  const subscribeFeedback = vi.fn<NonNullable<SuperAgentApi["subscribeFeedback"]>>(
    async (params: SuperFeedbackSubscribeParams, onEvent, onDisconnect): Promise<SuperFeedbackHandle> => {
      activeSubId = `sub-${subscribeFeedback.mock.calls.length}`
      activePush = onEvent
      activeDisconnect = onDisconnect
      return {
        initial: {
          subscriptionId: activeSubId,
          workspaceId: params.workspaceId,
          cursor: state.feedback?.cursor ?? 0,
          previewGeneration: state.feedback?.previewGeneration ?? "gen-1",
          resyncRequired: false,
          events: [],
        },
        unsubscribe,
      }
    },
  )
  const feedbackProcess = vi.fn<NonNullable<SuperAgentApi["feedbackProcess"]>>(async params => (
    options.processHandler
      ? options.processHandler(params)
      : options.processResult ?? {
        sourceMessageId: params.sourceMessageId,
        revision: 0,
        items: [
          {
            itemId: "tool-1",
            kind: "activity",
            sourceMessageId: params.sourceMessageId,
            revision: 0,
            ticketId: "task-a",
            text: "Inspect message pipeline",
            activityKind: "tool",
            activityStatus: "completed",
            status: "completed",
            seq: 1,
            createdAt: "now",
            updatedAt: "now",
          },
        ],
        hasMore: false,
      }
  ))
  const api: SuperAgentApi = {
    snapshot: vi.fn<SuperAgentApi["snapshot"]>(async () => state),
    stop: vi.fn<NonNullable<SuperAgentApi["stop"]>>(async () => state),
    send: vi.fn<SuperAgentApi["send"]>(async request => {
      state = { ...state, messages: [...state.messages, message(request.messageId, { text: request.text, replyTo: request.replyTo, state: "routing" })] }
      return state
    }),
    correct: vi.fn<SuperAgentApi["correct"]>(async () => state),
    settings: vi.fn<SuperAgentApi["settings"]>(async () => state),
    ...(options.withFeedbackChannel !== false ? { subscribeFeedback, feedbackProcess } : {}),
  }
  const router = createRouterFixture()
  await router.push(options.initial.workspaceId ? { name: "workspace-agent", params: { workspaceId: options.initial.workspaceId } } : "/")
  const localPinia = createPinia()
  pinia = localPinia
  const machines = ref([{ id: "local-daemon", teamId: "team-1", name: "Studio Mac", online: true }])
  const wrapper = mount(WorkspaceAgentView, {
    props: { api, workspaceId: options.initial.workspaceId },
    attachTo: document.body,
    global: {
      plugins: [localPinia, i18n, router],
      provide: {
        ...(options.ios && { [platformClientKey as symbol]: { ...getClient(), platform: "web", mobile: true, remoteWorkspaceAgent: true } }),
        [accountSessionKey as symbol]: {
          account: ref({ user: { id: "alice", name: "Alice", email: "alice@example.test" } }),
          members: ref([]),
          teamId: ref("team-1"),
          localMachineId: ref("local-daemon"),
          machineId: ref("local-daemon"),
          machines,
        },
      },
      stubs: {
        PaneHeader: { template: '<header><slot/><slot name="actions"/></header>' },
        AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" },
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return {
    wrapper,
    api,
    subscribeFeedback,
    feedbackProcess,
    unsubscribe,
    update: (next: SuperSnapshot) => { state = next },
    push: (cursor: number, event: SuperFeedbackPush["event"], overrides: Partial<SuperFeedbackPush> = {}) => {
      activePush?.({
        subscriptionId: activeSubId,
        workspaceId: options.initial.workspaceId,
        cursor,
        previewGeneration: state.feedback?.previewGeneration ?? "gen-1",
        event,
        ...overrides,
      })
    },
    disconnect: () => activeDisconnect?.(),
  }
}

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
  if (pinia) disposePinia(pinia)
  pinia = undefined
  useWorkspaceAgentMode().value = false
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test.each([false, true])("renders opening ack, live milestone B while running, independent progress drawer (never triggers stop), and merges final C once (mobile=%s)", async ios => {
  const job = ticket("task-a", { title: "Pipeline Audit", sessionId: "sess-1" })
  const initial = room({
    supportsStop: true,
    supportsReplyFeedback: true,
    tickets: [job],
    messages: [
      message("req-1", { state: "assigned", ticketId: job.id, text: "Audit the message pipeline" }),
      message("disp-1", { role: "assistant", kind: "dispatch", sourceMessageId: "req-1", ticketId: job.id, canStop: true }),
    ],
    feedback: {
      cursor: 1,
      previewGeneration: "gen-1",
      items: [
        {
          itemId: "ack:req-1:0",
          kind: "ack",
          sourceMessageId: "req-1",
          revision: 0,
          ticketId: job.id,
          text: "I will audit the message pipeline and deliver a concrete fix plan.",
          status: "completed",
          seq: 1,
          createdAt: "now",
          updatedAt: "now",
        },
      ],
      processes: [{ sourceMessageId: "req-1", revision: 0, activityCount: 1, branches: [{ ticketId: job.id, sessionId: "sess-1", activityCount: 1 }] }],
    },
  })

  const ctx = await mountWorkspace({ initial, ios })
  expect(ctx.subscribeFeedback).toHaveBeenCalledOnce()
  expect(ctx.wrapper.get('[data-feedback-ack="ack:req-1:0"]').text()).toContain("I will audit the message pipeline")
  expect(ctx.wrapper.find('[data-agent-progress-for="req-1"]').exists()).toBe(true)

  // Click "View progress" -> expands process details on demand WITHOUT calling api.stop!
  await ctx.wrapper.get('[data-toggle-progress-details]').trigger("click")
  await flushPromises()
  expect(ctx.api.stop).not.toHaveBeenCalled()
  expect(ctx.feedbackProcess).toHaveBeenCalledWith({ workspaceId: "A", sourceMessageId: "req-1" })
  expect(ctx.wrapper.get('[data-progress-details-panel]').text()).toContain("Inspect message pipeline")

  // Push live milestone B while task is STILL running!
  const milestoneB: SuperFeedbackItem = {
    itemId: "milestone:req-1:finding-b",
    kind: "milestone",
    sourceMessageId: "req-1",
    revision: 0,
    ticketId: job.id,
    sessionId: "sess-1",
    text: "Finding B: root cause confirmed.",
    status: "completed",
    seq: 2,
    createdAt: "now",
    updatedAt: "now",
  }
  ctx.push(2, { type: "item_upsert", item: milestoneB })
  await flushPromises()
  expect(ctx.wrapper.get('[data-feedback-milestone="milestone:req-1:finding-b"]').text()).toContain("Finding B: root cause confirmed.")
  expect(ctx.wrapper.find('[data-agent-progress-for="req-1"]').exists()).toBe(true)

  // Quote milestone B -> fills composer quote and submits replyTo=milestone.itemId
  await ctx.wrapper.get('[data-feedback-milestone="milestone:req-1:finding-b"] button[aria-label="Quote"]').trigger("click")
  await ctx.wrapper.get("textarea").setValue("Also check iOS reconnect")
  await ctx.wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(ctx.api.send).toHaveBeenCalledWith(expect.objectContaining({ replyTo: "milestone:req-1:finding-b" }))

  // Stream final preview C with logicalId, then deliver formal result C with SAME logicalId -> C appears ONLY ONCE!
  ctx.push(3, {
    type: "item_delta",
    itemId: "worker-final:sess-1:turn-1",
    sourceMessageId: "req-1",
    revision: 0,
    kind: "final_preview",
    offset: 0,
    delta: "Final C: ",
    logicalId: "worker-final:sess-1:turn-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    status: "streaming",
    updatedAt: "now",
  })
  // Duplicate delta at offset 0 must NEVER duplicate text!
  ctx.push(4, {
    type: "item_delta",
    itemId: "worker-final:sess-1:turn-1",
    sourceMessageId: "req-1",
    revision: 0,
    kind: "final_preview",
    offset: 0,
    delta: "Final C: patch verified.",
    logicalId: "worker-final:sess-1:turn-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    status: "streaming",
    updatedAt: "now",
  })
  await flushPromises()
  expect(ctx.wrapper.get('[data-feedback-final-preview="worker-final:sess-1:turn-1"]').text()).toBe("Final C: patch verified.")

  // Formal result arrives via snapshot_dirty -> preview merges into formal result; progress collapses to lightweight "View process".
  ctx.update(room({
    ...initial,
    tickets: [{ ...job, status: undefined }],
    messages: [
      ...initial.messages,
      message("res-1", {
        role: "worker",
        workerEvent: "result",
        sourceMessageId: "req-1",
        ticketId: job.id,
        sessionId: "sess-1",
        turnId: "turn-1",
        logicalId: "worker-final:sess-1:turn-1",
        text: "Final C: patch verified.",
      }),
    ],
    feedback: { ...initial.feedback!, cursor: 5, items: [initial.feedback!.items[0]!, milestoneB] },
  }))
  ctx.push(5, { type: "snapshot_dirty", sourceMessageId: "req-1" })
  await flushPromises()

  expect(ctx.wrapper.find('[data-feedback-final-preview="worker-final:sess-1:turn-1"]').exists()).toBe(false)
  expect(ctx.wrapper.findAll('[data-super-message="res-1"]')).toHaveLength(1)
  expect(ctx.wrapper.get('[data-super-message="res-1"]').text()).toContain("Final C: patch verified.")
  expect(ctx.wrapper.find('[data-agent-progress-for="req-1"]').exists()).toBe(false)
  // Collapsed lightweight "View process" remains available after completion!
  expect(ctx.wrapper.get('[data-progress-details-for="req-1"] [data-toggle-progress-details]').text()).toBe(i18n.global.t("superAgent.feedback.viewProcess"))
})

test("simple Q&A and new-client-vs-old-daemon show no empty foldout and never call new feedback RPCs", async () => {
  // 1. Old daemon without supportsReplyFeedback: must NEVER call subscribeFeedback or feedbackProcess, must NOT show empty foldout!
  const oldDaemon = await mountWorkspace({
    initial: room({
      supportsStop: true,
      tickets: [ticket("legacy-task")],
      messages: [
        message("legacy-req", { state: "assigned", ticketId: "legacy-task" }),
        message("legacy-disp", { role: "assistant", kind: "dispatch", sourceMessageId: "legacy-req", ticketId: "legacy-task", canStop: true }),
      ],
    }),
  })
  expect(oldDaemon.subscribeFeedback).not.toHaveBeenCalled()
  expect(oldDaemon.feedbackProcess).not.toHaveBeenCalled()
  expect(oldDaemon.wrapper.find('[data-progress-details-for]').exists()).toBe(false)
  expect(oldDaemon.wrapper.find('[data-agent-progress-for="legacy-req"]').exists()).toBe(true)

  // 2. Simple Q&A on new daemon: direct answer only, no ack, no empty progress disclosure!
  const simple = await mountWorkspace({
    initial: room({
      supportsReplyFeedback: true,
      messages: [
        message("q1", { state: "answered", text: "What does ■ mean?" }),
        message("a1", { role: "assistant", sourceMessageId: "q1", text: "It stops the task." }),
      ],
      feedback: { cursor: 1, previewGeneration: "gen-simple", items: [], processes: [] },
    }),
  })
  expect(simple.wrapper.find('[data-feedback-ack]').exists()).toBe(false)
  expect(simple.wrapper.find('[data-progress-details-for]').exists()).toBe(false)
  expect(simple.wrapper.get('[data-super-message="a1"]').text()).toContain("It stops the task.")
})

test("aborted draft, long excerpt notice, and unbounded turn outcome render explicit guidance and Worker links", async () => {
  const ctx = await mountWorkspace({
    initial: room({
      supportsReplyFeedback: true,
      tickets: [ticket("t1", { status: undefined, sessionId: "s1" })],
      messages: [
        message("u1", { state: "assigned", ticketId: "t1" }),
        message("r1", { role: "worker", workerEvent: "result", sourceMessageId: "u1", ticketId: "t1", sessionId: "s1", turnId: "turn1", text: "Beginning excerpt…", truncated: true, unboundedOutcome: true }),
        message("u2", { state: "stopped" }),
      ],
      feedback: {
        cursor: 2,
        previewGeneration: "gen-edge",
        items: [
          {
            itemId: "worker-final:s2:turn2",
            kind: "final_preview",
            sourceMessageId: "u2",
            revision: 0,
            sessionId: "s2",
            turnId: "turn2",
            logicalId: "worker-final:s2:turn2",
            text: "Half-written draft",
            status: "aborted",
            seq: 2,
            createdAt: "now",
            updatedAt: "now",
          },
        ],
        processes: [],
      },
    }),
  })
  expect(ctx.wrapper.get('[data-super-message="r1"] [data-excerpt-notice]').text()).toContain(i18n.global.t("superAgent.feedback.excerptNotice"))
  expect(ctx.wrapper.get('[data-super-message="r1"] [data-unbounded-outcome]').text()).toContain(i18n.global.t("superAgent.feedback.unboundedOutcome"))
  expect(ctx.wrapper.find('[data-super-message="r1"] [data-open-full-worker]').exists()).toBe(true)
  expect(ctx.wrapper.get('[data-feedback-final-preview="worker-final:s2:turn2"] [data-draft-aborted]').text()).toContain(i18n.global.t("superAgent.feedback.draftAborted"))
})

test("disconnect, iOS foreground resume, unmount unsubscribe, and stale-room/revision filtering", async () => {
  const initial = room({
    workspaceId: "A",
    supportsReplyFeedback: true,
    messages: [message("u1", { state: "routing", revision: 1 })],
    feedback: { cursor: 1, previewGeneration: "gen-1", items: [], processes: [] },
  })
  const ctx = await mountWorkspace({ initial, ios: true })
  expect(ctx.subscribeFeedback).toHaveBeenCalledTimes(1)

  // Foreign workspace push & stale revision push are ignored cleanly.
  ctx.push(2, {
    type: "item_upsert",
    item: { itemId: "ack:u1:1", kind: "ack", sourceMessageId: "u1", revision: 1, text: "Wrong room!", status: "completed", seq: 2, createdAt: "now", updatedAt: "now" },
  }, { workspaceId: "B" })
  ctx.push(2, {
    type: "item_upsert",
    item: { itemId: "ack:u1:0", kind: "ack", sourceMessageId: "u1", revision: 0, text: "Stale revision!", status: "completed", seq: 2, createdAt: "now", updatedAt: "now" },
  })
  await flushPromises()
  expect(ctx.wrapper.find('[data-feedback-ack]').exists()).toBe(false)

  // Disconnect & iOS foreground return reconciles snapshot and re-subscribes cleanly.
  ctx.disconnect()
  ctx.update({
    ...initial,
    feedback: {
      cursor: 3,
      previewGeneration: "gen-2",
      items: [{ itemId: "ack:u1:1", kind: "ack", sourceMessageId: "u1", revision: 1, text: "Recovered after resume", status: "completed", seq: 3, createdAt: "now", updatedAt: "now" }],
      processes: [],
    },
  })
  dispatchAppForeground()
  await flushPromises()
  expect(ctx.wrapper.get('[data-feedback-ack="ack:u1:1"]').text()).toContain("Recovered after resume")
  expect(ctx.subscribeFeedback).toHaveBeenCalledTimes(2)

  // Unmounting (e.g. switching workspace or disabling SA) unsubscribes immediately!
  ctx.wrapper.unmount()
  expect(ctx.unsubscribe).toHaveBeenCalled()
})

test("device with SA disabled stays in classic UI and never calls SA snapshot or feedback subscribe", async () => {
  useWorkspaceAgentMode().value = false
  const subscribeFeedback = vi.fn()
  const snapshot = vi.fn()
  const router = createRouterFixture()
  await router.push("/")
  const localPinia = createPinia()
  pinia = localPinia
  const wrapper = mount(WorkspaceEntryView, {
    global: {
      plugins: [localPinia, i18n, router],
      provide: {
        [platformClientKey as symbol]: {
          ...getClient(),
          superAgent: { snapshot, subscribeFeedback, send: vi.fn(), correct: vi.fn(), settings: vi.fn() },
        },
      },
      stubs: {
        NewSessionView: { template: '<div data-classic-view="true">Classic Session UI</div>' },
        PaneHeader: { template: "<header/>" },
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.find('[data-classic-view="true"]').exists()).toBe(true)
  expect(snapshot).not.toHaveBeenCalled()
  expect(subscribeFeedback).not.toHaveBeenCalled()
})

test("workspace-feedback merge engine handles cursor gaps, previewGeneration mismatch, and aborted-vs-streaming race", () => {
  const state = createFeedbackState("A")
  applySnapshotFeedback(state, room({
    supportsReplyFeedback: true,
    messages: [message("u1", { revision: 0 })],
    feedback: { cursor: 5, previewGeneration: "g1", items: [], processes: [] },
  }))
  const revs = new Map([["u1", 0]])
  // Cursor gap (5 -> 8) demands resync!
  const gap = applyFeedbackPush(state, {
    subscriptionId: "sub1", workspaceId: "A", cursor: 8, previewGeneration: "g1",
    event: { type: "snapshot_dirty" },
  }, "A", "sub1", revs)
  expect(gap.resyncRequired).toBe(true)

  // Generation mismatch demands resync!
  const genMismatch = applyFeedbackPush(state, {
    subscriptionId: "sub1", workspaceId: "A", cursor: 6, previewGeneration: "g2",
    event: { type: "snapshot_dirty" },
  }, "A", "sub1", revs)
  expect(genMismatch.resyncRequired).toBe(true)

  // Aborted item cannot be overwritten back to streaming by a late event!
  applyFeedbackPush(state, {
    subscriptionId: "sub1", workspaceId: "A", cursor: 6, previewGeneration: "g1",
    event: {
      type: "item_upsert",
      item: { itemId: "p1", kind: "final_preview", sourceMessageId: "u1", revision: 0, text: "Partial", status: "aborted", seq: 6, createdAt: "now", updatedAt: "now" },
    },
  }, "A", "sub1", revs)
  applyFeedbackPush(state, {
    subscriptionId: "sub1", workspaceId: "A", cursor: 7, previewGeneration: "g1",
    event: {
      type: "item_delta", itemId: "p1", kind: "final_preview", sourceMessageId: "u1", revision: 0,
      offset: 7, delta: " late chunk", status: "streaming", updatedAt: "now",
    },
  }, "A", "sub1", revs)
  const grouped = buildRequestFeedbackMap([message("u1", { revision: 0 })], state)
  expect(grouped.get("u1")!.finalPreviews[0]!.status).toBe("aborted")
  expect(grouped.get("u1")!.finalPreviews[0]!.text).toBe("Partial")
})

test("Mac SA ON and iPhone SA OFF follow independent device choices; toggling off unsubscribes and re-enabling restores persisted feedback", async () => {
  const job = ticket("sync-task", { title: "Cross-device task", sessionId: "s-sync" })
  const sharedSnapshot = room({
    supportsStop: true,
    supportsReplyFeedback: true,
    tickets: [job],
    messages: [
      message("req-sync", { state: "assigned", ticketId: job.id, text: "Check cross-device sync" }),
      message("disp-sync", { role: "assistant", kind: "dispatch", sourceMessageId: "req-sync", ticketId: job.id, canStop: true }),
    ],
    feedback: {
      cursor: 2,
      previewGeneration: "gen-sync",
      items: [
        { itemId: "ack:req-sync:0", kind: "ack", sourceMessageId: "req-sync", revision: 0, ticketId: job.id, text: "I will check cross-device sync and return the result.", status: "completed", seq: 1, createdAt: "now", updatedAt: "now" },
        { itemId: "milestone:req-sync:m1", kind: "milestone", sourceMessageId: "req-sync", revision: 0, ticketId: job.id, text: "Verified Mac and iPhone independent toggle.", status: "completed", seq: 2, createdAt: "now", updatedAt: "now" },
      ],
      processes: [],
    },
  })

  // Device 1 (Mac) with SA enabled subscribes and sees ack + milestone + running progress.
  const mac = await mountWorkspace({ initial: sharedSnapshot, ios: false })
  expect(mac.subscribeFeedback).toHaveBeenCalledOnce()
  expect(mac.wrapper.get('[data-feedback-ack="ack:req-sync:0"]').text()).toContain("I will check cross-device sync")
  expect(mac.wrapper.get('[data-feedback-milestone="milestone:req-sync:m1"]').text()).toContain("Verified Mac and iPhone")

  // Device 2 (iPhone) turns SA OFF -> classic view renders without touching SA snapshot or feedback subscription, while Mac stays active!
  useWorkspaceAgentMode().value = false
  const iosSnapshot = vi.fn()
  const iosSubscribe = vi.fn()
  const router = createRouterFixture()
  await router.push("/")
  const iosPinia = createPinia()
  const iosEntry = mount(WorkspaceEntryView, {
    global: {
      plugins: [iosPinia, i18n, router],
      provide: {
        [platformClientKey as symbol]: {
          ...getClient(),
          platform: "web",
          mobile: true,
          remoteWorkspaceAgent: true,
          superAgent: { snapshot: iosSnapshot, subscribeFeedback: iosSubscribe, send: vi.fn(), correct: vi.fn(), settings: vi.fn() },
        },
      },
      stubs: { NewSessionView: { template: '<div data-ios-classic="true">iOS Classic</div>' }, PaneHeader: { template: "<header/>" } },
    },
  })
  wrappers.push(iosEntry)
  await flushPromises()
  expect(iosEntry.find('[data-ios-classic="true"]').exists()).toBe(true)
  expect(iosSnapshot).not.toHaveBeenCalled()
  expect(iosSubscribe).not.toHaveBeenCalled()
  // Mac remains unaffected and still displays running progress!
  expect(mac.wrapper.find('[data-agent-progress-for="req-sync"]').exists()).toBe(true)

  // Turning off SA on Mac unmounts WorkspaceAgentView -> cleanly unsubscribes; re-opening restores persisted ack + milestone!
  mac.wrapper.unmount()
  expect(mac.unsubscribe).toHaveBeenCalledOnce()
  const macReopened = await mountWorkspace({ initial: sharedSnapshot, ios: false })
  expect(macReopened.wrapper.get('[data-feedback-ack="ack:req-sync:0"]').text()).toContain("I will check cross-device sync")
  expect(macReopened.wrapper.get('[data-feedback-milestone="milestone:req-sync:m1"]').text()).toContain("Verified Mac and iPhone")
  disposePinia(iosPinia)
})

test("streaming feedback deltas never steal reading scroll position while user is scrolled up", async () => {
  const job = ticket("scroll-task", { sessionId: "s-scroll" })
  const ctx = await mountWorkspace({
    initial: room({
      supportsReplyFeedback: true,
      tickets: [job],
      messages: [
        message("old-1", { state: "answered", text: "Earlier discussion" }),
        message("req-scroll", { state: "assigned", ticketId: job.id, text: "Stream long report" }),
        message("disp-scroll", { role: "assistant", kind: "dispatch", sourceMessageId: "req-scroll", ticketId: job.id }),
      ],
      feedback: { cursor: 1, previewGeneration: "gen-scroll", items: [], processes: [] },
    }),
  })
  const viewport = ctx.wrapper.get<HTMLElement>("[data-session-scroll-viewport]")
  Object.defineProperties(viewport.element, { scrollHeight: { configurable: true, value: 2400 }, clientHeight: { configurable: true, value: 400 } })
  viewport.element.scrollTop = 320
  await viewport.trigger("scroll")

  ctx.push(2, {
    type: "item_delta",
    itemId: "worker-final:s-scroll:t1",
    sourceMessageId: "req-scroll",
    revision: 0,
    kind: "final_preview",
    offset: 0,
    delta: "Streaming chunk 1…",
    logicalId: "worker-final:s-scroll:t1",
    sessionId: "s-scroll",
    turnId: "t1",
    status: "streaming",
    updatedAt: "now",
  })
  await flushPromises()
  expect(viewport.element.scrollTop).toBe(320)
  expect(ctx.wrapper.get('[data-feedback-final-preview="worker-final:s-scroll:t1"]').text()).toBe("Streaming chunk 1…")
})

test("P1-5 UI: switching conversations keeps original Worker progress isolated to original conversation", async () => {
  const jobA = ticket("t-a", { title: "Worker A", sessionId: "s-a", status: "working" })
  const jobB = ticket("t-b", { title: "Worker B", sessionId: "s-b" })
  const snapA = room({
    workspaceId: "ws-a",
    supportsReplyFeedback: true,
    tickets: [jobA],
    messages: [
      message("req-a", { state: "assigned", ticketId: jobA.id, text: "Check Project A" }),
      message("disp-a", { role: "assistant", kind: "dispatch", sourceMessageId: "req-a", ticketId: jobA.id }),
    ],
    feedback: { cursor: 1, previewGeneration: "gen-a", items: [], processes: [] },
  })
  const snapB = room({
    workspaceId: "ws-b",
    supportsReplyFeedback: true,
    tickets: [jobB],
    messages: [
      message("req-b", { state: "answered", ticketId: jobB.id, text: "Check Project B" }),
      message("res-b", { role: "worker", workerEvent: "result", sourceMessageId: "req-b", ticketId: jobB.id, text: "Project B done" }),
    ],
    feedback: { cursor: 1, previewGeneration: "gen-b", items: [], processes: [] },
  })

  // Start in Conversation A, then switch to Conversation B (unmounting A, mounting B).
  const convA = await mountWorkspace({ initial: snapA })
  convA.wrapper.unmount()
  expect(convA.unsubscribe).toHaveBeenCalledOnce()

  const convB = await mountWorkspace({ initial: snapB })
  // Late/cross-workspace Worker A progress pushed while viewing Conversation B must be ignored by B.
  convB.push(2, {
    type: "item_upsert",
    item: {
      itemId: "milestone:req-a:ms1",
      kind: "milestone",
      sourceMessageId: "req-a",
      revision: 0,
      ticketId: jobA.id,
      sessionId: "s-a",
      text: "Worker A finding while user is in B",
      status: "completed",
      seq: 2,
      createdAt: "now",
      updatedAt: "now",
    },
  }, { workspaceId: "ws-a" })
  await flushPromises()
  expect(convB.wrapper.text()).not.toContain("Worker A finding while user is in B")
  expect(convB.wrapper.find('[data-feedback-milestone="milestone:req-a:ms1"]').exists()).toBe(false)

  // Switch back to Conversation A -> original Worker A progress still belongs to Conversation A!
  convB.wrapper.unmount()
  const updatedSnapA = room({
    ...snapA,
    feedback: {
      cursor: 2,
      previewGeneration: "gen-a",
      items: [{
        itemId: "milestone:req-a:ms1",
        kind: "milestone",
        sourceMessageId: "req-a",
        revision: 0,
        ticketId: jobA.id,
        sessionId: "s-a",
        text: "Worker A finding while user is in B",
        status: "completed",
        seq: 2,
        createdAt: "now",
        updatedAt: "now",
      }],
      processes: [],
    },
  })
  const convABack = await mountWorkspace({ initial: updatedSnapA })
  expect(convABack.wrapper.get('[data-feedback-milestone="milestone:req-a:ms1"]').text()).toContain("Worker A finding while user is in B")
})

test("P1-6 UI: multi-chunk milestone shows complete text in main conversation before final reply arrives and marks aborted on crash", async () => {
  const job = ticket("t-ms", { title: "Delivery Diag", sessionId: "s-ms", status: "working" })
  const ctx = await mountWorkspace({
    initial: room({
      supportsReplyFeedback: true,
      tickets: [job],
      messages: [
        message("req-ms", { state: "assigned", ticketId: job.id, text: "Locate delivery issue" }),
        message("disp-ms", { role: "assistant", kind: "dispatch", sourceMessageId: "req-ms", ticketId: job.id }),
      ],
      feedback: { cursor: 1, previewGeneration: "gen-ms", items: [], processes: [] },
    }),
  })

  // Chunk 1 arrives (streaming).
  ctx.push(2, {
    type: "item_upsert",
    item: {
      itemId: "milestone:req-ms:m1",
      kind: "milestone",
      sourceMessageId: "req-ms",
      revision: 0,
      ticketId: job.id,
      sessionId: "s-ms",
      messageId: "m1",
      text: "定位到",
      status: "streaming",
      seq: 2,
      createdAt: "t1",
      updatedAt: "t1",
    },
  })
  await flushPromises()
  expect(ctx.wrapper.findAll("[data-feedback-milestone]").length).toBe(1)
  expect(ctx.wrapper.get('[data-feedback-milestone="milestone:req-ms:m1"]').attributes("data-feedback-status")).toBe("streaming")
  expect(ctx.wrapper.get('[data-feedback-milestone="milestone:req-ms:m1"]').text()).toContain("定位到")

  // Chunk 2 arrives -> updates same milestone in place BEFORE final reply!
  ctx.push(3, {
    type: "item_upsert",
    item: {
      itemId: "milestone:req-ms:m1",
      kind: "milestone",
      sourceMessageId: "req-ms",
      revision: 0,
      ticketId: job.id,
      sessionId: "s-ms",
      messageId: "m1",
      text: "定位到问题在投递环节。",
      status: "streaming",
      seq: 2,
      createdAt: "t1",
      updatedAt: "t2",
    },
  })
  await flushPromises()
  expect(ctx.wrapper.findAll("[data-feedback-milestone]").length).toBe(1)
  expect(ctx.wrapper.get('[data-feedback-milestone="milestone:req-ms:m1"]').text()).toContain("定位到问题在投递环节。")

  // Boundary confirms completed while Worker is still running (still no final reply!).
  ctx.push(4, {
    type: "item_upsert",
    item: {
      itemId: "milestone:req-ms:m1",
      kind: "milestone",
      sourceMessageId: "req-ms",
      revision: 0,
      ticketId: job.id,
      sessionId: "s-ms",
      messageId: "m1",
      text: "定位到问题在投递环节。",
      status: "completed",
      seq: 2,
      createdAt: "t1",
      updatedAt: "t3",
    },
  })
  await flushPromises()
  expect(ctx.wrapper.findAll("[data-feedback-milestone]").length).toBe(1)
  expect(ctx.wrapper.get('[data-feedback-milestone="milestone:req-ms:m1"]').attributes("data-feedback-status")).toBe("completed")
  expect(ctx.wrapper.get('[data-feedback-milestone="milestone:req-ms:m1"]').text()).toContain("定位到问题在投递环节。")

  // A second milestone interrupted mid-stream displays full received text with interrupted notice.
  ctx.push(5, {
    type: "item_upsert",
    item: {
      itemId: "milestone:req-ms:m2",
      kind: "milestone",
      sourceMessageId: "req-ms",
      revision: 0,
      ticketId: job.id,
      sessionId: "s-ms",
      messageId: "m2",
      text: "次级节点排查到超时",
      status: "aborted",
      seq: 5,
      createdAt: "t4",
      updatedAt: "t5",
    },
  })
  await flushPromises()
  const abortedNode = ctx.wrapper.get('[data-feedback-milestone="milestone:req-ms:m2"]')
  expect(abortedNode.attributes("data-feedback-status")).toBe("aborted")
  expect(abortedNode.text()).toContain("次级节点排查到超时")
  expect(abortedNode.find("[data-milestone-aborted]").exists()).toBe(true)
})

test("P2-8 UI: unboundedOutcome formal result preserves full conclusion and shows session entry link", async () => {
  const job = ticket("t-unbounded", { title: "Unbounded Check", sessionId: "s-unbounded", status: undefined })
  const ctx = await mountWorkspace({
    initial: room({
      supportsReplyFeedback: true,
      tickets: [job],
      messages: [
        message("req-u8", { state: "assigned", ticketId: job.id, text: "Check conclusion" }),
        message("disp-u8", { role: "assistant", kind: "dispatch", sourceMessageId: "req-u8", ticketId: job.id }),
        message("res-u8", {
          role: "worker",
          workerEvent: "result",
          sourceMessageId: "req-u8",
          ticketId: job.id,
          sessionId: "s-unbounded",
          turnId: "turn-u8",
          text: "已确认的分析主体。\n\n我再检查一下。",
          unboundedOutcome: true,
        }),
      ],
      feedback: { cursor: 2, previewGeneration: "gen-u8", items: [], processes: [] },
    }),
  })
  const resultNode = ctx.wrapper.get('[data-super-message="res-u8"]')
  expect(resultNode.text()).toContain("已确认的分析主体。")
  expect(resultNode.find("[data-unbounded-outcome]").exists()).toBe(true)
  expect(resultNode.find("[data-open-full-worker]").exists()).toBe(true)
})

test("P2-17 UI: reopening a completed 85-tool task loads 80 items first and clicking Load More fetches the remaining 5 without duplicates or omissions", async () => {
  const job = ticket("t-85", { title: "Batch Tool Check", sessionId: "s-85", status: undefined })
  const allItems: SuperFeedbackItem[] = Array.from({ length: 85 }, (_, index) => {
    const num = String(index + 1).padStart(2, "0")
    return {
      itemId: `tool:s-85:turn-85:tc-${num}`,
      kind: "activity",
      sourceMessageId: "req-85",
      revision: 0,
      ticketId: job.id,
      sessionId: "s-85",
      turnId: "turn-85",
      text: `Inspect step ${num}`,
      activityKind: "tool",
      activityStatus: "completed",
      status: "completed",
      seq: index + 1,
      createdAt: "now",
      updatedAt: "now",
    }
  })

  const ctx = await mountWorkspace({
    initial: room({
      supportsReplyFeedback: true,
      tickets: [job],
      messages: [
        message("req-85", { state: "assigned", ticketId: job.id, text: "Run 85 tool checks" }),
        message("disp-85", { role: "assistant", kind: "dispatch", sourceMessageId: "req-85", ticketId: job.id }),
        message("res-85", {
          role: "worker",
          workerEvent: "result",
          sourceMessageId: "req-85",
          ticketId: job.id,
          sessionId: "s-85",
          turnId: "turn-85",
          text: "85 tool checks completed.",
        }),
      ],
      feedback: {
        cursor: 2,
        previewGeneration: "gen-reopened-85",
        items: [],
        processes: [{ sourceMessageId: "req-85", revision: 0, activityCount: 85, branches: [{ ticketId: job.id, sessionId: "s-85", turnId: "turn-85", activityCount: 85 }] }],
      },
    }),
    processHandler: async ({ sourceMessageId, afterSeq, limit = 80 }) => {
      const offset = afterSeq ? Number.parseInt(afterSeq, 10) : 0
      const pageItems = allItems.slice(offset, offset + limit)
      const nextOffset = offset + pageItems.length
      const hasMore = nextOffset < allItems.length
      return {
        sourceMessageId,
        revision: 0,
        items: pageItems,
        hasMore,
        ...(hasMore ? { nextAfterSeq: String(nextOffset) } : {}),
      }
    },
  })

  // 1. Expand "View process" -> first page loads 80 items + displays "Load more".
  await ctx.wrapper.get("[data-toggle-progress-details]").trigger("click")
  await flushPromises()
  expect(ctx.feedbackProcess).toHaveBeenCalledTimes(1)
  expect(ctx.feedbackProcess).toHaveBeenLastCalledWith({ workspaceId: "A", sourceMessageId: "req-85" })
  const firstPageNodes = ctx.wrapper.findAll("[data-activity-item]")
  expect(firstPageNodes.length).toBe(80)
  expect(firstPageNodes[0]!.text()).toContain("Inspect step 01")
  expect(firstPageNodes[79]!.text()).toContain("Inspect step 80")
  expect(ctx.wrapper.find("[data-load-more-process]").exists()).toBe(true)

  // 2. Click "Load more" -> sends afterSeq: "80", loads remaining 5, total 85 unique items in exact order!
  await ctx.wrapper.get("[data-load-more-process]").trigger("click")
  await flushPromises()
  expect(ctx.feedbackProcess).toHaveBeenCalledTimes(2)
  expect(ctx.feedbackProcess).toHaveBeenLastCalledWith({ workspaceId: "A", sourceMessageId: "req-85", afterSeq: "80" })
  const allNodes = ctx.wrapper.findAll("[data-activity-item]")
  expect(allNodes.length).toBe(85)
  const ids = allNodes.map(node => node.attributes("data-activity-item"))
  expect(new Set(ids).size).toBe(85)
  expect(allNodes[0]!.text()).toContain("Inspect step 01")
  expect(allNodes[79]!.text()).toContain("Inspect step 80")
  expect(allNodes[80]!.text()).toContain("Inspect step 81")
  expect(allNodes[84]!.text()).toContain("Inspect step 85")
  expect(ctx.wrapper.find("[data-load-more-process]").exists()).toBe(false)
})

test("P2-23 UI: sparse long-journal pagination keeps Load More visible when page 1 has fewer than 80 items and appends tail tool in order", async () => {
  const job = ticket("t-20k", { title: "Long Log Check", sessionId: "s-20k", status: undefined })
  const resumeCursor = "1000000000000000020004"
  const ctx = await mountWorkspace({
    initial: room({
      supportsReplyFeedback: true,
      tickets: [job],
      messages: [
        message("req-20k", { state: "assigned", ticketId: job.id, text: "Check sparse 20,010-event log" }),
        message("disp-20k", { role: "assistant", kind: "dispatch", sourceMessageId: "req-20k", ticketId: job.id }),
        message("res-20k", {
          role: "worker",
          workerEvent: "result",
          sourceMessageId: "req-20k",
          ticketId: job.id,
          sessionId: "s-20k",
          turnId: "turn-20k",
          text: "超长日志任务已完成。",
        }),
      ],
      feedback: {
        cursor: 2,
        previewGeneration: "gen-20k",
        items: [],
        processes: [{ sourceMessageId: "req-20k", revision: 0, activityCount: 3, branches: [{ ticketId: job.id, sessionId: "s-20k", turnId: "turn-20k", activityCount: 3 }] }],
      },
    }),
    processHandler: async ({ sourceMessageId, afterSeq }) => {
      if (!afterSeq) {
        return {
          sourceMessageId,
          revision: 0,
          items: [
            { itemId: "tool:s-20k:turn-20k:tc-first", kind: "activity", sourceMessageId, revision: 0, ticketId: job.id, sessionId: "s-20k", turnId: "turn-20k", text: "首端工具检查", activityKind: "tool", activityStatus: "completed", status: "completed", seq: 5, createdAt: "now", updatedAt: "now" },
            { itemId: "activity:s-20k:turn-20k:msg:m-long", kind: "activity", sourceMessageId, revision: 0, ticketId: job.id, sessionId: "s-20k", turnId: "turn-20k", text: "正在流式检查...", activityKind: "commentary", status: "completed", seq: 6, createdAt: "now", updatedAt: "now" },
          ],
          hasMore: true,
          nextAfterSeq: resumeCursor,
        }
      }
      return {
        sourceMessageId,
        revision: 0,
        items: [
          { itemId: "tool:s-20k:turn-20k:tc-last", kind: "activity", sourceMessageId, revision: 0, ticketId: job.id, sessionId: "s-20k", turnId: "turn-20k", text: "尾端工具检查", activityKind: "tool", activityStatus: "completed", status: "completed", seq: 20013, createdAt: "now", updatedAt: "now" },
        ],
        hasMore: false,
      }
    },
  })

  await ctx.wrapper.get("[data-toggle-progress-details]").trigger("click")
  await flushPromises()
  const page1Nodes = ctx.wrapper.findAll("[data-activity-item]")
  expect(page1Nodes.map(n => n.text())).toEqual(["Long Log Check ·首端工具检查", "Long Log Check ·正在流式检查..."])
  expect(ctx.wrapper.find("[data-load-more-process]").exists()).toBe(true)

  await ctx.wrapper.get("[data-load-more-process]").trigger("click")
  await flushPromises()
  expect(ctx.feedbackProcess).toHaveBeenLastCalledWith({ workspaceId: "A", sourceMessageId: "req-20k", afterSeq: resumeCursor })
  const allNodes = ctx.wrapper.findAll("[data-activity-item]")
  expect(allNodes.map(n => n.text())).toEqual(["Long Log Check ·首端工具检查", "Long Log Check ·正在流式检查...", "Long Log Check ·尾端工具检查"])
  expect(ctx.wrapper.find("[data-load-more-process]").exists()).toBe(false)
})

test("P2-28 UI: Load More merges a status-only completion into the tool already shown, keeping its name and first position", async () => {
  const job = ticket("t-28", { title: "Pay Check", sessionId: "s-28", status: undefined })
  const resumeCursor = "1000000000000000020004"
  const tool = (itemId: string, text: string, extra: Partial<SuperFeedbackItem> = {}): SuperFeedbackItem => ({
    itemId, kind: "activity", sourceMessageId: "req-28", revision: 0, ticketId: job.id, sessionId: "s-28", turnId: "turn-28",
    text, activityKind: "tool", activityStatus: "completed", status: "completed", seq: 1, createdAt: "now", updatedAt: "now", ...extra,
  })
  const ctx = await mountWorkspace({
    initial: room({
      supportsReplyFeedback: true,
      tickets: [job],
      messages: [
        message("req-28", { state: "assigned", ticketId: job.id, text: "核对支付账单" }),
        message("disp-28", { role: "assistant", kind: "dispatch", sourceMessageId: "req-28", ticketId: job.id }),
        message("res-28", { role: "worker", workerEvent: "result", sourceMessageId: "req-28", ticketId: job.id, sessionId: "s-28", turnId: "turn-28", text: "支付账单核对完成。" }),
      ],
      feedback: {
        cursor: 2,
        previewGeneration: "gen-28",
        items: [],
        processes: [{ sourceMessageId: "req-28", revision: 0, activityCount: 2, branches: [{ ticketId: job.id, sessionId: "s-28", turnId: "turn-28", activityCount: 2 }] }],
      },
    }),
    processHandler: async ({ sourceMessageId, afterSeq }) => afterSeq
      ? {
        sourceMessageId, revision: 0, hasMore: false,
        items: [tool("tool:s-28:turn-28:tc-pay", "", { updateOnly: true, seq: 20011 })],
      }
      : {
        sourceMessageId, revision: 0, hasMore: true, nextAfterSeq: resumeCursor,
        items: [
          tool("tool:s-28:turn-28:tc-pay", "核对支付账单", { activityStatus: "in_progress", status: "streaming", seq: 3 }),
          tool("tool:s-28:turn-28:tc-sample", "记录对照样本", { seq: 4 }),
        ],
      },
  })

  await ctx.wrapper.get("[data-toggle-progress-details]").trigger("click")
  await flushPromises()
  expect(ctx.wrapper.findAll("[data-activity-item]").map(n => n.text())).toEqual(["Pay Check ·核对支付账单", "Pay Check ·记录对照样本"])

  await ctx.wrapper.get("[data-load-more-process]").trigger("click")
  await flushPromises()
  const nodes = ctx.wrapper.findAll("[data-activity-item]")
  expect(nodes.map(n => n.text())).toEqual(["Pay Check ·核对支付账单", "Pay Check ·记录对照样本"])
  expect(nodes.map(n => n.attributes("data-activity-item"))).toEqual(["tool:s-28:turn-28:tc-pay", "tool:s-28:turn-28:tc-sample"])
})

test("P2-28 merge: later-page status updates keep title and first position; only explicit new titles replace the name", () => {
  const tool = (itemId: string, text: string, extra: Partial<SuperFeedbackItem> = {}): SuperFeedbackItem => ({
    itemId, kind: "activity", sourceMessageId: "req", revision: 0, text, activityKind: "tool",
    activityStatus: "completed", status: "completed", seq: 1, createdAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:00.000Z", ...extra,
  })
  const page1 = {
    sourceMessageId: "req", revision: 0, hasMore: true, nextAfterSeq: "1000000000000000020004",
    items: [
      tool("pay", "核对支付账单", { activityStatus: "in_progress", status: "streaming", seq: 3 }),
      tool("sample", "记录对照样本", { seq: 4 }),
    ],
  } satisfies SuperFeedbackProcessResult
  const tools = (state: ReturnType<typeof createFeedbackState>) =>
    buildRequestFeedbackMap([message("req")], state).get("req")!.activities.map(i => [i.text, i.activityStatus])

  // Current host: status-only update without a title.
  const current = createFeedbackState("A")
  mergeLoadedProcess(current, page1)
  mergeLoadedProcess(current, { sourceMessageId: "req", revision: 0, hasMore: false, items: [tool("pay", "", { updateOnly: true, seq: 20011, updatedAt: "2026-11-24T00:01:00.000Z" })] }, true)
  expect(tools(current)).toEqual([["核对支付账单", "completed"], ["记录对照样本", "completed"]])
  expect(current.loadedProcesses.get("req")!.items.map(i => i.itemId)).toEqual(["pay", "sample"])

  // Older host: generic "Running tool" placeholder must not overwrite the known name or order.
  const legacy = createFeedbackState("A")
  mergeLoadedProcess(legacy, page1)
  mergeLoadedProcess(legacy, { sourceMessageId: "req", revision: 0, hasMore: false, items: [tool("pay", "Running tool", { seq: 20011 })] }, true)
  expect(tools(legacy)).toEqual([["核对支付账单", "completed"], ["记录对照样本", "completed"]])

  // An explicitly provided new title is applied, still at the first position.
  const renamed = createFeedbackState("A")
  mergeLoadedProcess(renamed, page1)
  mergeLoadedProcess(renamed, { sourceMessageId: "req", revision: 0, hasMore: false, items: [tool("pay", "核对支付账单（含退款）", { seq: 20011 })] }, true)
  expect(tools(renamed)).toEqual([["核对支付账单（含退款）", "completed"], ["记录对照样本", "completed"]])
})

test("P2-28 live: a title-less tool status update on the live feed keeps the tool's name and position", () => {
  const state = createFeedbackState("A")
  const tool = (text: string, extra: Partial<SuperFeedbackItem> = {}): SuperFeedbackItem => ({
    itemId: "tool:s:t:tc-pay", kind: "activity", sourceMessageId: "req", revision: 0, text, activityKind: "tool",
    activityStatus: "in_progress", status: "streaming", seq: 3, createdAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:00.000Z", ...extra,
  })
  applyFeedbackEvent(state, { type: "item_upsert", item: tool("核对支付账单") }, 1, new Map())
  applyFeedbackEvent(state, { type: "item_upsert", item: tool("", { updateOnly: true, activityStatus: "completed", status: "completed", seq: 20011 }) }, 2, new Map())
  expect(state.items.get("tool:s:t:tc-pay")).toMatchObject({ text: "核对支付账单", activityStatus: "completed", seq: 3 })
  applyFeedbackEvent(state, { type: "item_upsert", item: tool("Running tool", { activityStatus: "completed", status: "completed" }) }, 3, new Map())
  expect(state.items.get("tool:s:t:tc-pay")!.text).toBe("核对支付账单")
})

test("clicking a sent message quote for a feedback ack or milestone locates that exact feedback item by ID even with duplicate text", async () => {
  const jobA = ticket("t-a", { title: "Task A", sessionId: "s-a" })
  const jobB = ticket("t-b", { title: "Task B", sessionId: "s-b" })
  const ctx = await mountWorkspace({
    initial: room({
      supportsReplyFeedback: true,
      tickets: [jobA, jobB],
      messages: [
        message("req-1", { state: "assigned", ticketId: jobA.id, text: "First request" }),
        message("disp-1", { role: "assistant", kind: "dispatch", sourceMessageId: "req-1", ticketId: jobA.id }),
        message("req-2", { state: "assigned", ticketId: jobB.id, text: "Second request" }),
        message("disp-2", { role: "assistant", kind: "dispatch", sourceMessageId: "req-2", ticketId: jobB.id }),
        message("reply-ack-1", { state: "answered", text: "关于第一条受理", replyTo: "ack:req-1:0" }),
        message("reply-ms-1", { state: "answered", text: "关于第一条阶段发现", replyTo: "milestone:req-1:m1" }),
      ],
      feedback: {
        cursor: 4,
        previewGeneration: "gen-quote-locate",
        items: [
          {
            itemId: "ack:req-1:0", kind: "ack", sourceMessageId: "req-1", revision: 0, ticketId: jobA.id,
            text: "已收到，开始排查。", status: "completed", seq: 1, createdAt: "t1", updatedAt: "t1",
          },
          {
            itemId: "milestone:req-1:m1", kind: "milestone", sourceMessageId: "req-1", revision: 0, ticketId: jobA.id, sessionId: "s-a",
            text: "根因已确认。", status: "completed", seq: 2, createdAt: "t2", updatedAt: "t2",
          },
          {
            itemId: "ack:req-2:0", kind: "ack", sourceMessageId: "req-2", revision: 0, ticketId: jobB.id,
            text: "已收到，开始排查。", status: "completed", seq: 3, createdAt: "t3", updatedAt: "t3",
          },
          {
            itemId: "milestone:req-2:m2", kind: "milestone", sourceMessageId: "req-2", revision: 0, ticketId: jobB.id, sessionId: "s-b",
            text: "根因已确认。", status: "completed", seq: 4, createdAt: "t4", updatedAt: "t4",
          },
        ],
        processes: [],
      },
    }),
  })

  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
  const ack1 = ctx.wrapper.get('[data-feedback-ack="ack:req-1:0"]')
  const ack2 = ctx.wrapper.get('[data-feedback-ack="ack:req-2:0"]')
  const ms1 = ctx.wrapper.get('[data-feedback-milestone="milestone:req-1:m1"]')
  const ms2 = ctx.wrapper.get('[data-feedback-milestone="milestone:req-2:m2"]')

  await ctx.wrapper.get('[data-super-message="reply-ack-1"] button[data-reply-quote-target]').trigger("click")
  await flushPromises()
  expect(scroll).toHaveBeenCalledTimes(1)
  expect(scroll.mock.contexts[0]).toBe(ack1.element)
  expect(ack1.attributes("data-conversation-located")).toBe("true")
  expect(ack2.attributes("data-conversation-located")).toBeUndefined()

  await ctx.wrapper.get('[data-super-message="reply-ms-1"] button[data-reply-quote-target]').trigger("click")
  await flushPromises()
  expect(scroll).toHaveBeenCalledTimes(2)
  expect(scroll.mock.contexts[1]).toBe(ms1.element)
  expect(ms1.attributes("data-conversation-located")).toBe("true")
  expect(ms2.attributes("data-conversation-located")).toBeUndefined()
  expect(ack1.attributes("data-conversation-located")).toBeUndefined()
})
