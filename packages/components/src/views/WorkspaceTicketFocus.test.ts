import type { SuperAgentApi } from "@deskfleet/client/desktop-api"
import {
  type SuperMessage,
  type SuperMessageTicketLinks,
  type SuperSnapshot,
  type SuperTicket,
} from "@deskfleet/protocol/super-agent"
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../i18n/index.ts"
import WorkspaceAgentView from "./WorkspaceAgentView.vue"

const makeTicket = (id: string, title: string, extra: Partial<SuperTicket> = {}): SuperTicket => ({
  id,
  title,
  scope: title,
  summary: "",
  provider: "codex",
  updatedAt: "2026-11-27T12:00:00.000Z",
  ...extra,
})

const makeMessage = (id: string, extra: Partial<SuperMessage> = {}): SuperMessage => ({
  id,
  role: "user",
  text: id,
  createdAt: "2026-11-27T12:00:00.000Z",
  ...extra,
})

const makeRoom = (extra: Partial<SuperSnapshot> = {}): SuperSnapshot => ({
  workspaceId: "ws-1",
  provider: "codex",
  supportsTicketArchive: true,
  supportsTicketLinks: true,
  tickets: [],
  messages: [],
  ...extra,
})

let wrappers: VueWrapper[] = []
let pinia: ReturnType<typeof createPinia> | undefined
const originalLocale = i18n.global.locale.value

async function mountView(initial: SuperSnapshot, locale: "zh-cmn-Hans-CN" | "en-US" = "zh-cmn-Hans-CN") {
  i18n.global.locale.value = locale
  let state: SuperSnapshot = initial
  let createdSeq = 0
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
    send: vi.fn<SuperAgentApi["send"]>(async request => {
      state = {
        ...state,
        messages: [...state.messages, makeMessage(request.messageId, { text: request.text, replyTo: request.replyTo, state: "answered" })],
      }
      return state
    }),
    correct: vi.fn<SuperAgentApi["correct"]>(async () => state),
    linkMessage: vi.fn<NonNullable<SuperAgentApi["linkMessage"]>>(async ({ messageId, ticketIds }) => {
      const target = state.messages.find(m => m.id === messageId)
      const parentId = target?.role === "assistant" && target.sourceMessageId ? target.sourceMessageId : target?.role === "user" ? target.id : undefined
      const affected = new Set<string>([messageId])
      if (parentId) {
        affected.add(parentId)
        for (const msg of state.messages) {
          if (msg.role === "assistant" && msg.sourceMessageId === parentId && msg.kind !== "dispatch") affected.add(msg.id)
        }
      }
      const nextLinks: SuperMessageTicketLinks = { ...(state.messageTicketLinks ?? {}) }
      for (const id of affected) nextLinks[id] = [...ticketIds]
      state = {
        ...state,
        messageTicketLinks: nextLinks,
        messages: state.messages.map(msg => affected.has(msg.id) ? { ...msg, ticketIds: [...ticketIds] } : msg),
      }
      return state
    }),
    createTicket: vi.fn<NonNullable<SuperAgentApi["createTicket"]>>(async ({ messageId, title, scope }) => {
      const newTicket = makeTicket(`manual-${++createdSeq}`, title, {
        scope: scope ?? title,
        accentSlot: (10 + createdSeq) % 48,
      })
      const target = state.messages.find(m => m.id === messageId)
      const parentId = target?.role === "assistant" && target.sourceMessageId ? target.sourceMessageId : target?.role === "user" ? target.id : undefined
      const affected = new Set<string>([messageId])
      if (parentId) {
        affected.add(parentId)
        for (const msg of state.messages) {
          if (msg.role === "assistant" && msg.sourceMessageId === parentId && msg.kind !== "dispatch") affected.add(msg.id)
        }
      }
      const nextLinks: SuperMessageTicketLinks = { ...(state.messageTicketLinks ?? {}) }
      for (const id of affected) {
        const prev = nextLinks[id] ?? state.messages.find(m => m.id === id)?.ticketIds ?? []
        nextLinks[id] = [...new Set([...prev, newTicket.id])]
      }
      state = {
        ...state,
        tickets: [...state.tickets, newTicket],
        messageTicketLinks: nextLinks,
        messages: state.messages.map(msg => affected.has(msg.id) ? { ...msg, ticketIds: nextLinks[msg.id] } : msg),
      }
      return state
    }),
    settings: vi.fn<SuperAgentApi["settings"]>(async () => state),
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: {} },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/settings/agents", name: "settings-agents", component: {} },
    ],
  })
  await router.push({ name: "workspace-agent", params: { workspaceId: initial.workspaceId ?? "ws-1" } })
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
  return { wrapper, api, getState: () => state, update: (next: SuperSnapshot) => { state = next } }
}

