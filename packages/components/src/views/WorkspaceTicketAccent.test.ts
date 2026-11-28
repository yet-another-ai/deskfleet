import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { SuperAgentApi } from "@deskfleet/client/desktop-api"
import { getClient } from "@deskfleet/client/platform"
import {
  isValidAccentSlot,
  SA_ACCENT_DISTANCE_THRESHOLD,
  SA_ACCENT_OKLAB_DISTANCE_TABLE,
  SA_ACCENT_PALETTE,
  SA_ACCENT_SLOT_COUNT,
  wcagContrastRatio,
  type SuperMessage,
  type SuperSnapshot,
  type SuperTicket,
} from "@deskfleet/protocol/super-agent"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import AgentUserMessage from "../components/session/AgentUserMessage.vue"
import WorkspaceMessage from "../components/session/WorkspaceMessage.vue"
import WorkspaceAgentSettings from "../components/settings/WorkspaceAgentSettings.vue"
import { platformClientKey } from "../composables/usePlatformClient.ts"
import { WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY } from "../composables/useWorkspaceAgentDisplayName.ts"
import { i18n } from "../i18n/index.ts"
import { useWorkspaceAgentMode } from "../services/workspace-agent-navigation.ts"
import WorkspaceAgentView from "./WorkspaceAgentView.vue"

const LIGHT_CANVAS = "#fbfbfd"
const LIGHT_SURFACE = "#ffffff"
const DARK_CANVAS = "#17191f"
const DARK_SURFACE = "#1f222a"

const makeTicket = (id: string, title: string, extra: Partial<SuperTicket> = {}): SuperTicket => ({
  id, title, scope: title, summary: "", provider: "codex", status: "working", updatedAt: "now", ...extra,
})
const makeMessage = (id: string, extra: Partial<SuperMessage> = {}): SuperMessage => ({
  id, role: "user", text: id, createdAt: "now", ...extra,
})
const makeRoom = (extra: Partial<SuperSnapshot> = {}): SuperSnapshot => ({
  workspaceId: "A", provider: "codex", tickets: [], messages: [], ...extra,
})

let wrappers: VueWrapper[] = []
let pinia: ReturnType<typeof createPinia> | undefined
const originalLocale = i18n.global.locale.value

async function mountView(initial: SuperSnapshot, locale: "zh-cmn-Hans-CN" | "en-US" = "zh-cmn-Hans-CN") {
  i18n.global.locale.value = locale
  let state = initial
  const feedbackProcess = vi.fn<NonNullable<SuperAgentApi["feedbackProcess"]>>(async params => ({
    sourceMessageId: params.sourceMessageId,
    revision: 0,
    items: [
      {
        itemId: `act-${params.sourceMessageId}`,
        kind: "activity",
        sourceMessageId: params.sourceMessageId,
        revision: 0,
        text: "检查进展明细",
        activityKind: "tool",
        activityStatus: "completed",
        status: "completed",
        seq: 1,
        createdAt: "now",
        updatedAt: "now",
      },
    ],
    hasMore: false,
  }))
  const api: SuperAgentApi = {
    snapshot: vi.fn<SuperAgentApi["snapshot"]>(async () => state),
    stop: vi.fn<NonNullable<SuperAgentApi["stop"]>>(async () => state),
    archiveTicket: vi.fn<NonNullable<SuperAgentApi["archiveTicket"]>>(async ({ ticketId, archived }) => {
      state = {
        ...state,
        tickets: state.tickets.map(item => item.id === ticketId ? { ...item, archiveState: archived ? "archived" : undefined } : item),
      }
      return state
    }),
    send: vi.fn<SuperAgentApi["send"]>(async () => state),
    correct: vi.fn<SuperAgentApi["correct"]>(async () => state),
    settings: vi.fn<SuperAgentApi["settings"]>(async () => state),
    feedbackProcess,
    ...(initial.supportsProactiveFollowUp ? { followUpAuth: vi.fn<NonNullable<SuperAgentApi["followUpAuth"]>>() } : {}),
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: {} },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/schedules/:scheduleId?", name: "schedules", component: {} },
      { path: "/settings/agents", name: "settings-agents", component: {} },
    ],
  })
  await router.push({ name: "workspace-agent", params: { workspaceId: initial.workspaceId ?? "A" } })
  pinia = createPinia()
  const wrapper = mount(WorkspaceAgentView, {
    props: { api, workspaceId: initial.workspaceId },
    attachTo: document.body,
    global: {
      plugins: [pinia, i18n, router],
      stubs: {
        PaneHeader: { template: '<header><slot/><slot name="actions"/></header>' },
        AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" },
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, api, feedbackProcess }
}

afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount()
  if (pinia) { disposePinia(pinia); pinia = undefined }
  useWorkspaceAgentMode().value = false
  localStorage.removeItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)
  i18n.global.locale.value = originalLocale
  delete document.documentElement.dataset.theme
  document.documentElement.classList.remove("dark")
  vi.restoreAllMocks()
})