async function openTicketsPanel(wrapper: VueWrapper) {
  const trigger = wrapper.get("[data-tickets-menu]")
  await trigger.trigger("click")
  await flushPromises()
  return new DOMWrapper(document.getElementById(trigger.attributes("aria-controls")!)!)
}

function renderedMessageIds(wrapper: VueWrapper): string[] {
  return wrapper.findAll<HTMLElement>("[data-super-message]").map(el => el.attributes("data-super-message")!)
}

afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount()
  if (pinia) { disposePinia(pinia); pinia = undefined }
  i18n.global.locale.value = originalLocale
  vi.restoreAllMocks()
})

test("core acceptance UI: discussion A -> interjection B -> quote A to execute; focus A shows only A chain in order; show all restores B and scroll position", async () => {
  const ticketA = makeTicket("ticket-a", "SA 配色方案", { accentSlot: 5, status: undefined })
  const initial = makeRoom({
    tickets: [ticketA],
    messageTicketLinks: {
      "disc-a-q": [ticketA.id],
      "disc-a-a": [ticketA.id],
      "exec-a-u": [ticketA.id],
      "exec-a-w": [ticketA.id],
    },
    messages: [
      makeMessage("disc-a-q", { role: "user", text: "怎么给 SA 事项配色？", state: "answered", ticketIds: [ticketA.id] }),
      makeMessage("disc-a-a", { role: "assistant", text: "用 48 色 OKLab 方案。", sourceMessageId: "disc-a-q", ticketIds: [ticketA.id] }),
      makeMessage("interject-b-q", { role: "user", text: "顺便问一下 B 怎么配置？", state: "answered" }),
      makeMessage("interject-b-a", { role: "assistant", text: "B 在 settings.json 里配置。", sourceMessageId: "interject-b-q" }),
      makeMessage("exec-a-u", { role: "user", text: "认可，按这个方案开发", replyTo: "disc-a-a", state: "assigned", ticketId: ticketA.id, ticketIds: [ticketA.id] }),
      makeMessage("exec-a-w", { role: "worker", text: "配色方案已完成。", sourceMessageId: "exec-a-u", ticketId: ticketA.id, ticketIds: [ticketA.id], workerEvent: "result" }),
    ],
  })

  const { wrapper } = await mountView(initial, "zh-cmn-Hans-CN")

  // Full view: coloring reads the exact same canonical record as focus (A messages have slot 5 colored detail toggle + SA role dot + quote rail; B stays neutral; no generic outer frame rails)
  expect(renderedMessageIds(wrapper)).toEqual(["disc-a-q", "disc-a-a", "interject-b-q", "interject-b-a", "exec-a-u", "exec-a-w"])
  expect(wrapper.findAll("[data-sa-ticket-badge]")).toHaveLength(0)
  expect(wrapper.findAll("[data-sa-accent-rail]")).toHaveLength(0)
  for (const id of ["disc-a-q", "disc-a-a", "exec-a-u", "exec-a-w"]) {
    const row = wrapper.get(`[data-super-message="${id}"]`)
    expect(row.get("[data-execution-toggle]").attributes("data-sa-accent-slot")).toBe("5")
    expect(row.get("[data-execution-toggle] [data-sa-ticket-label]").attributes("data-sa-ticket-id")).toBe(ticketA.id)
    expect(row.get("[data-execution-toggle] [data-sa-ticket-label]").text()).toBe(ticketA.title)
  }
  expect(wrapper.get('[data-super-message="disc-a-a"] [data-sa-role-dot]').attributes("data-sa-accent-slot")).toBe("5")
  expect(wrapper.get('[data-super-message="exec-a-u"] [data-reply-quote="disc-a-a"]').attributes("data-sa-accent-slot")).toBe("5")
  for (const id of ["interject-b-q", "interject-b-a"]) {
    const row = wrapper.get(`[data-super-message="${id}"]`)
    expect(row.find("[data-sa-ticket-label]").exists()).toBe(false)
    expect(row.find("[data-sa-role-dot]").exists()).toBe(false)
  }

  // Record a non-bottom scroll position before entering focus
  const viewport = wrapper.get<HTMLElement>("[data-session-scroll-viewport]")
  Object.defineProperties(viewport.element, {
    scrollHeight: { configurable: true, value: 2400 },
    clientHeight: { configurable: true, value: 400 },
  })
  viewport.element.scrollTop = 360
  await viewport.trigger("scroll")

  // Ticket list popover keeps Locate and Archive, and adds Focus right beside Locate
  const panel = await openTicketsPanel(wrapper)
  expect(panel.find(`button[aria-label="${i18n.global.t("superAgent.locateTicketMessage", { name: ticketA.title })}"]`).exists()).toBe(true)
  expect(panel.find(`button[aria-label="${i18n.global.t("superAgent.archiveTicket")} · ${ticketA.title}"]`).exists()).toBe(true)
  const focusBtn = panel.get(`[data-ticket-focus-id="${ticketA.id}"]`)
  expect(focusBtn.attributes("aria-label")).toBe(i18n.global.t("superAgent.focusTicket", { name: ticketA.title }))

  // Click Focus on A
  await focusBtn.trigger("click")
  await flushPromises()

  // Persistent top banner shows "聚焦中：SA 配色方案｜显示全部"
  const banner = wrapper.get("[data-ticket-focus-banner]")
  expect(banner.text()).toContain(`聚焦中：${ticketA.title}`)
  expect(banner.get("[data-ticket-focus-exit]").text()).toBe("显示全部")

  // Focused view displays ONLY A's Q&A, execution, and worker report in chronological order; B is hidden
  expect(renderedMessageIds(wrapper)).toEqual(["disc-a-q", "disc-a-a", "exec-a-u", "exec-a-w"])
  expect(wrapper.find('[data-super-message="interject-b-q"]').exists()).toBe(false)
  expect(wrapper.find('[data-super-message="interject-b-a"]').exists()).toBe(false)

  // Click "显示全部": exits focus, B stays right in place, and scroll position restores to 360
  await banner.get("[data-ticket-focus-exit]").trigger("click")
  await flushPromises()
  expect(wrapper.find("[data-ticket-focus-banner]").exists()).toBe(false)
  expect(renderedMessageIds(wrapper)).toEqual(["disc-a-q", "disc-a-a", "interject-b-q", "interject-b-a", "exec-a-u", "exec-a-w"])
  expect(viewport.element.scrollTop).toBe(360)
})