test("colors the 4 exact SA targets for two distinct tickets: progress bar rail, expandable ticket name, cross-ticket quote rail, and Super Agent role dot (no outer message rails or capsules)", async () => {
  const slotA = 3
  const slotB = 21
  expect(SA_ACCENT_OKLAB_DISTANCE_TABLE[slotA]![slotB]!).toBeGreaterThanOrEqual(SA_ACCENT_DISTANCE_THRESHOLD)
  expect(SA_ACCENT_PALETTE[slotA]!.light.labelText).not.toBe(SA_ACCENT_PALETTE[slotB]!.light.labelText)
  expect(SA_ACCENT_PALETTE[slotA]!.dark.labelText).not.toBe(SA_ACCENT_PALETTE[slotB]!.dark.labelText)
  expect(SA_ACCENT_PALETTE[slotA]!.light.rail).not.toBe(SA_ACCENT_PALETTE[slotB]!.light.rail)
  expect(SA_ACCENT_PALETTE[slotA]!.dark.rail).not.toBe(SA_ACCENT_PALETTE[slotB]!.dark.rail)

  const ticketA = makeTicket("ta", "登录鉴权修复", { accentSlot: slotA, status: "working", scope: "修复刷新丢 token" })
  const ticketB = makeTicket("tb", "支付回调重试", { accentSlot: slotB, status: "working", scope: "支付幂等重试" })

  const { wrapper, api, feedbackProcess } = await mountView(makeRoom({
    supportsStop: true,
    supportsReplyFeedback: true,
    focusTicketId: ticketB.id,
    tickets: [ticketA, ticketB],
    messages: [
      makeMessage("a-prev-user", { role: "user", text: "先查一下历史登录日志", ticketId: ticketA.id, state: "assigned" }),
      makeMessage("a-worker", { role: "worker", text: "登录日志已核对", ticketId: ticketA.id, sourceMessageId: "a-prev-user", workerEvent: "result" }),
      makeMessage("a-user", { role: "user", text: "排查刷新丢 token", ticketId: ticketA.id, state: "assigned" }),
      makeMessage("a-disp", { role: "assistant", kind: "dispatch", text: ticketA.title, ticketId: ticketA.id, sourceMessageId: "a-user", canStop: true }),
      makeMessage("a-sa", { role: "assistant", text: "我先检查登录态中间件。", ticketId: ticketA.id, sourceMessageId: "a-user" }),
      makeMessage("b-user", { role: "user", text: "参考上面登录态，把支付回调重试也加上", replyTo: "a-sa", ticketId: ticketB.id, state: "assigned" }),
      makeMessage("b-disp", { role: "assistant", kind: "dispatch", text: ticketB.title, ticketId: ticketB.id, sourceMessageId: "b-user", canStop: true }),
      makeMessage("b-sa", { role: "assistant", text: "收到，正在处理支付回调重试。", replyTo: "a-sa", ticketId: ticketB.id, sourceMessageId: "b-user" }),
      makeMessage("a-follow", { role: "user", text: "顺便核对这个支付里程碑", replyTo: "ms-b", ticketId: ticketA.id, state: "assigned" }),
    ],
    feedback: {
      cursor: 1,
      previewGeneration: "gen-1",
      processes: [
        { sourceMessageId: "a-user", revision: 0, activityCount: 1, branches: [{ ticketId: ticketA.id, activityCount: 1 }] },
        { sourceMessageId: "b-user", revision: 0, activityCount: 1, branches: [{ ticketId: ticketB.id, activityCount: 1 }] },
      ],
      items: [
        { itemId: "ms-b", kind: "milestone", sourceMessageId: "b-user", revision: 0, ticketId: ticketB.id, text: "支付回调已定位重试入口", status: "completed", seq: 1, createdAt: "now", updatedAt: "now" },
      ],
    },
  }))

  // No standalone capsules and no generic outer message frame rails exist anywhere.
  expect(wrapper.findAll("[data-sa-ticket-badge]")).toHaveLength(0)
  expect(wrapper.findAll(".sa-ticket-badge")).toHaveLength(0)
  expect(wrapper.findAll("[data-sa-accent-rail]")).toHaveLength(0)
  expect(wrapper.findAll(".sa-message-rail-left")).toHaveLength(0)
  expect(wrapper.findAll(".sa-message-rail-right")).toHaveLength(0)

  // Target 1 (图 1): Existing progress vertical rail uses the executing ticket's color, keeping progress toggle & stop intact.
  const progressA = wrapper.get('[data-agent-progress-for="a-user"]')
  expect(progressA.attributes("data-sa-progress-rail")).toBe("true")
  expect(progressA.attributes("data-sa-accent-slot")).toBe(String(slotA))
  expect(progressA.classes()).toContain("sa-ticket-accent")
  expect(progressA.classes()).toContain("sa-ticket-rail")
  expect(progressA.classes()).not.toContain("border-ui-accent")

  const progressB = wrapper.get('[data-agent-progress-for="b-user"]')
  expect(progressB.attributes("data-sa-progress-rail")).toBe("true")
  expect(progressB.attributes("data-sa-accent-slot")).toBe(String(slotB))
  expect(progressB.classes()).toContain("sa-ticket-accent")
  expect(progressB.classes()).toContain("sa-ticket-rail")

  await progressB.get("[data-toggle-progress-details]").trigger("click")
  await flushPromises()
  expect(feedbackProcess).toHaveBeenCalledWith({ workspaceId: "A", sourceMessageId: "b-user" })
  expect(progressB.get("[data-progress-details-panel]").text()).toContain("检查进展明细")
  expect(api.stop).not.toHaveBeenCalled()

  await progressB.get('button[aria-label]').trigger("click")
  await flushPromises()
  expect(api.stop).toHaveBeenCalledTimes(1)

  // Target 2 (图 2): Expandable ticket name beside Super Agent uses each ticket's own color and keeps expand/collapse.
  const saRowA = wrapper.get('[data-super-message="a-sa"]')
  const toggleA = saRowA.get("[data-execution-toggle]")
  expect(toggleA.attributes("data-sa-accent-slot")).toBe(String(slotA))
  expect(toggleA.classes()).toContain("sa-ticket-accent")
  expect(toggleA.classes()).toContain("sa-ticket-label")
  expect(toggleA.text()).toBe(ticketA.title)
  expect(toggleA.text()).not.toContain("事项详情")
  await toggleA.trigger("click")
  expect(saRowA.get("[data-execution-details]").text()).toContain("修复刷新丢 token")
  await toggleA.trigger("click")
  expect(saRowA.find("[data-execution-details]").exists()).toBe(false)

  const saRowB = wrapper.get('[data-super-message="b-sa"]')
  const toggleB = saRowB.get("[data-execution-toggle]")
  expect(toggleB.attributes("data-sa-accent-slot")).toBe(String(slotB))
  expect(toggleB.classes()).toContain("sa-ticket-accent")
  expect(toggleB.classes()).toContain("sa-ticket-label")
  expect(toggleB.text()).toBe(ticketB.title)

  // Target 3: Cross-ticket quote short left rail uses the QUOTED message's ticket slot, NOT the replying or focused ticket!
  // b-user (ticket B, slot 21) and b-sa (ticket B, slot 21) quote a-sa (ticket A, slot 3) while focusTicketId = ticketB.
  const bUserQuote = wrapper.get('[data-super-message="b-user"] [data-reply-quote="a-sa"]')
  expect(bUserQuote.attributes("data-sa-quote-rail")).toBe("true")
  expect(bUserQuote.attributes("data-sa-accent-slot")).toBe(String(slotA))
  expect(bUserQuote.classes()).toContain("sa-ticket-accent")
  expect(bUserQuote.classes()).toContain("sa-ticket-rail")
  expect(bUserQuote.classes()).not.toContain("border-ui-accent")

  const bSaQuote = wrapper.get('[data-super-message="b-sa"] [data-reply-quote="a-sa"]')
  expect(bSaQuote.attributes("data-sa-quote-rail")).toBe("true")
  expect(bSaQuote.attributes("data-sa-accent-slot")).toBe(String(slotA))

  // Cross-ticket quote of a milestone from ticket B inside ticket A's message uses ticket B's slot (21), NOT A's slot (3)!
  const aMilestoneQuote = wrapper.get('[data-super-message="a-follow"] [data-reply-quote="ms-b"]')
  expect(aMilestoneQuote.attributes("data-sa-quote-rail")).toBe("true")
  expect(aMilestoneQuote.attributes("data-sa-accent-slot")).toBe(String(slotB))

  // Quoting a-sa into the composer while focusTicketId = ticketB colors the composer quote bar with ticket A's slot (3).
  await saRowA.get('button[aria-label="引用"]').trigger("click")
  await flushPromises()
  const composerQuote = wrapper.get("[data-composer-quote]")
  expect(composerQuote.attributes("data-sa-quote-rail")).toBe("true")
  expect(composerQuote.attributes("data-sa-accent-slot")).toBe(String(slotA))
  expect(composerQuote.classes()).toContain("sa-ticket-accent")
  expect(composerQuote.classes()).toContain("sa-ticket-rail")

  // Target 4: SA reply uniquely attributed to a colored ticket shows a slightly larger colored "·" dot to the LEFT of "Super Agent"; name itself stays default; user bubble stays uncolored; worker gets no dot.
  const roleNameA = saRowA.get("[data-sa-role-name]")
  expect(roleNameA.text()).toBe("Super Agent")
  expect(roleNameA.classes()).not.toContain("sa-ticket-accent")
  expect(roleNameA.classes()).not.toContain("sa-ticket-label")
  const dotA = saRowA.get("[data-sa-role-dot]")
  expect(dotA.text()).toBe("·")
  expect(dotA.attributes("data-sa-accent-slot")).toBe(String(slotA))
  expect(dotA.classes()).toContain("sa-ticket-accent")
  expect(dotA.classes()).toContain("sa-ticket-dot")
  expect(dotA.element.nextElementSibling).toBe(roleNameA.element)

  const dotB = saRowB.get("[data-sa-role-dot]")
  expect(dotB.text()).toBe("·")
  expect(dotB.attributes("data-sa-accent-slot")).toBe(String(slotB))
  expect(dotB.element.nextElementSibling).toBe(saRowB.get("[data-sa-role-name]").element)

  const feedbackGroupB = wrapper.get('[data-feedback-group-for="b-user"]')
  const feedbackHeaderDotB = feedbackGroupB.get("[data-sa-role-dot]")
  const feedbackHeaderNameB = feedbackGroupB.get("[data-sa-role-name]")
  expect(feedbackHeaderDotB.text()).toBe("·")
  expect(feedbackHeaderDotB.attributes("data-sa-accent-slot")).toBe(String(slotB))
  expect(feedbackHeaderNameB.text()).toBe("Super Agent")
  expect(feedbackHeaderNameB.classes()).not.toContain("sa-ticket-accent")
  expect(feedbackHeaderDotB.element.nextElementSibling).toBe(feedbackHeaderNameB.element)

  const workerRowA = wrapper.get('[data-super-message="a-worker"]')
  expect(workerRowA.find("[data-sa-role-dot]").exists()).toBe(false)
  expect(workerRowA.get("[data-sa-role-name]").element.parentElement?.children).toHaveLength(1)

  const userBubbleA = wrapper.get('[data-super-message="a-user"] [data-user-message-bubble]')
  expect(userBubbleA.classes()).not.toContain("sa-ticket-accent")
  expect(userBubbleA.attributes("data-sa-accent-slot")).toBeUndefined()

  // Enter interactive Focus B (hiding ticket A messages): b-sa's quote of a-sa STILL retains ticket A's slot 3, never ticket B's slot 21!
  await wrapper.get("[data-tickets-menu]").trigger("click")
  await flushPromises()
  const focusBtnB = document.body.querySelector<HTMLButtonElement>(`[data-ticket-focus-id="${ticketB.id}"]`)
  expect(focusBtnB).toBeTruthy()
  focusBtnB!.click()
  await flushPromises()
  expect(wrapper.find('[data-super-message="a-sa"]').exists()).toBe(false)
  const focusedQuote = wrapper.get('[data-super-message="b-sa"] [data-reply-quote="a-sa"]')
  expect(focusedQuote.attributes("data-reply-quote-state")).toBe("unavailable")
  expect(focusedQuote.attributes("data-sa-quote-rail")).toBe("true")
  expect(focusedQuote.attributes("data-sa-accent-slot")).toBe(String(slotA))
  expect(focusedQuote.classes()).toContain("sa-ticket-rail")
})

test("core acceptance UI: A -> B -> A interleaved display reuses slot 12 on toggle & SA dot with distinct ticket names and never recolors A history", async () => {
  const sharedSlot = 12
  const ticketA = makeTicket("ticket-a", "登录鉴权修复", { accentSlot: sharedSlot })
  const ticketB = makeTicket("ticket-b", "支付回调重试", { accentSlot: sharedSlot })

  const { wrapper } = await mountView(makeRoom({
    focusTicketId: ticketB.id,
    tickets: [ticketA, ticketB],
    messages: [
      makeMessage("a-user-1", { role: "user", text: "修复登录态", ticketId: ticketA.id, state: "assigned" }),
      makeMessage("a-worker-1", { role: "worker", text: "A已完成第一阶段", ticketId: ticketA.id, sourceMessageId: "a-user-1", workerEvent: "result" }),
      makeMessage("b-user-1", { role: "user", text: "排查支付回调", ticketId: ticketB.id, state: "assigned" }),
      makeMessage("b-assistant-1", { role: "assistant", text: "正在查看支付回调", ticketId: ticketB.id, sourceMessageId: "b-user-1" }),
      makeMessage("a-user-2", { role: "user", text: "恢复A后继续验证", ticketId: ticketA.id, state: "assigned" }),
      makeMessage("a-worker-2", { role: "worker", text: "A二次验证通过", ticketId: ticketA.id, sourceMessageId: "a-user-2", workerEvent: "result" }),
    ],
  }))

  for (const [msgId, expectedTicket] of [
    ["a-user-1", ticketA],
    ["a-worker-1", ticketA],
    ["b-user-1", ticketB],
    ["b-assistant-1", ticketB],
    ["a-user-2", ticketA],
    ["a-worker-2", ticketA],
  ] as const) {
    const row = wrapper.get(`[data-super-message="${msgId}"]`)
    const toggle = row.get("[data-execution-toggle]")
    expect(toggle.attributes("data-sa-accent-slot")).toBe(String(sharedSlot))
    expect(toggle.text()).toBe(expectedTicket.title)
    expect(toggle.get("[data-sa-ticket-label]").attributes("data-sa-ticket-id")).toBe(expectedTicket.id)
  }
  expect(wrapper.get('[data-super-message="b-assistant-1"] [data-sa-role-dot]').attributes("data-sa-accent-slot")).toBe(String(sharedSlot))
})