test("background reference does not leak across tickets; multi-ticket discussion appears in every corresponding focus view with one original copy", async () => {
  const ticketA = makeTicket("ta", "前端方案", { accentSlot: 2 })
  const ticketB = makeTicket("tb", "后端方案", { accentSlot: 21 })
  const ticketC = makeTicket("tc", "背景参考说明", { accentSlot: 33 })
  const { wrapper } = await mountView(makeRoom({
    supportsReplyFeedback: true,
    tickets: [ticketA, ticketB, ticketC],
    messageTicketLinks: {
      "shared-q": [ticketA.id, ticketB.id],
      "shared-a": [ticketA.id, ticketB.id],
      "split-exec": [ticketA.id, ticketB.id],
      "a-report": [ticketA.id],
      "b-report": [ticketB.id],
      "c-bg-ref": [ticketC.id],
    },
    messages: [
      makeMessage("shared-q", { role: "user", text: "拆解前后端方案", state: "answered", ticketIds: [ticketA.id, ticketB.id] }),
      makeMessage("shared-a", { role: "assistant", text: "前后端共用设计文档", sourceMessageId: "shared-q", ticketIds: [ticketA.id, ticketB.id] }),
      makeMessage("split-exec", { role: "user", text: "拆成前后端分别开发", replyTo: "shared-a", state: "assigned", ticketIds: [ticketA.id, ticketB.id] }),
      makeMessage("d-a", { role: "assistant", kind: "dispatch", text: ticketA.title, ticketId: ticketA.id, sourceMessageId: "split-exec" }),
      makeMessage("d-b", { role: "assistant", kind: "dispatch", text: ticketB.title, ticketId: ticketB.id, sourceMessageId: "split-exec" }),
      makeMessage("a-report", { role: "worker", text: "前端完成", sourceMessageId: "split-exec", ticketId: ticketA.id, workerEvent: "result" }),
      makeMessage("b-report", { role: "worker", text: "后端完成", sourceMessageId: "split-exec", ticketId: ticketB.id, workerEvent: "result" }),
      makeMessage("c-bg-ref", { role: "user", text: "参考 A 的方案，给 C 写说明", replyTo: "shared-a", state: "assigned", ticketId: ticketC.id }),
    ],
    feedback: {
      cursor: 2,
      previewGeneration: "g1",
      processes: [],
      items: [
        { itemId: "ms-a", kind: "milestone", sourceMessageId: "split-exec", revision: 0, ticketId: ticketA.id, text: "前端里程碑", status: "completed", seq: 1, createdAt: "now", updatedAt: "now" },
        { itemId: "ms-b", kind: "milestone", sourceMessageId: "split-exec", revision: 0, ticketId: ticketB.id, text: "后端里程碑", status: "completed", seq: 2, createdAt: "now", updatedAt: "now" },
      ],
    },
  }))

  // Multi-ticket shared discussion: NO SA role dot, BOTH colored ticket names rendered in toggle, single copy in DOM
  expect(wrapper.findAll('[data-super-message="shared-a"]')).toHaveLength(1)
  const sharedRow = wrapper.get('[data-super-message="shared-a"]')
  expect(sharedRow.find("[data-sa-role-dot]").exists()).toBe(false)
  expect(sharedRow.findAll('[data-execution-toggle] [data-sa-ticket-label]').map(el => [
    el.attributes("data-sa-ticket-id"),
    el.attributes("data-sa-accent-slot"),
    el.text(),
  ])).toEqual([
    [ticketA.id, "2", ticketA.title],
    [ticketB.id, "21", ticketB.title],
  ])
  // Cross-ticket background reference (c-bg-ref belongs to C, quotes multi-ticket shared-a): quote bar must NOT borrow C's slot 33!
  expect(wrapper.get('[data-super-message="c-bg-ref"] [data-reply-quote="shared-a"]').attributes("data-sa-accent-slot")).toBeUndefined()

  // Focus A: sees shared discussion + split exec + A milestone + A report; NOT B milestone/report or C
  let panel = await openTicketsPanel(wrapper)
  await panel.get(`[data-ticket-focus-id="${ticketA.id}"]`).trigger("click")
  await flushPromises()
  expect(renderedMessageIds(wrapper)).toEqual(["shared-q", "shared-a", "split-exec", "a-report"])
  expect(wrapper.find('[data-feedback-milestone="ms-a"]').exists()).toBe(true)
  expect(wrapper.find('[data-feedback-milestone="ms-b"]').exists()).toBe(false)

  // Focus B: sees the SAME shared discussion + split exec + B milestone + B report; NOT A report or C
  panel = await openTicketsPanel(wrapper)
  await panel.get(`[data-ticket-focus-id="${ticketB.id}"]`).trigger("click")
  await flushPromises()
  expect(renderedMessageIds(wrapper)).toEqual(["shared-q", "shared-a", "split-exec", "b-report"])
  expect(wrapper.find('[data-feedback-milestone="ms-a"]').exists()).toBe(false)
  expect(wrapper.find('[data-feedback-milestone="ms-b"]').exists()).toBe(true)

  // Focus C (background reference): sees ONLY c-bg-ref, NOT shared-q / shared-a
  panel = await openTicketsPanel(wrapper)
  await panel.get(`[data-ticket-focus-id="${ticketC.id}"]`).trigger("click")
  await flushPromises()
  expect(renderedMessageIds(wrapper)).toEqual(["c-bg-ref"])
})