test("multi-ticket and unattributed degrade cleanly while legacy tickets without accentSlot resolve distinct stable colors across all 4 targets without altering existing slots", async () => {
  const ticketA = makeTicket("ta", "事项Alpha", { accentSlot: 3, status: "working", sessionId: "sess-a" })
  const ticketB = makeTicket("tb", "事项Beta", { accentSlot: 27, status: "working", sessionId: "sess-b" })
  const ticketLegacy1 = makeTicket("tl-1", "旧事项甲", { status: "working" }) // missing accentSlot
  const ticketLegacy2 = makeTicket("tl-2", "旧事项乙", { status: "working" }) // missing accentSlot

  const snapshot = makeRoom({
    supportsStop: true,
    supportsReplyFeedback: true,
    focusTicketId: ticketB.id,
    tickets: [ticketA, ticketB, ticketLegacy1, ticketLegacy2],
    messages: [
      // Multi-ticket request + SA reply + active parallel progress
      makeMessage("multi-user", { role: "user", text: "同时做A和B", state: "assigned", ticketIds: [ticketA.id, ticketB.id] }),
      makeMessage("dispatch-a", { role: "assistant", kind: "dispatch", text: ticketA.title, ticketId: ticketA.id, sourceMessageId: "multi-user", canStop: true }),
      makeMessage("dispatch-b", { role: "assistant", kind: "dispatch", text: ticketB.title, ticketId: ticketB.id, sourceMessageId: "multi-user", canStop: true }),
      makeMessage("multi-sa", { role: "assistant", text: "已并行派发A和B", sourceMessageId: "multi-user", ticketIds: [ticketA.id, ticketB.id] }),
      // Quote of multi-ticket message from a single-ticket message
      makeMessage("quote-multi", { role: "user", text: "跟进这个拆分", replyTo: "multi-sa", ticketId: ticketA.id, state: "assigned" }),
      // Unattributed conversation
      makeMessage("plain-user", { role: "user", text: "今天天气不错", state: "answered" }),
      makeMessage("plain-sa", { role: "assistant", text: "确实不错", sourceMessageId: "plain-user" }),
      // Legacy ticket 1 without accentSlot (with active progress + SA reply + cross-ticket quote + milestone without explicit ticketId)
      makeMessage("legacy1-user", { role: "user", text: "旧记录任务甲", ticketId: ticketLegacy1.id, state: "assigned" }),
      makeMessage("legacy1-disp", { role: "assistant", kind: "dispatch", text: ticketLegacy1.title, ticketId: ticketLegacy1.id, sourceMessageId: "legacy1-user", canStop: true }),
      makeMessage("legacy1-sa", { role: "assistant", text: "处理旧记录甲", ticketId: ticketLegacy1.id, sourceMessageId: "legacy1-user" }),
      // Legacy ticket 2 without accentSlot (quotes legacy1-sa cross-ticket + active progress + SA reply)
      makeMessage("legacy2-user", { role: "user", text: "旧记录任务乙", replyTo: "legacy1-sa", ticketId: ticketLegacy2.id, state: "assigned" }),
      makeMessage("legacy2-disp", { role: "assistant", kind: "dispatch", text: ticketLegacy2.title, ticketId: ticketLegacy2.id, sourceMessageId: "legacy2-user", canStop: true }),
      makeMessage("legacy2-sa", { role: "assistant", text: "处理旧记录乙", replyTo: "legacy1-sa", ticketId: ticketLegacy2.id, sourceMessageId: "legacy2-user" }),
      makeMessage("quote-legacy-ms", { role: "user", text: "引用旧里程碑", replyTo: "ms-legacy1", ticketId: ticketA.id, state: "assigned" }),
    ],
    feedback: {
      cursor: 2,
      previewGeneration: "gen-multi",
      processes: [],
      items: [
        { itemId: "ack-multi", kind: "ack", sourceMessageId: "multi-user", revision: 0, text: "已拆分并行处理中", status: "completed", seq: 1, createdAt: "now", updatedAt: "now" },
        // Milestone omitting explicit ticketId on single-ticket legacy1-user must still resolve via canonical row.linkedTickets!
        { itemId: "ms-legacy1", kind: "milestone", sourceMessageId: "legacy1-user", revision: 0, text: "旧事项甲阶段进展", status: "completed", seq: 2, createdAt: "now", updatedAt: "now" },
      ],
    },
  })

  const { wrapper } = await mountView(snapshot)

  // Multi-ticket SA reply: each ticket name colored individually inside toggle, NO role dot (and no empty spacer before role name), expand/collapse works.
  const multiSa = wrapper.get('[data-super-message="multi-sa"]')
  expect(multiSa.find("[data-sa-role-dot]").exists()).toBe(false)
  expect(multiSa.get("[data-sa-role-name]").element.parentElement?.children).toHaveLength(1)
  const multiToggle = multiSa.get("[data-execution-toggle]")
  expect(multiToggle.attributes("data-sa-accent-slot")).toBeUndefined()
  expect(multiToggle.findAll("[data-sa-ticket-label]").map(el => [el.attributes("data-sa-ticket-id"), el.attributes("data-sa-accent-slot"), el.text()])).toEqual([
    ["ta", "3", "事项Alpha"],
    ["tb", "27", "事项Beta"],
  ])
  await multiToggle.trigger("click")
  expect(multiSa.get("[data-execution-details]").text()).toContain("事项Alpha")
  expect(multiSa.get("[data-execution-details]").text()).toContain("事项Beta")
  await multiToggle.trigger("click")
  expect(multiSa.find("[data-execution-details]").exists()).toBe(false)

  // Multi-ticket progress bar & feedback header: keep default border-ui-accent and NO role dot (and no spacer node in feedback header).
  const multiProgress = wrapper.get('[data-agent-progress-for="multi-user"]')
  expect(multiProgress.attributes("data-sa-progress-rail")).toBeUndefined()
  expect(multiProgress.attributes("data-sa-accent-slot")).toBeUndefined()
  expect(multiProgress.classes()).toContain("border-ui-accent")
  const multiFeedbackGroup = wrapper.get('[data-feedback-group-for="multi-user"]')
  expect(multiFeedbackGroup.find("[data-sa-role-dot]").exists()).toBe(false)
  expect(multiFeedbackGroup.get("[data-sa-role-name]").element.parentElement?.children).toHaveLength(1)

  // Quoting a multi-ticket message stays default rail (does NOT borrow the replying message's slot 3).
  const multiQuote = wrapper.get('[data-super-message="quote-multi"] [data-reply-quote="multi-sa"]')
  expect(multiQuote.attributes("data-sa-quote-rail")).toBeUndefined()
  expect(multiQuote.classes()).toContain("border-ui-accent")

  // Unattributed messages: NO ticket label and NO role dot.
  for (const id of ["plain-user", "plain-sa"]) {
    const row = wrapper.get(`[data-super-message="${id}"]`)
    expect(row.find("[data-sa-ticket-label]").exists()).toBe(false)
    expect(row.find("[data-sa-role-dot]").exists()).toBe(false)
  }

  // Legacy tickets without accentSlot: immediately get deterministic distinct valid slots (distinct from each other and from existing 3/27).
  const legacy1Sa = wrapper.get('[data-super-message="legacy1-sa"]')
  const legacy2Sa = wrapper.get('[data-super-message="legacy2-sa"]')
  const slotLegacy1 = Number(legacy1Sa.get("[data-execution-toggle]").attributes("data-sa-accent-slot"))
  const slotLegacy2 = Number(legacy2Sa.get("[data-execution-toggle]").attributes("data-sa-accent-slot"))
  expect(isValidAccentSlot(slotLegacy1)).toBe(true)
  expect(isValidAccentSlot(slotLegacy2)).toBe(true)
  expect(new Set([3, 27, slotLegacy1, slotLegacy2]).size).toBe(4)

  // All 4 targets for legacy1 share slotLegacy1:
  expect(legacy1Sa.get("[data-execution-toggle]").classes()).toContain("sa-ticket-label")
  expect(legacy1Sa.get("[data-execution-toggle] [data-sa-ticket-label]").text()).toBe("旧事项甲")
  expect(legacy1Sa.get("[data-sa-role-dot]").attributes("data-sa-accent-slot")).toBe(String(slotLegacy1))
  expect(legacy1Sa.get("[data-sa-role-dot]").element.nextElementSibling).toBe(legacy1Sa.get("[data-sa-role-name]").element)
  expect(wrapper.get('[data-agent-progress-for="legacy1-user"]').attributes("data-sa-accent-slot")).toBe(String(slotLegacy1))
  expect(wrapper.get('[data-agent-progress-for="legacy1-user"]').classes()).toContain("sa-ticket-rail")
  // Feedback header for legacy1-user (milestone without explicit ticketId) also shows slotLegacy1 dot!
  expect(wrapper.get('[data-feedback-group-for="legacy1-user"] [data-sa-role-dot]').attributes("data-sa-accent-slot")).toBe(String(slotLegacy1))
  // Cross-ticket quote of legacy1-sa inside legacy2-sa & quote of ms-legacy1 inside ticketA message BOTH use slotLegacy1!
  expect(wrapper.get('[data-super-message="legacy2-sa"] [data-reply-quote="legacy1-sa"]').attributes("data-sa-accent-slot")).toBe(String(slotLegacy1))
  expect(wrapper.get('[data-super-message="quote-legacy-ms"] [data-reply-quote="ms-legacy1"]').attributes("data-sa-accent-slot")).toBe(String(slotLegacy1))

  // All 4 targets for legacy2 share slotLegacy2 (distinct from legacy1):
  expect(legacy2Sa.get("[data-execution-toggle]").attributes("data-sa-accent-slot")).toBe(String(slotLegacy2))
  expect(legacy2Sa.get("[data-sa-role-dot]").attributes("data-sa-accent-slot")).toBe(String(slotLegacy2))
  expect(wrapper.get('[data-agent-progress-for="legacy2-user"]').attributes("data-sa-accent-slot")).toBe(String(slotLegacy2))

  // Composer quote preview for legacy1-sa uses slotLegacy1 (even while focusTicketId = ticketB).
  await legacy1Sa.get('button[aria-label="引用"]').trigger("click")
  await flushPromises()
  expect(wrapper.get("[data-composer-quote]").attributes("data-sa-accent-slot")).toBe(String(slotLegacy1))
  expect(wrapper.get("[data-composer-quote]").classes()).toContain("sa-ticket-rail")

  // Reopen produces the exact same resolved slots for legacy tickets and preserves existing slots 3 & 27.
  wrapper.unmount()
  const reopened = await mountView(snapshot)
  expect(reopened.wrapper.get('[data-super-message="legacy1-sa"] [data-execution-toggle]').attributes("data-sa-accent-slot")).toBe(String(slotLegacy1))
  expect(reopened.wrapper.get('[data-super-message="legacy2-sa"] [data-execution-toggle]').attributes("data-sa-accent-slot")).toBe(String(slotLegacy2))
  expect(reopened.wrapper.get('[data-super-message="multi-sa"] [data-sa-ticket-id="ta"]').attributes("data-sa-accent-slot")).toBe("3")
  expect(reopened.wrapper.get('[data-super-message="multi-sa"] [data-sa-ticket-id="tb"]').attributes("data-sa-accent-slot")).toBe("27")
})

test("refresh/reopen, theme toggle (light <-> dark), and scrolling never change ticket accentSlot on toggle, dot, progress, or quote rails", async () => {
  const ticketA = makeTicket("t-stable", "稳定性验证", { accentSlot: 19, status: "working" })
  const snapshot = makeRoom({
    supportsStop: true,
    tickets: [ticketA],
    messages: [
      makeMessage("m1", { role: "user", text: "第一条", ticketId: ticketA.id, state: "assigned" }),
      makeMessage("d1", { role: "assistant", kind: "dispatch", text: ticketA.title, ticketId: ticketA.id, sourceMessageId: "m1", canStop: true }),
      makeMessage("m2", { role: "assistant", text: "回复", replyTo: "m1", ticketId: ticketA.id, sourceMessageId: "m1" }),
    ],
  })

  const assertSlots = (w: VueWrapper) => {
    expect(w.get('[data-super-message="m2"] [data-execution-toggle]').attributes("data-sa-accent-slot")).toBe("19")
    expect(w.get('[data-super-message="m2"] [data-sa-role-dot]').attributes("data-sa-accent-slot")).toBe("19")
    expect(w.get('[data-super-message="m2"] [data-reply-quote="m1"]').attributes("data-sa-accent-slot")).toBe("19")
    expect(w.get('[data-agent-progress-for="m1"]').attributes("data-sa-accent-slot")).toBe("19")
  }

  document.documentElement.dataset.theme = "light"
  const first = await mountView(snapshot)
  assertSlots(first.wrapper)

  document.documentElement.dataset.theme = "dark"
  await flushPromises()
  assertSlots(first.wrapper)

  await first.wrapper.get("[data-session-scroll-viewport]").trigger("scroll")
  await flushPromises()
  assertSlots(first.wrapper)

  first.wrapper.unmount()
  document.documentElement.dataset.theme = "light"
  const reopened = await mountView(snapshot)
  assertSlots(reopened.wrapper)
})

test("ordinary session AgentUserMessage stays untouched without SA accent markers", async () => {
  pinia = createPinia()
  const wrapper = mount(AgentUserMessage, {
    props: {
      input: {
        author: { kind: "user", userId: "u1" },
        state: "delivered",
        createdAt: "2026-11-27T00:00:00.000Z",
        content: [{ type: "text", text: "Ordinary session message" }],
      },
    },
    global: { plugins: [pinia, i18n] },
  })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.find("[data-sa-progress-rail]").exists()).toBe(false)
  expect(wrapper.find("[data-sa-quote-rail]").exists()).toBe(false)
  expect(wrapper.find("[data-sa-role-dot]").exists()).toBe(false)
  expect(wrapper.find("[data-sa-ticket-label]").exists()).toBe(false)
  expect(wrapper.find("[data-sa-accent-slot]").exists()).toBe(false)
})