test("unattributed message offers '关联到事项…' and explicit '创建事项'; manual attribution edit syncs badges, colors, and focus filter", async () => {
  const ticketA = makeTicket("ta", "事项甲", { accentSlot: 4 })
  const ticketB = makeTicket("tb", "事项乙", { accentSlot: 18 })
  const { wrapper, api } = await mountView(makeRoom({
    tickets: [ticketA, ticketB],
    messageTicketLinks: {
      "m-a": [ticketA.id],
    },
    messages: [
      makeMessage("m-a", { role: "user", text: "事项甲任务", state: "assigned", ticketId: ticketA.id, ticketIds: [ticketA.id] }),
      makeMessage("u-free", { role: "user", text: "帮我看个独立结论", state: "answered" }),
      makeMessage("a-free", { role: "assistant", text: "这是未归属的直接回答", sourceMessageId: "u-free" }),
    ],
  }), "zh-cmn-Hans-CN")

  // Unattributed discussion stays in conversation without creating a ticket row (only 2 tickets)
  expect(wrapper.get("[data-tickets-menu]").text()).toBe("事项（2）")

  // Unattributed SA reply shows "关联到事项…" instead of a ticket name / "修改归属"
  const freeRow = wrapper.get('[data-super-message="a-free"]')
  expect(freeRow.get("[data-execution-toggle]").text()).toContain("关联到事项…")
  expect(freeRow.find("[data-sa-ticket-label]").exists()).toBe(false)

  // Attributed message shows colored ticket name on the detail toggle -> "修改归属"
  const rowA = wrapper.get('[data-super-message="m-a"]')
  expect(rowA.get("[data-execution-toggle]").text()).toBe(ticketA.title)
  expect(rowA.get("[data-execution-toggle]").attributes("data-sa-accent-slot")).toBe("4")
  await rowA.get("[data-execution-toggle]").trigger("click")
  expect(rowA.get("[data-message-edit-attribution]").text()).toBe("修改归属")

  // Link unattributed discussion to ticketA via "关联到事项…"
  await freeRow.get("[data-execution-toggle]").trigger("click")
  await flushPromises()
  await freeRow.get(`[data-link-ticket-option="${ticketA.id}"]`).trigger("change")
  await freeRow.get("[data-link-tickets-form]").trigger("submit")
  await flushPromises()
  expect(api.linkMessage).toHaveBeenCalledWith({ workspaceId: "ws-1", messageId: "a-free", ticketIds: [ticketA.id] })

  // Immediately synchronized: BOTH u-free & a-free show ticketA's colored label & a-free shows slot 4 SA role dot
  for (const id of ["u-free", "a-free"]) {
    const r = wrapper.get(`[data-super-message="${id}"]`)
    expect(r.get("[data-execution-toggle] [data-sa-ticket-label]").attributes("data-sa-accent-slot")).toBe("4")
    expect(r.get("[data-execution-toggle] [data-sa-ticket-label]").text()).toBe(ticketA.title)
  }
  expect(wrapper.get('[data-super-message="a-free"] [data-sa-role-dot]').attributes("data-sa-accent-slot")).toBe("4")

  // Focus A now includes u-free and a-free
  let panel = await openTicketsPanel(wrapper)
  await panel.get(`[data-ticket-focus-id="${ticketA.id}"]`).trigger("click")
  await flushPromises()
  expect(renderedMessageIds(wrapper)).toEqual(["m-a", "u-free", "a-free"])

  // Now edit attribution of a-free (using retained "修改归属") from A -> B while still inspecting
  const focusedFreeRow = wrapper.get('[data-super-message="a-free"]')
  await focusedFreeRow.get("[data-execution-toggle]").trigger("click")
  await focusedFreeRow.get("[data-message-edit-attribution]").trigger("click")
  await focusedFreeRow.get(`[data-link-ticket-option="${ticketA.id}"]`).trigger("change")
  await focusedFreeRow.get(`[data-link-ticket-option="${ticketB.id}"]`).trigger("change")
  await focusedFreeRow.get("[data-link-tickets-form]").trigger("submit")
  await flushPromises()

  // Immediately removed from Focus A!
  expect(renderedMessageIds(wrapper)).toEqual(["m-a"])

  // Switch to Focus B: u-free & a-free are now visible with B's colored label (slot 18)!
  panel = await openTicketsPanel(wrapper)
  await panel.get(`[data-ticket-focus-id="${ticketB.id}"]`).trigger("click")
  await flushPromises()
  expect(renderedMessageIds(wrapper)).toEqual(["u-free", "a-free"])
  expect(wrapper.get('[data-super-message="a-free"] [data-execution-toggle] [data-sa-ticket-label]').attributes("data-sa-accent-slot")).toBe("18")
  expect(wrapper.get('[data-super-message="a-free"] [data-execution-toggle] [data-sa-ticket-label]').text()).toBe(ticketB.title)
  expect(wrapper.get('[data-super-message="a-free"] [data-sa-role-dot]').attributes("data-sa-accent-slot")).toBe("18")

  // Exit focus and explicitly click "创建事项" to create a tracked ticket without a Worker
  await wrapper.get("[data-ticket-focus-exit]").trigger("click")
  await flushPromises()
  const rowAgain = wrapper.get('[data-super-message="a-free"]')
  await rowAgain.get("[data-execution-toggle]").trigger("click")
  await rowAgain.get("[data-message-create-ticket]").trigger("click")
  await rowAgain.get("[data-create-ticket-title]").setValue("独立跟踪结论")
  await rowAgain.get("[data-create-ticket-form]").trigger("submit")
  await flushPromises()

  expect(api.createTicket).toHaveBeenCalledWith({ workspaceId: "ws-1", messageId: "a-free", title: "独立跟踪结论" })
  expect(wrapper.get("[data-tickets-menu]").text()).toBe("事项（3）")
})