test("sa-ticket-accents.css has no capsule or outer message-frame rules and covers all 96 theme styles matching SA_ACCENT_PALETTE and WCAG contrast", () => {
  const cssPath = resolve(import.meta.dirname, "../styles/sa-ticket-accents.css")
  const css = readFileSync(cssPath, "utf8")

  expect(css).not.toContain(".sa-ticket-badge")
  expect(css).not.toContain(".sa-message-rail-left")
  expect(css).not.toContain(".sa-message-rail-right")
  expect(css).toContain(".sa-ticket-label")
  expect(css).toContain(".sa-ticket-rail")
  expect(css).toContain(".sa-ticket-dot")
  const dotRule = /\.sa-ticket-dot\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ""
  expect(dotRule).toContain("height: 1rem;")
  expect(dotRule).toContain("align-items: center;")
  expect(dotRule).toContain("transform: translateY(-1.5px);")
  expect(css).not.toMatch(/border-radius\s*:/u)
  expect(css).not.toMatch(/--ui-color-[a-z-]+\s*:/u)
  expect(css).not.toMatch(/^\s*:root\s*[,{]/mu)

  for (let slot = 0; slot < SA_ACCENT_SLOT_COUNT; slot++) {
    const entry = SA_ACCENT_PALETTE[slot]!
    const lightBlockRe = new RegExp(
      `\\.sa-ticket-accent\\[data-sa-accent-slot="${slot}"\\]\\s*\\{([^}]*)\\}`,
      "u",
    )
    const darkBlockRe = new RegExp(
      `:is\\(:root\\.dark:not\\(\\[data-theme="light"\\]\\),\\s*\\[data-theme="dark"\\]\\)\\s+\\.sa-ticket-accent\\[data-sa-accent-slot="${slot}"\\]\\s*\\{([^}]*)\\}`,
      "u",
    )
    const lightMatch = lightBlockRe.exec(css)
    const darkMatch = darkBlockRe.exec(css)
    expect(lightMatch, `missing light CSS rule for slot ${slot}`).not.toBeNull()
    expect(darkMatch, `missing dark CSS rule for slot ${slot}`).not.toBeNull()

    const lightBlock = lightMatch![1]!
    const darkBlock = darkMatch![1]!
    expect(lightBlock).toContain(`--sa-accent-text: ${entry.light.labelText};`)
    expect(lightBlock).toContain(`--sa-accent-rail: ${entry.light.rail};`)
    expect(darkBlock).toContain(`--sa-accent-text: ${entry.dark.labelText};`)
    expect(darkBlock).toContain(`--sa-accent-rail: ${entry.dark.rail};`)

    expect(wcagContrastRatio(entry.light.labelText, LIGHT_CANVAS)).toBeGreaterThanOrEqual(4.5)
    expect(wcagContrastRatio(entry.light.labelText, LIGHT_SURFACE)).toBeGreaterThanOrEqual(4.5)
    expect(wcagContrastRatio(entry.dark.labelText, DARK_CANVAS)).toBeGreaterThanOrEqual(4.5)
    expect(wcagContrastRatio(entry.dark.labelText, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5)
    expect(wcagContrastRatio(entry.light.rail, LIGHT_CANVAS)).toBeGreaterThanOrEqual(3.0)
    expect(wcagContrastRatio(entry.light.rail, LIGHT_SURFACE)).toBeGreaterThanOrEqual(3.0)
    expect(wcagContrastRatio(entry.dark.rail, DARK_CANVAS)).toBeGreaterThanOrEqual(3.0)
    expect(wcagContrastRatio(entry.dark.rail, DARK_SURFACE)).toBeGreaterThanOrEqual(3.0)
  }
})

test("custom Super Agent display name updates both speaker headers live, persists on reopen, restores default when cleared, and preserves ticket accent dots and feature names", async () => {
  const slotA = 3
  const slotB = 21
  const ticketA = makeTicket("ta", "登录鉴权修复", { accentSlot: slotA, status: "working" })
  const ticketB = makeTicket("tb", "支付回调重试", { accentSlot: slotB, status: "working" })

  const roomSnapshot = makeRoom({
    supportsStop: true,
    supportsReplyFeedback: true,
    supportsProactiveFollowUp: true,
    followUp: {
      authorized: false,
      authVersion: 1,
      globalDisabled: false,
      activeDeviceCount: 0,
      devices: [],
      autoEnrollOrdinarySessions: false,
      ordinarySessionRuleMode: "shadow",
      needsConsent: true,
      subscribedScheduleCount: 0,
      subscribedSessionCount: 0,
      pendingTriageCount: 0,
    },
    tickets: [ticketA, ticketB],
    messages: [
      makeMessage("a-user", { role: "user", text: "排查登录态", ticketId: ticketA.id, state: "assigned" }),
      makeMessage("a-sa", { role: "assistant", text: "我先检查登录态中间件。", ticketId: ticketA.id, sourceMessageId: "a-user" }),
      makeMessage("a-worker", { role: "worker", text: "日志检查完成", ticketId: ticketA.id, sourceMessageId: "a-user", workerEvent: "result" }),
      makeMessage("b-user", { role: "user", text: "处理支付回调", ticketId: ticketB.id, state: "assigned" }),
      makeMessage("b-disp", { role: "assistant", kind: "dispatch", text: ticketB.title, ticketId: ticketB.id, sourceMessageId: "b-user", canStop: true }),
      makeMessage("multi-user", { role: "user", text: "同时看 A 和 B", state: "assigned", ticketIds: [ticketA.id, ticketB.id] }),
      makeMessage("multi-sa", { role: "assistant", text: "已并行处理", sourceMessageId: "multi-user", ticketIds: [ticketA.id, ticketB.id] }),
      makeMessage("plain-user", { role: "user", text: "你好", state: "answered" }),
      makeMessage("plain-sa", { role: "assistant", text: "你好，有什么需要协助？", sourceMessageId: "plain-user" }),
    ],
    feedback: {
      cursor: 1,
      previewGeneration: "gen-rename",
      processes: [],
      items: [
        { itemId: "ack-b", kind: "ack", sourceMessageId: "b-user", revision: 0, ticketId: ticketB.id, text: "已收到，开始排查支付回调", status: "completed", seq: 1, createdAt: "now", updatedAt: "now" },
      ],
    },
  })

  const mountSettings = () => {
    const settingsPinia = createPinia()
    const settingsApi = { ...getClient(), superAgent: { snapshot: vi.fn(), send: vi.fn(), correct: vi.fn(), settings: vi.fn() } }
    const settingsWrapper = mount(WorkspaceAgentSettings, {
      global: { plugins: [settingsPinia, i18n], provide: { [platformClientKey as symbol]: settingsApi } },
    })
    return {
      wrapper: settingsWrapper,
      unmount: () => {
        settingsWrapper.unmount()
        disposePinia(settingsPinia)
      },
    }
  }

  const assertViewNamesAndDots = (view: VueWrapper, expectedName: string) => {
    // 1. Single-ticket SA message header (WorkspaceMessage.vue): dot stays left of name with unchanged slot/size/classes.
    const saRowA = view.get('[data-super-message="a-sa"]')
    const dotA = saRowA.get("[data-sa-role-dot]")
    const nameA = saRowA.get("[data-sa-role-name]")
    expect(nameA.text()).toBe(expectedName)
    expect(nameA.classes()).not.toContain("sa-ticket-accent")
    expect(nameA.classes()).not.toContain("sa-ticket-label")
    expect(dotA.text()).toBe("·")
    expect(dotA.attributes("data-sa-accent-slot")).toBe(String(slotA))
    expect(dotA.classes()).toContain("sa-ticket-accent")
    expect(dotA.classes()).toContain("sa-ticket-dot")
    expect(dotA.element.nextElementSibling).toBe(nameA.element)

    // 2. Single-ticket SA feedback group header (WorkspaceAgentView.vue): aria-label + role name update, dot unchanged.
    const feedbackB = view.get('[data-feedback-group-for="b-user"]')
    const dotB = feedbackB.get("[data-sa-role-dot]")
    const nameB = feedbackB.get("[data-sa-role-name]")
    expect(feedbackB.attributes("aria-label")).toBe(expectedName)
    expect(nameB.text()).toBe(expectedName)
    expect(nameB.classes()).not.toContain("sa-ticket-accent")
    expect(dotB.text()).toBe("·")
    expect(dotB.attributes("data-sa-accent-slot")).toBe(String(slotB))
    expect(dotB.classes()).toContain("sa-ticket-accent")
    expect(dotB.classes()).toContain("sa-ticket-dot")
    expect(dotB.element.nextElementSibling).toBe(nameB.element)

    // 3. Multi-ticket & unattributed SA replies show the same name and STILL have NO dot.
    for (const id of ["multi-sa", "plain-sa"]) {
      const row = view.get(`[data-super-message="${id}"]`)
      expect(row.get("[data-sa-role-name]").text()).toBe(expectedName)
      expect(row.find("[data-sa-role-dot]").exists()).toBe(false)
      expect(row.get("[data-sa-role-name]").element.parentElement?.children).toHaveLength(1)
    }

    // 4. Worker speaker label stays untouched and has no dot.
    const workerRow = view.get('[data-super-message="a-worker"]')
    expect(workerRow.get("[data-sa-role-name]").text()).toBe("执行 Agent")
    expect(workerRow.find("[data-sa-role-dot]").exists()).toBe(false)

    // 5. Ticket label and progress rail coloring remain untouched.
    expect(saRowA.get("[data-execution-toggle]").attributes("data-sa-accent-slot")).toBe(String(slotA))
    expect(view.get('[data-agent-progress-for="b-user"]').attributes("data-sa-accent-slot")).toBe(String(slotB))
  }

  useWorkspaceAgentMode().value = true
  const firstView = await mountView(roomSnapshot, "zh-cmn-Hans-CN")
  const firstSettings = mountSettings()
  try {
    // Default name before any customization.
    assertViewNamesAndDots(firstView.wrapper, "Super Agent")
    expect(firstSettings.wrapper.get("#workspace-agent-mode").text()).toBe("启用 Super Agent")

    // Rename in Settings -> both SA conversation headers update immediately.
    const input = firstSettings.wrapper.get<HTMLInputElement>("[data-super-agent-display-name]")
    await input.setValue("  星辰助理  ")
    await input.trigger("keydown", { key: "Enter" })
    await flushPromises()
    expect(input.element.value).toBe("星辰助理")
    expect(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)).toBe("星辰助理")
    assertViewNamesAndDots(firstView.wrapper, "星辰助理")

    // Feature-name occurrences of "Super Agent" remain untouched in both settings and conversation UI.
    expect(firstSettings.wrapper.get("#workspace-agent-mode").text()).toBe("启用 Super Agent")
    expect(firstSettings.wrapper.get("#workspace-agent-description").text()).toContain("Super Agent")
    expect(firstView.wrapper.get("[data-follow-up-consent-banner]").text()).toContain("Super Agent")
    expect(firstView.wrapper.get("[data-follow-up-consent-banner]").text()).not.toContain("星辰助理")
  } finally {
    firstSettings.unmount()
  }

  // Close and reopen both view and settings -> persisted name still applies.
  firstView.wrapper.unmount()
  const reopenedView = await mountView(roomSnapshot, "zh-cmn-Hans-CN")
  const reopenedSettings = mountSettings()
  try {
    const input = reopenedSettings.wrapper.get<HTMLInputElement>("[data-super-agent-display-name]")
    expect(input.element.value).toBe("星辰助理")
    assertViewNamesAndDots(reopenedView.wrapper, "星辰助理")

    // Whitespace-only save immediately restores default "Super Agent".
    await input.setValue("    ")
    await input.trigger("blur")
    await flushPromises()
    expect(input.element.value).toBe("")
    expect(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)).toBeNull()
    assertViewNamesAndDots(reopenedView.wrapper, "Super Agent")

    // Rename again, then clear with empty string to restore default.
    await input.setValue("Jarvis")
    await flushPromises()
    assertViewNamesAndDots(reopenedView.wrapper, "Jarvis")
    await input.setValue("")
    await input.trigger("keydown", { key: "Enter" })
    await flushPromises()
    expect(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)).toBeNull()
    assertViewNamesAndDots(reopenedView.wrapper, "Super Agent")
  } finally {
    reopenedSettings.unmount()
  }

  // Standalone WorkspaceMessage without assistantName prop also reads and reacts to saved display name.
  localStorage.setItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY, "独立总控")
  const standalonePinia = createPinia()
  const standalone = mount(WorkspaceMessage, {
    props: {
      message: makeMessage("standalone-sa", { role: "assistant", text: "收到" }),
      accentTickets: [ticketA],
      animateSend: false,
      touch: false,
      canFork: false,
      forkDisabled: false,
    },
    global: {
      plugins: [standalonePinia, i18n],
      stubs: { AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" } },
    },
  })
  try {
    expect(standalone.get("[data-sa-role-name]").text()).toBe("独立总控")
    expect(standalone.get("[data-sa-role-dot]").attributes("data-sa-accent-slot")).toBe(String(slotA))
  } finally {
    standalone.unmount()
    disposePinia(standalonePinia)
  }
})

test("tickets menu colors only ticket title text in both active and expanded archived lists matching conversation toggle slots while preserving non-title chrome, follow-up runs, interactions, and theme links", async () => {
  const newTicket = makeTicket("t-new", "导出性能优化", { accentSlot: 18, status: "working", scope: "优化大表格导出" })
  const legacyActive = makeTicket("t-leg-active", "登录鉴权修复", { status: "queued", scope: "修复旧会话 token 失效" }) // legacy without accentSlot
  const archivedColored = makeTicket("t-arch-colored", "历史归档事项", { accentSlot: 9, archiveState: "archived", scope: "已完成的归档任务" })
  const archivedLegacy = makeTicket("t-arch-legacy", "存量归档事项", { archiveState: "archived", scope: "存量无色号归档任务" })

  const { wrapper } = await mountView(makeRoom({
    supportsTicketArchive: true,
    supportsProactiveFollowUp: true,
    tickets: [newTicket, legacyActive, archivedColored, archivedLegacy],
    messages: [
      makeMessage("u-new", { role: "user", text: "优化导出", ticketId: newTicket.id, state: "assigned" }),
      makeMessage("a-new", { role: "assistant", text: "参考 super-agent-accent.ts 和 https://example.com/docs", ticketId: newTicket.id, sourceMessageId: "u-new" }),
      makeMessage("u-leg", { role: "user", text: "修复登录", ticketId: legacyActive.id, state: "assigned" }),
      makeMessage("a-leg", { role: "assistant", text: "登录已定位", ticketId: legacyActive.id, sourceMessageId: "u-leg" }),
      makeMessage("u-arch-c", { role: "user", text: "历史归档", ticketId: archivedColored.id, state: "answered" }),
      makeMessage("a-arch-c", { role: "assistant", text: "历史归档已完成", ticketId: archivedColored.id, sourceMessageId: "u-arch-c" }),
      makeMessage("u-arch-l", { role: "user", text: "存量归档", ticketId: archivedLegacy.id, state: "answered" }),
      makeMessage("a-arch-l", { role: "assistant", text: "存量归档已完成", ticketId: archivedLegacy.id, sourceMessageId: "u-arch-l" }),
    ],
    followUpRuns: [
      {
        id: "run-standalone-1",
        userId: "user-1",
        workspaceId: "A",
        sourceKind: "schedule",
        sourceId: "sched-1",
        runKey: "sched-1:run-1",
        scheduleId: "sched-1",
        scheduleTitle: "检查 deskfleet 更新",
        status: "completed",
        summary: "已是最新版本",
        delivered: false,
        evidenceAvailability: "available",
        createdAt: "2026-11-27T00:08:00.000Z",
        startedAt: "2026-11-27T00:08:00.000Z",
        finishedAt: "2026-11-27T00:08:10.000Z",
        updatedAt: "2026-11-27T00:08:10.000Z",
      },
    ],
  }))

  // Capture conversation expandable toggle slots first (the source of truth).
  const convSlotNew = wrapper.get('[data-super-message="a-new"] [data-execution-toggle]').attributes("data-sa-accent-slot")
  const convSlotLegacyActive = wrapper.get('[data-super-message="a-leg"] [data-execution-toggle]').attributes("data-sa-accent-slot")
  const convSlotArchColored = wrapper.get('[data-super-message="a-arch-c"] [data-execution-toggle]').attributes("data-sa-accent-slot")
  const convSlotArchLegacy = wrapper.get('[data-super-message="a-arch-l"] [data-execution-toggle]').attributes("data-sa-accent-slot")

  expect(convSlotNew).toBe("18")
  expect(convSlotArchColored).toBe("9")
  expect(isValidAccentSlot(Number(convSlotLegacyActive))).toBe(true)
  expect(isValidAccentSlot(Number(convSlotArchLegacy))).toBe(true)
  expect(new Set([convSlotNew, convSlotLegacyActive, convSlotArchColored, convSlotArchLegacy]).size).toBe(4)

  // Open the 「事项」 popover menu.
  const trigger = wrapper.get("[data-tickets-menu]")
  expect(trigger.classes()).not.toContain("sa-ticket-accent")
  await trigger.trigger("click")
  await flushPromises()
  const panel = document.getElementById(trigger.attributes("aria-controls")!)
  expect(panel).toBeTruthy()

  // Active list: each title span matches its exact conversation slot; row, summary, status <small>, and action buttons stay uncolored.
  for (const [ticketId, expectedSlot, expectedTitle] of [
    [newTicket.id, convSlotNew!, newTicket.title],
    [legacyActive.id, convSlotLegacyActive!, legacyActive.title],
  ] as const) {
    const titleSpan = panel!.querySelector<HTMLElement>(`[data-sa-ticket-menu-title][data-sa-ticket-id="${ticketId}"]`)
    expect(titleSpan, `missing active menu title for ${ticketId}`).toBeTruthy()
    expect(titleSpan!.textContent).toBe(expectedTitle)
    expect(titleSpan!.getAttribute("data-sa-accent-slot")).toBe(expectedSlot)
    expect(titleSpan!.classList.contains("sa-ticket-accent")).toBe(true)
    expect(titleSpan!.classList.contains("sa-ticket-label")).toBe(true)

    const summary = titleSpan!.closest("summary")!
    const details = summary.closest("details")!
    const row = details.parentElement!
    expect(summary.classList.contains("sa-ticket-accent")).toBe(false)
    expect(details.classList.contains("sa-ticket-accent")).toBe(false)
    expect(row.classList.contains("sa-ticket-accent")).toBe(false)
    const statusSmall = summary.querySelector("small")
    expect(statusSmall).toBeTruthy()
    expect(statusSmall!.classList.contains("text-ui-text-muted")).toBe(true)
    expect(statusSmall!.classList.contains("sa-ticket-accent")).toBe(false)

    // Action icons (focus/locate/archive) remain neutral theme buttons.
    const focusBtn = row.querySelector<HTMLButtonElement>(`[data-ticket-focus-id="${ticketId}"]`)
    expect(focusBtn).toBeTruthy()
    expect(focusBtn!.classList.contains("sa-ticket-accent")).toBe(false)

    // Expand details interaction still works and expanded body stays neutral.
    summary.click()
    await flushPromises()
    expect(details.open || details.hasAttribute("open")).toBe(true)
  }

  // Archived group heading stays neutral muted theme style, and expanding it reveals colored archived ticket titles matching conversation slots.
  const archivedGroupSummary = [...panel!.querySelectorAll<HTMLElement>("details > summary")]
    .find(el => el.textContent?.includes("已归档"))
  expect(archivedGroupSummary).toBeTruthy()
  expect(archivedGroupSummary!.classList.contains("text-ui-text-muted")).toBe(true)
  expect(archivedGroupSummary!.classList.contains("sa-ticket-accent")).toBe(false)
  const archivedGroupDetails = archivedGroupSummary!.closest("details")!
  archivedGroupDetails.open = true
  await flushPromises()

  for (const [ticketId, expectedSlot, expectedTitle] of [
    [archivedColored.id, convSlotArchColored!, archivedColored.title],
    [archivedLegacy.id, convSlotArchLegacy!, archivedLegacy.title],
  ] as const) {
    const titleSpan = archivedGroupDetails.querySelector<HTMLElement>(`[data-sa-ticket-menu-title][data-sa-ticket-id="${ticketId}"]`)
    expect(titleSpan, `missing archived menu title for ${ticketId}`).toBeTruthy()
    expect(titleSpan!.textContent).toBe(expectedTitle)
    expect(titleSpan!.getAttribute("data-sa-accent-slot")).toBe(expectedSlot)
    expect(titleSpan!.classList.contains("sa-ticket-accent")).toBe(true)
    expect(titleSpan!.classList.contains("sa-ticket-label")).toBe(true)
    expect(titleSpan!.closest("summary")!.classList.contains("sa-ticket-accent")).toBe(false)
  }

  // Standalone 「运行记录」 section (heading, run title, status, timestamp, locate icon) has zero SA accent coloring.
  const runsSection = panel!.querySelector<HTMLElement>("[data-ticket-runs-section]")
  expect(runsSection).toBeTruthy()
  expect(runsSection!.querySelectorAll(".sa-ticket-accent, [data-sa-accent-slot], [data-sa-ticket-menu-title]")).toHaveLength(0)

  // Focus interaction from the menu still filters conversation cleanly while keeping the focused ticket's color.
  panel!.querySelector<HTMLButtonElement>(`[data-ticket-focus-id="${legacyActive.id}"]`)!.click()
  await flushPromises()
  expect(wrapper.find('[data-super-message="a-new"]').exists()).toBe(false)
  expect(wrapper.get('[data-super-message="a-leg"] [data-execution-toggle]').attributes("data-sa-accent-slot")).toBe(convSlotLegacyActive)
  expect(wrapper.get("[data-ticket-focus-banner]").classes()).not.toContain("sa-ticket-accent")
})