test("starting a new topic while focused on ticket A does not pass focus as routing input or auto-assign the new message to A", async () => {
  const ticketA = makeTicket("ta", "事项A", { accentSlot: 9 })
  const { wrapper, api } = await mountView(makeRoom({
    focusTicketId: ticketA.id,
    tickets: [ticketA],
    messageTicketLinks: { "m-a": [ticketA.id] },
    messages: [makeMessage("m-a", { role: "user", text: "A 任务", ticketId: ticketA.id, ticketIds: [ticketA.id], state: "assigned" })],
  }), "zh-cmn-Hans-CN")

  // Enter Focus A
  const panel = await openTicketsPanel(wrapper)
  await panel.get(`[data-ticket-focus-id="${ticketA.id}"]`).trigger("click")
  await flushPromises()
  expect(wrapper.get("[data-ticket-focus-banner]").text()).toContain("聚焦中：事项A")

  // Send a brand-new unrelated topic while Focus A is active
  const input = wrapper.get("textarea")
  await input.setValue("顺便问一个完全无关的新话题 C")
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()

  // api.send carries NO ticketId and NO focusTicketId
  expect(api.send).toHaveBeenCalledTimes(1)
  const sentPayload = (api.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>
  expect(sentPayload.text).toBe("顺便问一个完全无关的新话题 C")
  expect(sentPayload.ticketId).toBeUndefined()
  expect(sentPayload.focusTicketId).toBeUndefined()
  expect(sentPayload.replyTo).toBeUndefined()

  // Because C was not linked to A, Focus A STILL shows only m-a (C is not pulled into A)
  expect(renderedMessageIds(wrapper)).toEqual(["m-a"])

  // Clicking "显示全部" shows C in the full conversation as unattributed (no ticket label, no rail)
  await wrapper.get("[data-ticket-focus-exit]").trigger("click")
  await flushPromises()
  const newMsgId = String(sentPayload.messageId)
  expect(renderedMessageIds(wrapper)).toEqual(["m-a", newMsgId])
  expect(wrapper.get(`[data-super-message="${newMsgId}"]`).find("[data-sa-ticket-label]").exists()).toBe(false)
})
