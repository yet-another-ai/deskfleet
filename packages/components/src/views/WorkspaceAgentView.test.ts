import type { GithubRepositoryItem } from "@deskfleet/client/central"
import type { SuperAgentApi } from "@deskfleet/client/desktop-api"
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { ref } from "vue"
import { getClient } from "@deskfleet/client/platform"
import { dispatchAppForeground } from "@deskfleet/client/app-foreground"
import { platformClientKey } from "../composables/usePlatformClient.ts"
import { accountSessionKey } from "../composables/useAccountSession.ts"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import type { SuperMessage, SuperSnapshot, SuperTicket } from "../../../../apps/daemon/src/super-agent-protocol.ts"
import { i18n } from "../i18n/index.ts"
import { useProvidersStore } from "../stores/providers.ts"
import { catalogFixture, sessionId, workspaceId } from "../test/catalog.ts"
import { agentElicitation, agentPermission, agentPlanApproval } from "../test/agent.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import WorkspaceAgentView from "./WorkspaceAgentView.vue"
import AgentOutline from "../components/session/AgentOutline.vue"

const ticket = (id: string): SuperTicket => ({ id, title: id, scope: id, summary: "", provider: "codex", status: "working", updatedAt: "now" })
const message = (id: string, extra: Partial<SuperMessage> = {}): SuperMessage => ({ id, role: "user", text: id, createdAt: "now", ...extra })
const room = (extra: Partial<SuperSnapshot> = {}): SuperSnapshot => ({ workspaceId: "A", provider: "codex", tickets: [], messages: [], ...extra })
let wrapper: VueWrapper
let pinia: ReturnType<typeof createPinia>
async function setup(initial: SuperSnapshot, teamId?: string, ios = false, sharedPinia = createPinia(), userId = "signed-in", githubItem?: GithubRepositoryItem) {
  let state = initial
  const machines = ref([{ id: "local-daemon", teamId, name: "Studio Mac", online: true }])
  const api = {
    snapshot: vi.fn<SuperAgentApi["snapshot"]>(async () => state),
    stop: vi.fn<NonNullable<SuperAgentApi["stop"]>>(async () => state),
    archiveTicket: vi.fn<NonNullable<SuperAgentApi["archiveTicket"]>>(async ({ ticketId, archived }) => {
      state = { ...state, tickets: state.tickets.map(item => item.id === ticketId ? { ...item, archiveState: archived ? "archived" : undefined } : item) }
      return state
    }),
    send: vi.fn<SuperAgentApi["send"]>(async request => {
      state = { ...state, messages: [...state.messages, message(request.messageId, { text: request.text, replyTo: request.replyTo, state: "routing" })] }
      return state
    }),
    correct: vi.fn<SuperAgentApi["correct"]>(async () => state),
    settings: vi.fn<SuperAgentApi["settings"]>(async ({ coordinator, provider, coordinatorSelection, workerSelection, workerMode, workerAutoApprove }) => {
      state = { ...state, ...(coordinator && { coordinator }), ...(provider && { provider }),
        ...(coordinatorSelection && { coordinatorOverrides: { model: coordinatorSelection.model, reasoningEffort: coordinatorSelection.reasoningEffort }, coordinatorSelection }),
        ...(workerSelection && { workerSelection: { ...state.workerSelection, model: workerSelection.model, reasoningEffort: workerSelection.reasoningEffort } }),
        ...(workerMode && { workerSelection: { ...state.workerSelection, mode: workerMode.mode ?? undefined } }),
        ...(workerAutoApprove !== undefined && { workerAutoApprove }) }
      return state
    }),
  }
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "new-session", component: {} },
    { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: {} },
    { path: "/sessions/:sessionId", name: "session", component: {} },
    { path: "/settings/github", name: "settings-github", component: {} },
    { path: "/settings/agents", name: "settings-agents", component: {} },
  ] })
  await router.push(initial.workspaceId ? { name: "workspace-agent", params: { workspaceId: initial.workspaceId } } : "/")
  pinia = sharedPinia
  wrapper = mount(WorkspaceAgentView, {
    props: { api, workspaceId: initial.workspaceId }, attachTo: document.body,
    global: {
      plugins: [pinia, i18n, router],
      provide: {
        ...(ios && { [platformClientKey as symbol]: { ...getClient(), platform: "web", mobile: true, remoteWorkspaceAgent: true } }),
        ...(teamId && { [accountSessionKey as symbol]: { account: ref({ user: { id: userId, name: "Ada", email: "ada@example.test" } }), members: ref([]), teamId: ref(teamId), localMachineId: ref("local-daemon"), machineId: ref("local-daemon"), machines, ...(githubItem && { central: { githubSettings: async () => ({ configured: true, authorized: true, actAsYou: true }), githubRepositoryItems: async () => ({ items: [githubItem], nextCursor: null }) } }) } }),
      },
      stubs: { PaneHeader: { template: '<header><slot/><slot name="actions"/></header>' }, AgentMarkdown: { props: ["text"], template: '<span>{{ text }}</span>' } },
    },
  })
  await flushPromises()
  return { router, api, machines, update: (value: SuperSnapshot) => { state = value } }
}
afterEach(() => { wrapper?.unmount(); if (pinia) disposePinia(pinia); vi.useRealTimers(); vi.restoreAllMocks() })

test.each([false, true])("selects a GitHub item for the project draft and routes its original snapshot (mobile=%s)", async ios => {
  const item: GithubRepositoryItem = { repository: "org/site", kind: "pullRequest", number: 24, state: "open", title: "Update navigation", body: "New sidebar.", url: "https://github.com/org/site/pull/24" }
  const { api } = await setup(room({ workspaceId, supportsAttachments: true }), "team", ios, createPinia(), "alice", item)
  const fleet = useFleetStore(pinia)
  const agents = useAgentSessionsStore(pinia)
  agents.draftAttachments[sessionId] = []
  expect(wrapper.find('header button[aria-label="GitHub"]').exists()).toBe(false)
  fleet.catalog = { ...catalogFixture(), workspaceGithubRepositories: [{ workspaceId, repositories: [item.repository] }] }
  await flushPromises()
  await wrapper.get('header button[aria-label="GitHub"]').trigger("click")
  await flushPromises()
  const row = new DOMWrapper(document.body).get('[draggable="true"]')
  if (!ios) {
    const transfer = new DataTransfer()
    await row.trigger("dragstart", { dataTransfer: transfer })
    await wrapper.get(".composer-shell").trigger("drop", { dataTransfer: transfer })
    expect(wrapper.get('[data-attachment-kind="github"]').text()).toContain(item.title)
  }
  await row.get("button").trigger("click")
  expect(wrapper.findAll('[data-attachment-kind="github"]')).toHaveLength(1)
  expect(agents.draftAttachments[sessionId]).toEqual([])
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(api.send).toHaveBeenCalledExactlyOnceWith({ workspaceId, text: "", messageId: expect.any(String), attachments: [
    { type: "resource", resource: { uri: item.url, mimeType: "text/markdown", text: `GitHub Pull Request org/site#24 · Update navigation\n${item.url}\n\nNew sidebar.` } },
  ] })
})

test.each([false, true])("handles simultaneous Worker permissions, plans and forms in the project (mobile=%s)", async ios => {
  const one = ticket("Check dependencies"), two = ticket("Review translations")
  const state = room({ focusTicketId: two.id, tickets: [one, two], pendingRequests: [
    { kind: "permission", ticketId: one.id, item: agentPermission() },
    { kind: "elicitation", ticketId: two.id, item: agentPlanApproval({ sessionId: "42", id: "81" }) },
    { kind: "elicitation", ticketId: one.id, item: agentElicitation() },
  ] })
  const { api, router } = await setup(state, "team", ios)
  const agents = useAgentSessionsStore(pinia)
  const decide = vi.spyOn(agents, "respond").mockResolvedValue()
  const answer = vi.spyOn(agents, "respondToElicitation").mockResolvedValue()
  const open = vi.spyOn(agents, "open")
  expect(decide).not.toHaveBeenCalled()
  expect(answer).not.toHaveBeenCalled()
  const card = wrapper.get('[data-permission-id="60"]')
  expect(card.element.closest('section[aria-label="Check dependencies"]')).not.toBeNull()
  await card.findAll("button").find(button => button.text() === "Reject")!.trigger("click")
  await flushPromises()
  expect(decide).toHaveBeenCalledExactlyOnceWith("30", "60", "deny")
  expect(wrapper.find('[data-permission-id="60"]').exists()).toBe(false)
  await wrapper.get('[data-testid="plan-approval-accept"]').trigger("click")
  await flushPromises()
  expect(answer).toHaveBeenCalledWith("42", "81", { action: "accept", content: {} })
  await wrapper.get('[data-elicitation-id="80"] [role="radio"]').trigger("click")
  await wrapper.get('[data-elicitation-id="80"] form').trigger("submit")
  await flushPromises()
  expect(answer).toHaveBeenCalledWith("30", "80", { action: "accept", content: { target: "staging" } })
  expect(api.send).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  expect(router.currentRoute.value.name).toBe("workspace-agent")
})

test("a remote decision removes the iOS approval after foregrounding without submitting on behalf of the viewer", async () => {
  const job = ticket("Review")
  const state = room({ workspaceId: null, tickets: [job], pendingRequests: [{ kind: "permission", ticketId: job.id, item: agentPermission() }] })
  const { machines, update } = await setup(state, "team", true)
  const decide = vi.spyOn(useAgentSessionsStore(pinia), "respond")
  machines.value = machines.value.map(m => ({ ...m, online: false }))
  await flushPromises()
  const options = wrapper.get('[data-permission-id="60"]').findAll("button").filter(button => ["Allow once", "Reject"].includes(button.text()))
  expect(options).toHaveLength(2)
  expect(options.every(button => button.attributes("disabled") !== undefined)).toBe(true)
  update({ ...state, pendingRequests: [] })
  machines.value = machines.value.map(m => ({ ...m, online: true }))
  dispatchAppForeground()
  await flushPromises()
  expect(wrapper.find('[data-permission-id="60"]').exists()).toBe(false)
  expect(decide).not.toHaveBeenCalled()
})

function trackVisibility() {
  const visibility = new Map<Element, (visible: boolean) => void>()
  vi.stubGlobal("IntersectionObserver", class {
    readonly notify: (entries: { isIntersecting: boolean; time: number }[]) => void
    constructor(notify: (entries: { isIntersecting: boolean; time: number }[]) => void) { this.notify = notify }
    observe(el: Element) { visibility.set(el, visible => this.notify([{ time: 1, isIntersecting: visible }])) }
    unobserve(el: Element) { visibility.delete(el) }
    disconnect() {}
  })
  onTestFinished(() => { vi.unstubAllGlobals() })
  return visibility
}

test("visible image and paste previews fetch once, while files open the original viewer on demand", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const visibility = trackVisibility()
  const state = room({ supportsAttachmentPreviews: true, messages: [message("source", { attachments: [
    { type: "resource", name: "text/plain" }, { type: "image", name: "image/png" }, { type: "resource_link", name: "notes.txt" },
  ] })] })
  const { api } = await setup(state)
  const attachments = wrapper.findAll("[data-workspace-attachment]")
  expect(attachments).toHaveLength(3)
  const content = [
    { type: "resource" as const, text: "my private paste" },
    { type: "image" as const, data: "iVBORw==", mimeType: "image/png" },
    { type: "resource_link" as const, data: btoa("saved copy"), mimeType: "text/plain" },
  ]
  let finishImage!: () => void
  api.snapshot.mockImplementation(async ({ attachment }) => {
    if (!attachment) return state
    if (attachment.index === 1) await new Promise<void>(resolve => { finishImage = resolve })
    return { ...state, attachmentPreview: { ...attachment, content: content[attachment.index]! } }
  })
  const reads = () => api.snapshot.mock.calls.flatMap(([request]) => request.attachment ? [request.attachment.index] : [])
  expect(reads()).toEqual([])
  const show = (index: number, value: boolean) => visibility.get(attachments[index]!.element)!(value)
  show(0, true); show(1, true); show(2, true)
  await flushPromises()
  expect(reads()).toEqual([0, 1])
  expect(wrapper.get("[data-pasted-resource]").text()).toContain("my private paste")
  expect(attachments[0]!.findAll("button")).toHaveLength(1)
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
  await wrapper.get('[data-super-message="source"] button[aria-label="Copy message"]').trigger("click")
  expect(copy).toHaveBeenCalledExactlyOnceWith("source\n\nmy private paste")
  show(0, false); show(1, false)
  await flushPromises()
  finishImage()
  await flushPromises()
  expect(wrapper.find('[data-preview-kind="image"]').exists()).toBe(false)
  show(0, true); show(1, true)
  await vi.advanceTimersByTimeAsync(2000)
  await flushPromises()
  expect(reads()).toEqual([0, 1])
  expect(wrapper.get('[data-preview-kind="image"]').attributes("data-preview-content")).toBe("data:image/png;base64,iVBORw==")
  await attachments[2]!.get("button").trigger("click")
  await flushPromises()
  const dialog = new DOMWrapper(document.body).get('[role="dialog"]')
  expect(dialog.text()).toContain("saved copy")
  expect(dialog.find('[data-preview-action="download"]').exists()).toBe(true)
  expect(dialog.find('[data-preview-action="reveal"]').exists()).toBe(false)
  expect(reads()).toEqual([0, 1, 2])
})

test("renders a project history GitHub attachment through the original card and keeps foreign URIs inert", async () => {
  const visibility = trackVisibility()
  const title = "GitHub Pull Request org/site#9 · Repair navigation"
  const uri = "https://github.com/org/site/pull/9"
  const state = room({ supportsAttachmentPreviews: true, messages: [message("source", { attachments: [
    { type: "resource", name: title }, { type: "resource", name: "Private note" },
  ] })] })
  const { api } = await setup(state)
  api.snapshot.mockImplementation(async ({ attachment }) => !attachment ? state : { ...state, attachmentPreview: { ...attachment,
    content: { type: "resource", text: attachment.index === 0 ? title : "Private note", uri: attachment.index === 0 ? uri : "file:///private/note", mimeType: "text/markdown" },
  } })
  const cards = wrapper.findAll("[data-workspace-attachment]")
  for (const card of cards) visibility.get(card.element)!(true)
  await flushPromises()
  expect(cards[0]!.get("a").attributes("href")).toBe(uri)
  expect(cards[0]!.get("button").text()).toContain(title)
  expect(cards[1]!.find("a").exists()).toBe(false)
})

test("older hosts display attachment labels and never request historical bytes", async () => {
  const { api } = await setup(room({ supportsAttachments: true, messages: [message("source", { attachments: [{ type: "resource_link", name: "report.pdf" }] })] }))
  expect(wrapper.get('[data-super-message="source"]').text()).toContain("report.pdf")
  expect(wrapper.find("[data-workspace-attachment] button").exists()).toBe(false)
  expect(api.snapshot.mock.calls.every(([request]) => !request.attachment)).toBe(true)
})

function scrollViewport() {
  const viewport = wrapper.get<HTMLElement>("[data-session-scroll-viewport]")
  Object.defineProperties(viewport.element, { scrollHeight: { configurable: true, value: 2200 }, clientHeight: { configurable: true, value: 400 } })
  return viewport
}

test("returning to a project restores the reader's position within their account", async () => {
  const sharedPinia = createPinia()
  const state = room({ messages: [message("earlier"), message("later")] })
  await setup(state, "team", false, sharedPinia, "alice")
  const viewport = scrollViewport()
  viewport.element.scrollTop = 470
  await viewport.trigger("scroll")
  expect(wrapper.find("[data-scroll-to-bottom]").exists()).toBe(true)
  wrapper.unmount()
  await setup(state, "team", false, sharedPinia, "bob")
  expect(wrapper.get<HTMLElement>("[data-session-scroll-viewport]").element.scrollTop).not.toBe(470)
  expect(wrapper.find("[data-scroll-to-bottom]").exists()).toBe(false)
  wrapper.unmount()
  await setup({ ...state, messages: [...state.messages, message("arrived while away")] }, "team", false, sharedPinia, "alice")
  expect(wrapper.get<HTMLElement>("[data-session-scroll-viewport]").element.scrollTop).toBe(470)
  expect(wrapper.find("[data-scroll-to-bottom]").exists()).toBe(true)
})

test("interleaved ticket replies map outline previews, reading position and jumps to their own requests", async () => {
  const sources = [message("ask-a", { text: "Question A", ticketId: "a" }), message("ask-b", { text: "Question B", ticketId: "b" })]
  const replies = ["b", "a"].map(id => message("result-" + id, { role: "worker", sourceMessageId: "ask-" + id, ticketId: id, workerEvent: "result", text: "Answer " + id }))
  await setup(room({ messages: [...sources, ...replies], tickets: [ticket("a"), ticket("b")] }))
  const outline = wrapper.getComponent(AgentOutline)
  expect(outline.props("entries")).toEqual([
    { id: "ask-a", label: "Question A", reply: "Answer a" }, { id: "ask-b", label: "Question B", reply: "Answer b" },
  ])
  const active = () => outline.find('[aria-current="location"]').attributes("aria-label")
  // A's reply arrived last, while B's reply is the row visible after scrolling back.
  expect(active()).toBe("Question A")
  const viewport = scrollViewport()
  const tops = [-700, -400, 40, 350]
  let moved = 0
  wrapper.findAll<HTMLElement>("[data-super-message]").forEach((row, i) => {
    vi.spyOn(row.element, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, tops[i]! - moved, 400, 300))
  })
  viewport.element.scrollTop = 850
  await viewport.trigger("scroll")
  expect(active()).toBe("Question B")
  moved = 320
  viewport.element.scrollTop += moved
  await viewport.trigger("scroll")
  expect(active()).toBe("Question A")
  const jump = vi.spyOn(wrapper.get<HTMLElement>('[data-super-message="ask-b"]').element, "scrollIntoView").mockImplementation(() => {})
  await outline.get('button[aria-label="Question B"]').trigger("click")
  expect(jump).toHaveBeenCalledOnce()
  expect(active()).toBe("Question B")
})

async function setupProgress(initial: SuperSnapshot) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const { update } = await setup(initial)
  return async (snapshot: SuperSnapshot) => {
    update(snapshot)
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()
  }
}

const progressFor = (userId: string) => wrapper.find(`[data-agent-progress-for="${userId}"]`)

test.each([false, true])("stops routing from the empty composer and keeps the inline stop available with a draft (mobile=%s)", async ios => {
  const initial = room({ supportsStop: true, messages: [message("request", { state: "routing", revision: 2 })] })
  const { api } = await setup(initial, "team", ios)
  const label = i18n.global.t("superAgent.stop.request")
  const selector = `button[aria-label="${label}"]`
  const composer = wrapper.get(".composer-shell")
  api.stop.mockRejectedValueOnce(new Error("connection closed"))
  await composer.get(selector).trigger("click")
  await flushPromises()
  expect(progressFor("request").text()).toContain(i18n.global.t("superAgent.progress.unconfirmed"))
  await composer.get("textarea").setValue("A separate draft")
  expect(composer.find(selector).exists()).toBe(false)
  expect(composer.find(".composer-send").exists()).toBe(true)
  api.stop.mockResolvedValueOnce(room({ supportsStop: true, messages: [message("request", { state: "stopped", revision: 2 })] }))
  await progressFor("request").get(selector).trigger("click")
  await flushPromises()
  expect(api.stop).toHaveBeenLastCalledWith({ workspaceId: "A", messageId: "request", revision: 2 })
  expect(progressFor("request").text()).toBe(i18n.global.t("superAgent.status.stopped"))
  expect(progressFor("request").find("button").exists()).toBe(false)
  expect(composer.get("textarea").element.value).toBe("A separate draft")
  expect(api.send).not.toHaveBeenCalled()
})

test.each([false, true])("the stop chooser addresses a request and an expanded split can stop one shared turn (mobile=%s)", async ios => {
  const one = ticket("Tests"), two = ticket("Docs")
  const branch = (job: SuperTicket) => message(job.id, { role: "assistant", kind: "dispatch", sourceMessageId: "split",
    ticketId: job.id, canStop: true, sharedTurn: job === two, turnId: job === two ? "shared" : undefined })
  const { api } = await setup(room({ supportsStop: true, tickets: [one, two], messages: [
    message("split", { state: "assigned" }), branch(one), branch(two), message("independent", { state: "routing" }),
  ] }), "team", ios)
  await wrapper.get(`.composer-shell button[aria-label="${i18n.global.t("superAgent.stop.choose")}"]`).trigger("click")
  await flushPromises()
  const dialog = new DOMWrapper(document.body).get('[role="dialog"]')
  expect(api.stop).not.toHaveBeenCalled()
  await dialog.findAll("button").find(item => item.text().includes("independent"))!.trigger("click")
  await flushPromises()
  expect(api.stop).toHaveBeenLastCalledWith({ workspaceId: "A", messageId: "independent", revision: 0 })
  const progress = progressFor("split")
  expect(progress.text()).toContain(i18n.global.t("superAgent.stop.groupShared", { count: 2 }))
  await progress.get("summary").trigger("click")
  await progress.findAll("details button").find(item => item.text().includes("Docs"))!.trigger("click")
  await flushPromises()
  expect(api.stop).toHaveBeenLastCalledWith({ workspaceId: "A", messageId: "split", ticketId: "Docs", revision: 0, sharedTurns: [{ ticketId: "Docs", turnId: "shared" }] })
})

test.each([false, true])("collapses seven legacy tool requests and retains their quoting actions (mobile=%s)", async ios => {
  const owner = { sessionId: "worker", ticketId: "verify" }
  const receipts = Array.from({ length: 7 }, (_, i) => message(`request-${i}`, {
    ...owner, role: "worker", workerEvent: "permission", text: `Permission requested\ncommand ${i}\nOpen the worker session to respond.`,
  }))
  const done = message("done", { ...owner, role: "worker", workerEvent: "result", sourceMessageId: "ask", turnId: "turn-1" })
  const { api } = await setup(room({ tickets: [ticket(owner.ticketId)], messages: [
    message("ask", { ...owner, turnId: "turn-1" }), ...receipts, done,
  ] }), "team", ios)
  const summary = wrapper.get("[data-approval-history] button")
  expect(summary.attributes("aria-expanded")).toBe("false")
  expect(summary.text()).toBe(i18n.global.t("superAgent.approvalsHandled", { count: 7 }, 7))
  expect(wrapper.findAll("[data-super-message]")).toHaveLength(2)
  expect(wrapper.get('[data-super-message="done"]').text()).toContain("done")
  await summary.trigger("click")
  expect(wrapper.findAll("[data-super-message]")).toHaveLength(9)
  const fifth = wrapper.get('[data-super-message="request-4"]')
  expect(fifth.text()).toContain("command 4")
  expect(fifth.text()).not.toContain("Permission requested")
  await fifth.get('button[aria-label="Quote"]').trigger("click")
  await summary.trigger("click")
  const input = wrapper.get("textarea")
  await input.setValue("Check this command again")
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ replyTo: "request-4" }))
})

test("keeps interleaved Workers and subsequent turns separate while a pending request is actionable", async () => {
  const a = { ticketId: "ticket-a", sessionId: "worker-a" }, b = { ticketId: "ticket-b", sessionId: "worker-b" }
  const receipts = [
    message("a1", { ...a, role: "worker", workerEvent: "permission", turnId: "1" }),
    message("b1", { ...b, role: "worker", workerEvent: "permission", turnId: "1" }),
    message("a2", { ...a, role: "worker", workerEvent: "permission" }),
    message("a-end", { ...a, role: "worker", workerEvent: "result", turnId: "1" }),
    message("a3", { ...a, role: "worker", workerEvent: "permission", turnId: "2" }),
    message("b-question", { ...b, role: "worker", workerEvent: "question" }),
  ]
  const state = room({ tickets: [ticket(a.ticketId), ticket(b.ticketId)], messages: receipts, pendingRequests: [
    { kind: "permission", ticketId: b.ticketId, item: agentPermission({ sessionId: b.sessionId }) },
  ] })
  const poll = await setupProgress(state)
  const summary = (id: string) => wrapper.get(`[data-approval-history="${id}"] button`)
  expect(wrapper.findAll("[data-approval-history]")).toHaveLength(3)
  expect(summary("a1").text()).toBe(i18n.global.t("superAgent.approvalsHandled", { count: 2 }, 2))
  expect(summary("a3").text()).toBe(i18n.global.t("superAgent.approvalsRecorded", { count: 1 }, 1))
  expect(wrapper.find('[data-super-message="b-question"]').exists()).toBe(true)
  expect(wrapper.find('[data-permission-id="60"] button').exists()).toBe(true)
  await summary("a1").trigger("click")
  await poll({ ...state, messages: [...receipts, message("b2", { ...b, role: "worker", workerEvent: "permission", turnId: "1" })] })
  expect(summary("a1").attributes("aria-expanded")).toBe("true")
  expect(wrapper.find('[data-super-message="a2"]').exists()).toBe(true)
  expect(wrapper.find('[data-super-message="b2"]').exists()).toBe(false)
  expect(summary("b1").text()).toBe(i18n.global.t("superAgent.approvalsRecorded", { count: 2 }, 2))
  const respond = vi.spyOn(useAgentSessionsStore(pinia), "respond").mockResolvedValue()
  await wrapper.get('[data-permission-id="60"]').findAll("button").find(button => button.text() === "Reject")!.trigger("click")
  expect(respond).toHaveBeenCalledWith(b.sessionId, "60", "deny")
})

const workerCommandCatalog = { provider: { id: "codex", name: "Codex" }, models: null, reasoningEfforts: null, modes: null,
  commands: [{ name: "status", description: "Show session status" }, { name: "review", description: "Review a change" }] }
async function typeCommand(value: string) {
  const input = wrapper.get<HTMLTextAreaElement>("textarea")
  await input.trigger("focus")
  input.element.value = value
  input.element.setSelectionRange(value.length, value.length)
  await input.trigger("input")
  await flushPromises()
  return input
}

test.each([{ workspaceId: "A", ios: false }, { workspaceId: null, ios: true }])("project and default conversation discover and send real Worker commands ($workspaceId)", async ({ workspaceId, ios }) => {
  const { api } = await setup(room({ workspaceId, supportsWorkerCommands: true, coordinatorProviders: [] }), undefined, ios)
  const discover = vi.spyOn(useAgentSessionsStore(pinia), "agentConfiguration").mockResolvedValue(workerCommandCatalog)
  expect(discover).not.toHaveBeenCalled()
  const input = await typeCommand("/")
  expect(discover).toHaveBeenCalledExactlyOnceWith({ provider: "codex", workspaceId: workspaceId ?? undefined, composer: true, cache: true, includeMatrix: false })
  expect(wrapper.get('[role="option"]').text()).toContain("/status")
  await input.trigger("keydown", { key: "ArrowDown" })
  await input.trigger("keydown", { key: "Tab" })
  expect(input.element.value).toBe("/review ")
  expect(api.send).not.toHaveBeenCalled()
  await typeCommand("/review src/lib")
  await input.trigger("keydown", { key: "Enter", altKey: true })
  await flushPromises()
  expect(api.send).toHaveBeenCalledExactlyOnceWith({ workspaceId, messageId: expect.any(String), text: "/review src/lib", command: { provider: "codex" } })
})

test("a quoted Worker's command uses its current Agent and keeps the same destination on a lost receipt", async () => {
  const own = { ...ticket("first"), sessionId: "101" }, other = { ...ticket("second"), sessionId: "102" }
  const { api } = await setup(room({ supportsWorkerCommands: true, tickets: [own, other], focusTicketId: other.id,
    messages: [message("reply", { role: "worker", ticketId: own.id })] }))
  const discover = vi.spyOn(useAgentSessionsStore(pinia), "sessionConfiguration").mockResolvedValue({
    ...workerCommandCatalog, provider: { id: "custom", name: "Custom provider" } })
  api.send.mockRejectedValueOnce(new Error("Lost receipt"))
  await wrapper.get('[data-super-message="reply"] button[aria-label="Quote"]').trigger("click")
  const input = await typeCommand("/status ")
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(discover).toHaveBeenCalledExactlyOnceWith("101", true)
  const expected = { text: "/status", replyTo: "reply", workspaceId: "A", messageId: expect.any(String), command: { provider: "custom", sessionId: "101", ticketId: "first" } }
  expect(api.send.mock.calls[0]![0]).toEqual(expected)
  expect(api.send.mock.calls[1]![0]).toEqual(api.send.mock.calls[0]![0])
})

test("a selected command never moves to a different Worker when foreground focus changes", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const first = { ...ticket("first"), sessionId: "101" }, next = { ...ticket("next"), sessionId: "102" }
  const state = room({ supportsWorkerCommands: true, focusTicketId: first.id, tickets: [first, next] })
  const { api, update } = await setup(state)
  const discover = vi.spyOn(useAgentSessionsStore(pinia), "sessionConfiguration").mockResolvedValue(workerCommandCatalog)
  const input = await typeCommand("/stat")
  await input.trigger("keydown", { key: "Tab" })
  update({ ...state, focusTicketId: next.id })
  await vi.advanceTimersByTimeAsync(2000)
  await flushPromises()
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(api.send).not.toHaveBeenCalled()
  expect(wrapper.get('[role="alert"]').text()).toContain(i18n.global.t("superAgent.commands.targetChanged"))
  expect(input.element.value).toBe("/status ")
  await typeCommand("/stat")
  await input.trigger("keydown", { key: "Tab" })
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(discover).toHaveBeenCalledWith("102", true)
  expect(api.send.mock.lastCall![0].command).toEqual({ provider: "codex", ticketId: next.id, sessionId: "102" })
})

test("unknown command-like text requires an explicit literal send, while absolute paths route normally", async () => {
  const { api } = await setup(room({ supportsWorkerCommands: true }))
  const discover = vi.spyOn(useAgentSessionsStore(pinia), "agentConfiguration").mockResolvedValue(workerCommandCatalog)
  const input = await typeCommand("/tmp")
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(api.send).not.toHaveBeenCalled()
  await wrapper.get('[role="alert"] button').trigger("click")
  await flushPromises()
  expect(api.send.mock.lastCall![0]).toEqual({ text: "/tmp", workspaceId: "A", messageId: expect.any(String) })
  await typeCommand("/Users/me/coding")
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(api.send.mock.lastCall![0]).toEqual({ text: "/Users/me/coding", workspaceId: "A", messageId: expect.any(String) })
  expect(discover).toHaveBeenCalledTimes(1)
})

test.each([{ workspaceId: "A", expected: { workspaceId: "A" } }, { workspaceId: null, expected: { sessionId: "101" } }])("project mentions retain their identity and use the available directory scope ($workspaceId)", async ({ workspaceId, expected }) => {
  vi.useFakeTimers()
  const own = { ...ticket("a"), sessionId: "101" }
  const { api } = await setup(room({ workspaceId, supportsComposerMentions: true, tickets: [own], focusTicketId: own.id }))
  const reference = { kind: "session" as const, originId: "origin", workspaceId: "A", sessionId: "202" }
  const lookup = vi.spyOn(useAgentSessionsStore(pinia), "composerReferences").mockImplementation(async params =>
    ({ truncated: false, items: params.kind === "session" ? [{ name: "Prior work", description: "Session", reference }] : [] }))
  const input = await typeCommand("  Read @")
  await vi.advanceTimersByTimeAsync(151)
  await flushPromises()
  expect(lookup).toHaveBeenCalledWith({ ...expected, kind: "session", query: "", limit: 12 })
  await input.trigger("keydown", { key: "Enter" })
  expect(wrapper.find('[data-mention-kind="session"]').exists()).toBe(true)
  expect(api.send).not.toHaveBeenCalled()
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(api.send).toHaveBeenCalledExactlyOnceWith({ workspaceId, messageId: expect.any(String), text: "Read @Prior work",
    mentions: [{ id: expect.any(String), start: 5, end: 16, token: "@Prior work", reference }] })
  expect(wrapper.find('[data-composer-mentions]').exists()).toBe(false)
})

test("the default conversation does not search files without a Worker, and a selected skill binds the execution Agent", async () => {
  const { api } = await setup(room({ workspaceId: null, supportsComposerMentions: true, supportsWorkerCommands: true, coordinatorProviders: [] }))
  const agents = useAgentSessionsStore(pinia)
  const lookup = vi.spyOn(agents, "composerReferences")
  const skill = { id: "skill:notes", name: "notes", description: "Summarize notes", invocation: "/skill:notes" }
  vi.spyOn(agents, "agentConfiguration").mockResolvedValue({ ...workerCommandCatalog, skills: [skill] })
  await typeCommand("@")
  expect(wrapper.find("[data-composer-completions]").exists()).toBe(false)
  expect(lookup).not.toHaveBeenCalled()
  const input = await typeCommand("$not")
  await wrapper.get('[data-completion-kind="skill"]').trigger("click")
  await typeCommand("$notes summarize this")
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(api.send).toHaveBeenCalledExactlyOnceWith({ workspaceId: null, messageId: expect.any(String), text: "$notes summarize this",
    command: { provider: "codex" }, mentions: [{ id: expect.any(String), start: 0, end: 6, token: "$notes", reference: {
      kind: "skill", name: "notes", id: skill.id, invocation: skill.invocation, providerId: "codex" } }] })
})

test("routing appears on the agent side until the direct answer arrives on the next poll", async () => {
  const source = message("ask", { state: "routing" })
  const poll = await setupProgress(room({ messages: [source] }))
  const routing = i18n.global.t("superAgent.state.routing")
  expect(progressFor(source.id).text()).toContain(routing)
  expect(wrapper.get('[data-super-message="ask"]').text()).not.toContain(routing)
  const answer = message("answer", { role: "assistant", sourceMessageId: source.id, text: "The project is in the coding folder." })
  await poll(room({ messages: [{ ...source, state: "answered" }, answer] }))
  expect(progressFor(source.id).exists()).toBe(false)
  expect(wrapper.get('[data-super-message="answer"]').text()).toContain(answer.text)
  expect(wrapper.text()).not.toContain(routing)
})

test("an interim agent reply carries changing execution and permission status until its Worker returns", async () => {
  const job = ticket("check")
  const source = message("ask", { state: "assigned", ticketId: job.id })
  const preview = message("preview", { role: "assistant", sourceMessageId: source.id, text: "I’ll check the source." })
  const dispatch = message("dispatch", { role: "assistant", sourceMessageId: source.id, kind: "dispatch", ticketId: job.id })
  const messages = [source, preview, dispatch]
  const poll = await setupProgress(room({ messages, tickets: [job] }))
  const interim = wrapper.get('[data-super-message="preview"]')
  expect(interim.text()).toContain(preview.text)
  const working = interim.get('[data-agent-progress-for="ask"]').text()
  expect(working).toMatch(/\S/)
  const permission = message("permission", { role: "worker", sourceMessageId: source.id, workerEvent: "permission", ticketId: job.id, text: "Allow reading the log?" })
  await poll(room({ messages: [...messages, permission], tickets: [{ ...job, status: "attention" }] }))
  expect(progressFor(source.id).text()).toMatch(/\S/)
  expect(progressFor(source.id).text()).not.toBe(working)
  await poll(room({ messages: [...messages, permission], tickets: [job] }))
  expect(progressFor(source.id).text()).toBe(working)
  const result = message("result", { role: "worker", sourceMessageId: source.id, workerEvent: "result", ticketId: job.id, text: "The check passed." })
  await poll(room({ messages: [...messages, permission, result], tickets: [{ ...job, status: undefined }] }))
  expect(progressFor(source.id).exists()).toBe(false)
  expect(interim.text()).toContain(preview.text)
  expect(wrapper.get('[data-super-message="result"]').text()).toContain(result.text)
})

test("interleaved work retires only its own progress and reusing its ticket keeps the old request complete", async () => {
  const first = message("first", { state: "assigned", ticketId: "code" })
  const second = message("second", { state: "assigned", ticketId: "docs" })
  const code = ticket("code"), docs = ticket("docs")
  const messages = [
    first, message("code-job", { role: "assistant", kind: "dispatch", sourceMessageId: first.id, ticketId: code.id }),
    second, message("docs-job", { role: "assistant", kind: "dispatch", sourceMessageId: second.id, ticketId: docs.id }),
  ]
  const poll = await setupProgress(room({ messages, tickets: [code, docs] }))
  expect(progressFor(first.id).exists()).toBe(true)
  expect(progressFor(second.id).exists()).toBe(true)
  const result = message("code-result", { role: "worker", workerEvent: "result", sourceMessageId: first.id, ticketId: code.id })
  await poll(room({ messages: [...messages, result], tickets: [{ ...code, status: undefined }, docs] }))
  expect(progressFor(first.id).exists()).toBe(false)
  expect(progressFor(second.id).exists()).toBe(true)
  const next = message("follow-up", { state: "assigned", ticketId: code.id })
  const dispatch = message("follow-up-job", { role: "assistant", kind: "dispatch", sourceMessageId: next.id, ticketId: code.id })
  await poll(room({ messages: [...messages, result, next, dispatch], tickets: [code, docs] }))
  expect(progressFor(first.id).exists()).toBe(false)
  expect(progressFor(second.id).exists()).toBe(true)
  expect(progressFor(next.id).exists()).toBe(true)
})

test("a split request keeps its progress through partial completion and removes it after both results", async () => {
  const source = message("split", { state: "assigned" })
  const first = ticket("lint"), second = ticket("test")
  const messages = [source, ...[first, second].map(job =>
    message(`dispatch-${job.id}`, { role: "assistant", kind: "dispatch", sourceMessageId: source.id, ticketId: job.id }))]
  const poll = await setupProgress(room({ messages, tickets: [first, second] }))
  expect(progressFor(source.id).exists()).toBe(true)
  const result = (job: SuperTicket) => message(`done-${job.id}`, { role: "worker", workerEvent: "result", sourceMessageId: source.id, ticketId: job.id })
  await poll(room({ messages: [...messages, result(first)], tickets: [{ ...first, status: undefined }, second] }))
  expect(progressFor(source.id).exists()).toBe(true)
  await poll(room({ messages: [...messages, result(first), result(second)], tickets: [{ ...first, status: undefined }, { ...second, status: undefined }] }))
  expect(progressFor(source.id).exists()).toBe(false)
  expect(wrapper.get('[data-super-message="done-lint"]').text()).toContain("done-lint")
  expect(wrapper.get('[data-super-message="done-test"]').text()).toContain("done-test")
})

const workerTicket = { ...ticket("task"), sessionId: "shared-worker" }
function assignedRequest(id: string, turnId?: string): SuperMessage[] {
  const owner = { ticketId: workerTicket.id, sessionId: workerTicket.sessionId }
  return [
    message(id, { ...owner, state: "assigned" }),
    message(`dispatch-${id}`, { ...owner, role: "assistant", kind: "dispatch", sourceMessageId: id, inputId: `input-${id}`, turnId }),
  ]
}
function workerReport(sourceMessageId: string, workerEvent: "permission" | "result", turnId: string) {
  return message(`${workerEvent}-${sourceMessageId}`, {
    role: "worker", workerEvent, ticketId: workerTicket.id, sessionId: workerTicket.sessionId,
    sourceMessageId, inputId: `input-${sourceMessageId}`, turnId,
  })
}

test("a known result for A never clears queued B when C joins the same Worker after the result", async () => {
  const requests = [...assignedRequest("A"), ...assignedRequest("B")]
  const poll = await setupProgress(room({ messages: requests, tickets: [workerTicket] }))
  const result = workerReport("A", "result", "turn-A")
  await poll(room({ messages: [...requests, result], tickets: [workerTicket] }))
  expect(progressFor("A").exists()).toBe(false)
  expect(progressFor("B").exists()).toBe(true)
  await poll(room({ messages: [...requests, result, ...assignedRequest("C")], tickets: [workerTicket] }))
  expect(progressFor("A").exists()).toBe(false)
  expect(progressFor("B").exists()).toBe(true)
  expect(progressFor("C").exists()).toBe(true)
})

test("a permission on A is displayed only for A when B is sent to the same Worker", async () => {
  const approval = workerReport("A", "permission", "turn-A")
  const attention: SuperTicket = { ...workerTicket, status: "attention" }
  const messages = [...assignedRequest("A"), approval]
  const poll = await setupProgress(room({ messages, tickets: [attention] }))
  await poll(room({ messages: [...messages, ...assignedRequest("B")], tickets: [attention] }))
  const status = i18n.global.t("superAgent.progress.attention")
  expect(progressFor("A").text()).toContain(status)
  expect(progressFor("B").text()).toMatch(/\S/)
  expect(progressFor("B").text()).not.toContain(status)
})

test("a single terminal turn retires its steer and stop requests while the next input is still queued", async () => {
  const messages = [...assignedRequest("start"), ...assignedRequest("steer", "turn-one"), ...assignedRequest("stop", "turn-one")]
  const stop = messages.find(message => message.id === "dispatch-stop")!
  delete stop.inputId // A successful cancel has no new Worker input.
  const poll = await setupProgress(room({ messages, tickets: [workerTicket] }))
  for (const id of ["start", "steer", "stop"]) expect(progressFor(id).exists()).toBe(true)
  const queued: SuperTicket = { ...workerTicket, status: "queued" }
  await poll(room({ messages: [...messages, ...assignedRequest("next"), workerReport("start", "result", "turn-one")], tickets: [queued] }))
  for (const id of ["start", "steer", "stop"]) expect(progressFor(id).exists()).toBe(false)
  expect(progressFor("next").exists()).toBe(true)
})

test.each([
  [false, "@worker[team/host/12] review the latest change", "workerReferenceUnsupported"],
  [true, "@worker[team/host/12]", "workerReferenceNeedsTask"],
  [true, "@worker[team/host] review the latest change", "invalidWorkerReference"],
  [true, "@worker[team/host/12] @worker[team/host/13] continue", "invalidWorkerReference"],
] as const)("keeps an unusable worker address in the draft (%s, %s)", async (supported, draft, key) => {
  const { api } = await setup(room({ supportsWorkerReferences: supported }))
  const input = wrapper.get("textarea")
  await input.setValue(draft)
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(api.send).not.toHaveBeenCalled()
  expect(input.element.value).toBe(draft)
  expect(wrapper.get('[role="alert"]').text()).toContain(i18n.global.t(`superAgent.${key}`))
})

test("sends a supported worker address and task together for host validation", async () => {
  const { api } = await setup(room({ supportsWorkerReferences: true }))
  const input = wrapper.get("textarea")
  const draft = "@worker[team/host/12] continue the tests"
  await input.setValue(draft)
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(api.send).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", messageId: expect.any(String), text: draft })
  expect(input.element.value).toBe("")
})

test("quotes the selected result in an interleaved timeline once, then sends without a ticket hint", async () => {
  const { api } = await setup(room({
    tickets: [ticket("login"), ticket("install")], focusTicketId: "install",
    messages: [message("first", { role: "worker", ticketId: "login" }), message("second", { role: "worker", ticketId: "install" })],
  }))
  await wrapper.get('[data-super-message="first"] button[aria-label="Quote"]').trigger("click")
  expect(wrapper.find('[aria-label="Remove quote"]').exists()).toBe(true)
  const input = wrapper.get("textarea")
  await input.setValue("choose option 2")
  await input.trigger("keydown", { key: "Enter", isComposing: true })
  expect(api.send).not.toHaveBeenCalled()
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(api.send).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", messageId: expect.any(String), text: "choose option 2", replyTo: "first" })
  expect(wrapper.find('[aria-label="Remove quote"]').exists()).toBe(false)
  expect(input.element.value).toBe("")
  await input.setValue("continue")
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(api.send.mock.lastCall![0]).toEqual({ workspaceId: "A", text: "continue", messageId: expect.any(String) })
})

test("routes a quoted long paste once with its original contents, including a lost receipt", async () => {
  const { api } = await setup(room({ supportsAttachments: true, messages: [message("quoted")] }))
  await wrapper.get('[data-super-message="quoted"] button[aria-label="Quote"]').trigger("click")
  const pasted = Array.from({ length: 30 }, (_, i) => `pasted line ${i}`).join("\n")
  const input = wrapper.get("textarea")
  await input.trigger("paste", { clipboardData: { files: [], getData: () => pasted } })
  expect(wrapper.find("[data-attachment-kind=pasted_text]").exists()).toBe(true)
  expect(wrapper.find("[data-composer-yolo]").exists()).toBe(false)
  api.send.mockRejectedValueOnce(new Error("Connection lost"))
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  const request = api.send.mock.calls[0]![0]
  expect(request).toMatchObject({
    workspaceId: "A", text: "", replyTo: "quoted",
    attachments: [{ type: "resource", resource: { mimeType: "text/plain", text: pasted } }],
  })
  expect(wrapper.find("[data-attachment-kind=pasted_text]").exists()).toBe(true)
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(api.send.mock.calls[1]![0]).toEqual(request)
  expect(wrapper.find("[data-composer-attachments]").exists()).toBe(false)
  expect(wrapper.find('[aria-label="Remove quote"]').exists()).toBe(false)
})

test("an image pasted without a caption is delivered as an image to the project", async () => {
  const { api } = await setup(room({ supportsAttachments: true }))
  const bytes = new Uint8Array([137, 80, 78, 71])
  const input = wrapper.get("textarea")
  let finishReading!: (bytes: ArrayBuffer) => void
  const loading = new Promise<ArrayBuffer>(resolve => { finishReading = resolve })
  await input.setValue("Review this")
  await input.trigger("paste", { clipboardData: { files: [{ name: "screenshot.png", type: "image/png", arrayBuffer: () => loading }] } })
  await input.trigger("keydown", { key: "Enter" })
  expect(api.send).not.toHaveBeenCalled()
  await input.setValue("")
  finishReading(bytes.buffer)
  await flushPromises()
  expect(wrapper.find("[data-attachment-kind=image]").exists()).toBe(true)
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(api.send).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "A", messageId: expect.any(String), text: "",
    attachments: [{ type: "image", mimeType: "image/png", data: "iVBORw==" }],
  })
})

test("an older remote host keeps attachments in the draft without submitting partial input", async () => {
  const { api } = await setup(room())
  const input = wrapper.get("textarea")
  await input.setValue("look at this")
  await input.trigger("paste", { clipboardData: { files: [], getData: () => "a".repeat(1500) } })
  expect(wrapper.get(".composer-send").attributes("disabled")).toBeDefined()
  await input.trigger("keydown", { key: "Enter" })
  expect(api.send).not.toHaveBeenCalled()
  expect(input.element.value).toBe("look at this")
  expect(wrapper.find("[data-attachment-kind=pasted_text]").exists()).toBe(true)
})

test("a lost receipt retains the draft and idempotency key when the user retries", async () => {
  const { api } = await setup(room())
  api.send.mockRejectedValueOnce(new Error("Connection lost"))
  const input = wrapper.get("textarea")
  await input.setValue("build")
  await input.trigger("keydown", { key: "Enter" }); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain("Connection lost")
  expect(input.element.value).toBe("build")
  await input.trigger("keydown", { key: "Enter" }); await flushPromises()
  expect(api.send.mock.calls[0]).toEqual(api.send.mock.calls[1])
  expect(input.element.value).toBe("")
})

test("only a handoff of this window’s current submission navigates automatically", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const initial = room({ workspaceId: null, messages: [message("old", { state: "transferred", targetWorkspaceId: "B" })] })
  const { router, api, update } = await setup(initial, "backend-team")
  expect(router.currentRoute.value.name).toBe("new-session")
  const input = wrapper.get("textarea")
  await input.setValue("change A")
  await input.trigger("keydown", { key: "Enter" }); await flushPromises()
  const id = api.send.mock.calls[0]![0].messageId
  update({ ...initial, messages: [...initial.messages, message(id, { state: "transferred", targetWorkspaceId: "A" })] })
  await vi.advanceTimersByTimeAsync(2000); await flushPromises()
  expect(router.currentRoute.value.params.workspaceId).toBe("A")
  expect(router.currentRoute.value.query.team).toBe("backend-team")
})

test("worker results open their original Session and corrections report the daemon’s outcome", async () => {
  const { api } = await setup(room({ tickets: [ticket("login"), ticket("install")], messages: [
    message("request", { ticketId: "login", state: "assigned", sourceWorkspaceId: null, context: "Chosen design" }),
    message("result", { role: "worker", sourceMessageId: "request", sessionId: "9", ticketId: "login", historySources: [{ sessionId: "90", afterSeq: "90", throughSeq: "97" }] }),
  ] }), "backend-team")
  expect(wrapper.get('[data-super-message="request"] summary').text()).toBe("From Default workspace")
  const result = wrapper.get('[data-super-message="result"]')
  const toggle = result.get("button[aria-expanded]")
  expect(toggle.attributes("aria-expanded")).toBe("false")
  expect(result.text()).not.toContain("Change ticket")
  expect(result.text()).not.toContain("Open Session")
  await toggle.trigger("click")
  expect(result.findAll("a").filter(link => link.text() === "Open Session")).toHaveLength(1)
  expect(result.get('a[href="/sessions/9?superFrom=A&superMachine=local-daemon&team=backend-team"]').text()).toBe("Open Session")
  expect(result.get('a[href="/sessions/90?superFrom=A&superMachine=local-daemon&team=backend-team"]').text()).toContain("after event 90, through 97")
  await result.findAll("button").find(x => x.text() === "Change ticket")!.trigger("click")
  await result.get("select").setValue("install")
  api.correct.mockRejectedValueOnce(new Error("Already delivered; inspect Session"))
  await result.get("form").trigger("submit"); await flushPromises()
  expect(api.correct).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", messageId: "request", ticketId: "install" })
  expect(wrapper.get('[role="alert"]').text()).toContain("Already delivered")
  expect(result.text()).toContain("login")
  await toggle.trigger("click")
  expect(result.find("form").exists()).toBe(false)
  await toggle.trigger("click")
  expect(result.find("form").exists()).toBe(false)
})

test("an unassigned message can still be reassigned from its collapsed details", async () => {
  const { api } = await setup(room({ tickets: [ticket("owner")], messages: [message("ask", { state: "answered" })] }))
  const row = wrapper.get('[data-super-message="ask"]')
  expect(row.text()).not.toContain("Change ticket")
  await row.get("button[aria-expanded]").trigger("click")
  await row.findAll("button").find(button => button.text() === "Change ticket")!.trigger("click")
  await row.get("select").setValue("owner")
  await row.get("form").trigger("submit")
  expect(api.correct).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", messageId: "ask", ticketId: "owner" })
})

test.each([false, true])("only the latest idle Worker answer links to its native fork dialog (iOS %s)", async ios => {
  const result = (id: string, sessionId: string, turnId: string) =>
    message(id, { role: "worker", workerEvent: "result", sessionId, ticketId: sessionId, turnId })
  const { router } = await setup(room({
    tickets: [{ ...ticket("9"), sessionId: "9", status: undefined }, ticket("busy"), { ...ticket("other"), status: undefined }],
    messages: [message("ask"), result("old", "9", "turn-1"), result("ready", "9", "turn-2"),
      message("coordinator", { role: "assistant", sourceMessageId: "ask", ticketId: "9", sessionId: "9" }),
      result("running", "busy", "turn-3"), result("other-result", "other", "turn-4"),
      message("other-error", { role: "worker", workerEvent: "error", sessionId: "other", turnId: "turn-5" })],
  }), "backend-team", ios)
  const buttons = wrapper.findAll(`button[aria-label="${i18n.global.t("agent.fork")}"]`)
  expect(buttons).toHaveLength(1)
  expect(buttons[0]!.element.closest<HTMLElement>("[data-super-message]")?.dataset.superMessage).toBe("ready")
  await buttons[0]!.trigger("click")
  await flushPromises()
  expect(router.currentRoute.value).toMatchObject({ name: "session", params: { sessionId: "9" },
    query: { superFrom: "A", superMachine: "local-daemon", team: "backend-team", forkTurn: "turn-2" } })
})

test("retries routing with the exact failed message only when the host exposes that capability", async () => {
  const { api } = await setup(room({ messages: [
    message("first"), message("failed", { text: "answer", state: "failed", retryable: true, replyTo: "first" }),
    message("uncertain", { state: "uncertain" }),
  ] }))
  const failed = wrapper.get('[data-super-message="failed"]')
  await failed.findAll("button").find(button => button.text() === i18n.global.t("errors.retry"))!.trigger("click")
  expect(api.send).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", messageId: "failed", text: "answer", replyTo: "first", retry: true })
  expect(wrapper.get('[data-super-message="uncertain"]').text()).not.toContain(i18n.global.t("errors.retry"))
})

test("a delayed receipt clears only the acknowledged draft and a background result does not navigate", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const initial = room({ messages: [message("source")] })
  const { api, update, router } = await setup(initial)
  let acknowledge!: (snapshot: SuperSnapshot) => void
  api.send.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve }))
  const input = wrapper.get("textarea")
  await input.setValue("original")
  await input.trigger("keydown", { key: "Enter" })
  await input.setValue("next question")
  const sent = api.send.mock.calls[0]![0]
  acknowledge({ ...initial, messages: [...initial.messages, message(sent.messageId, { text: sent.text })] })
  await flushPromises()
  expect(input.element.value).toBe("next question")
  update({ ...initial, messages: [...initial.messages, message("another-window", { state: "transferred", targetWorkspaceId: "B" })] })
  await vi.advanceTimersByTimeAsync(2000); await flushPromises()
  expect(router.currentRoute.value.params.workspaceId).toBe("A")
  expect(input.element.value).toBe("next question")
})

test("the header opens ticket details outside the scrolling conversation and toggles them closed", async () => {
  await setup(room({
    tickets: [
      { ...ticket("fix"), title: "Repair export", status: undefined, scope: "Only the Markdown exporter", summary: "Regression test passed", sessionId: "4" },
      ticket("docs"),
    ],
    messages: [message("latest")],
  }))
  const trigger = wrapper.get("header button")
  expect(trigger.attributes("aria-expanded")).toBe("false")
  await trigger.trigger("click")
  await flushPromises()
  expect(trigger.attributes("aria-expanded")).toBe("true")
  const panel = new DOMWrapper(document.getElementById(trigger.attributes("aria-controls")!)!)
  expect(panel.attributes("role")).toBe("dialog")
  expect(wrapper.get('[data-super-message="latest"]').element.closest("[data-session-scroll-viewport]")!.contains(panel.element)).toBe(false)
  expect(panel.findAll("summary")).toHaveLength(2)
  const item = panel.get("details")
  expect(item.get("summary").text()).toBe("Repair export")
  expect(panel.findAll("summary")[1]!.text()).toContain(i18n.global.t("superAgent.status.working"))
  expect(item.text()).toContain("Only the Markdown exporter")
  expect(item.text()).toContain("Regression test passed")
  expect(item.get("a").attributes("href")).toBe("/sessions/4?superFrom=A&superMachine=local-daemon")
  await trigger.trigger("click")
  await flushPromises()
  expect(trigger.attributes("aria-expanded")).toBe("false")
  expect(panel.element.isConnected).toBe(false)
})

test.each([false, true])("archives from ticket details and restores from an empty active list (mobile=%s)", async mobile => {
  const job = { ...ticket("Inspect export"), sessionId: "4", workerContext: "worktree" as const }
  const { api } = await setup(room({ supportsTicketArchive: true, tickets: [job], messages: [message("Original request", { ticketId: job.id })] }), "team", mobile)
  const doc = new DOMWrapper(document.body)
  const header = wrapper.get("header button")
  const openList = async () => {
    await header.trigger("click")
    await flushPromises()
    return new DOMWrapper(document.getElementById(header.attributes("aria-controls")!)!)
  }
  const choose = async (item: Pick<DOMWrapper<Element>, "get">) => {
    await item.get("summary").trigger("click")
    await item.get("button").trigger("click")
    await flushPromises()
    return doc.get('[role="dialog"]')
  }
  expect(header.text()).toBe(i18n.global.t("superAgent.tickets", { count: 1 }))
  let dialog = await choose((await openList()).get("details"))
  expect(dialog.text()).toContain(i18n.global.t("agent.archiveWorktreeQuestion"))
  await dialog.get("[data-confirm-cancel]").trigger("click")
  await flushPromises()
  expect(api.archiveTicket).not.toHaveBeenCalled()
  dialog = await choose((await openList()).get("details"))
  await dialog.findAll("button").at(-1)!.trigger("click")
  await flushPromises()
  expect(api.archiveTicket).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", ticketId: job.id, sessionId: "4", archived: true, operationId: expect.any(String) })
  expect(header.text()).toBe(i18n.global.t("superAgent.tickets", { count: 0 }))
  expect(wrapper.get('[data-super-message="Original request"]').text()).toContain("Original request")
  const group = (await openList()).get("details")
  expect(group.attributes("open")).toBeUndefined()
  expect(group.get("summary").text()).toBe(i18n.global.t("superAgent.archivedTickets", { count: 1 }))
  await group.get("summary").trigger("click")
  dialog = await choose(group.get("details"))
  expect(dialog.text()).toContain(i18n.global.t("agent.restoreWorktreeQuestion"))
  await dialog.findAll("button").at(-1)!.trigger("click")
  await flushPromises()
  expect(api.archiveTicket).toHaveBeenLastCalledWith({ workspaceId: "A", ticketId: job.id, sessionId: "4", archived: false, operationId: expect.any(String) })
  expect(header.text()).toBe(i18n.global.t("superAgent.tickets", { count: 1 }))
  expect(api.send).not.toHaveBeenCalled()
})

test.each([false, true])("archives the chosen collapsed ticket from its own button (mobile=%s)", async mobile => {
  const first = ticket("First task")
  const second = { ...ticket("Second task with a long title"), sessionId: "7", workerContext: "directory" as const }
  const { api } = await setup(room({ supportsTicketArchive: true, tickets: [first, second] }), "team", mobile)
  const header = wrapper.get("header button")
  const openList = async () => {
    await header.trigger("click")
    await flushPromises()
    return new DOMWrapper(document.getElementById(header.attributes("aria-controls")!)!)
  }
  const panel = await openList()
  const buttons = panel.findAll("button[aria-label]")
  const label = i18n.global.t("superAgent.archiveTicket")
  expect(buttons.map(button => button.attributes("aria-label"))).toEqual([`${label} · ${first.title}`, `${label} · ${second.title}`])
  const disclosure = panel.findAll("details")[1]!.element
  expect(disclosure.open).toBe(false)
  expect(buttons[1]!.element.closest("details")).toBeNull()
  await buttons[1]!.trigger("click")
  await flushPromises()
  expect(disclosure.open).toBe(false)
  const dialog = new DOMWrapper(document.body).get('[role="dialog"]')
  expect(dialog.text()).toContain(second.title)
  expect(api.archiveTicket).not.toHaveBeenCalled()
  await dialog.findAll("button").at(-1)!.trigger("click")
  await flushPromises()
  expect(api.archiveTicket).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", ticketId: second.id, sessionId: "7", archived: true, operationId: expect.any(String) })
  expect((await openList()).findAll("button[aria-label]").map(button => button.attributes("aria-label"))).toEqual([`${label} · ${first.title}`])
})

test("a result from an older machine has no review badge and its Worker details still open", async () => {
  const job = { ...ticket("repair"), sessionId: "4" }
  Reflect.set(job, "status", "review") // Old daemon wire value.
  const result = message("result", { role: "worker", workerEvent: "result", ticketId: job.id })
  await setup(room({ tickets: [job], messages: [result] }))
  const row = wrapper.get('[data-super-message="result"]')
  await row.get('button[aria-expanded]').trigger("click")
  expect(row.text()).toContain("codex")
  expect(row.text()).not.toMatch(/review|·/i)
  expect(row.get("a").attributes("href")).toContain("/sessions/4")
  const trigger = wrapper.get("header button")
  await trigger.trigger("click")
  await flushPromises()
  const panel = new DOMWrapper(document.getElementById(trigger.attributes("aria-controls")!)!)
  expect(panel.get("summary").text()).toBe("repair")
  expect(panel.find("button[aria-label]").exists()).toBe(false)
})

async function projectRow(id: string) {
  await flushPromises()
  return new DOMWrapper(document.body).get('[data-project-model-row="' + id + '"]')
}
async function selectProjectOption(row: string, option: string) {
  await (await projectRow(row)).trigger("click")
  await flushPromises()
  await new DOMWrapper(document.body).get('[data-project-model-choice="' + option + '"]').trigger("click")
  await flushPromises()
}
const capabilities = { models: [{ id: "first", name: "First", reasoningEfforts: ["low", "high"] }, { id: "second", name: "Second", reasoningEfforts: ["low"] }], defaultModel: "first", defaultReasoningEfforts: ["low", "high"] }

test.each([false, true])("project execution model can be selected in the Antigravity table (touch=%s)", async touch => {
  const provider = { id: "custom-agy", name: "My Antigravity", template: "antigravity" as const }
  const { api } = await setup(room({ provider: provider.id, workerProviders: [provider], workerSelection: {} }), undefined, touch)
  useProvidersStore(pinia).providers = [provider]
  vi.spyOn(useAgentSessionsStore(pinia), "agentConfiguration").mockResolvedValue({
    provider, modes: null, reasoningEfforts: null,
    models: { id: "model", currentValue: "gemini-4-carbon", options: [
      { id: "gemini-4-carbon", name: "Gemini 4 Carbon" }, { id: "gemini-4-neon", name: "Gemini 4 Neon" },
    ] },
  })
  await wrapper.get("[data-project-model-trigger]").trigger("click")
  if (!touch) await (await projectRow("executor-model")).trigger("click")
  await flushPromises()
  const body = new DOMWrapper(document.body)
  await body.get("[data-project-periodic-table]").trigger("click")
  await flushPromises()
  await body.get('[data-periodic-element="Ne"]').trigger("click")
  await flushPromises()
  expect(api.settings.mock.lastCall?.[0]).toEqual({ workspaceId: "A", workerSelection: { provider: provider.id, model: "gemini-4-neon" } })
})

test("iOS presents both roles in a single touch sheet and confirms native selections with the project", async () => {
  const codex = { id: "codex", name: "Codex" }
  const other = { id: "execution-only", name: "Other Agent" }
  const { api } = await setup(room({ coordinator: codex.id, coordinatorOptions: capabilities, coordinatorOverrides: {},
    coordinatorSelection: { model: "first" }, coordinatorProviders: [codex], workerProviders: [codex, other], workerSelection: {},
  }), undefined, true)
  const read = vi.spyOn(useAgentSessionsStore(pinia), "agentConfiguration").mockResolvedValue({
    provider: codex, models: { id: "model", currentValue: "executor", options: [{ id: "executor", name: "Worker model" }] },
    reasoningEfforts: { id: "effort", currentValue: "high", options: [{ id: "high", name: "High" }] }, modes: null,
  })
  const trigger = wrapper.get("[data-project-model-trigger]")
  expect(trigger.attributes("aria-haspopup")).toBe("dialog")
  await trigger.trigger("click"); await flushPromises()
  const panel = new DOMWrapper(document.body).get(".bottom-sheet")
  expect(panel.findAll("select").map(input => input.attributes("data-project-model-row"))).toEqual([
    "coordinator-provider", "coordinator-model", "coordinator-effort", "executor-provider", "executor-model", "executor-effort",
  ])
  expect(panel.get('[data-project-model-row="coordinator-provider"] option[value="execution-only"]').attributes("disabled")).toBeDefined()
  const front = panel.get<HTMLSelectElement>('[data-project-model-row="coordinator-model"]')
  await front.setValue("second"); await flushPromises()
  expect(api.settings.mock.lastCall?.[0]).toEqual({ workspaceId: "A", coordinatorSelection: { provider: "codex", model: "second" } })
  expect(front.element.value).toBe("second")
  await front.setValue(""); await flushPromises()
  expect(front.element.value).toBe("")
  const worker = panel.get<HTMLSelectElement>('[data-project-model-row="executor-model"]')
  await worker.setValue("executor"); await flushPromises()
  expect(api.settings.mock.lastCall?.[0]).toEqual({ workspaceId: "A", workerSelection: { provider: "codex", model: "executor" } })
  const effort = panel.get<HTMLSelectElement>('[data-project-model-row="executor-effort"]')
  api.settings.mockRejectedValueOnce(new Error("Cannot save on this machine"))
  await effort.setValue("high"); await flushPromises()
  expect(effort.element.value).toBe("")
  expect(panel.get('[role="alert"]').text()).toContain("Cannot save on this machine")
  expect(read).toHaveBeenCalledTimes(2)
  expect(api.send).not.toHaveBeenCalled()
})

test("an open iOS workspace keeps its draft and pauses reads and writes until its own machine reconnects", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const { api, machines } = await setup(room(), "team", true)
  const input = wrapper.get("textarea")
  await input.setValue("work on this later")
  machines.value.push({ id: "another-mac", name: "Other Mac", teamId: "team", online: false })
  await flushPromises()
  const send = wrapper.get(".composer-send")
  expect(send.attributes("disabled")).toBeUndefined()
  machines.value[0]!.online = false
  await flushPromises()
  expect(wrapper.text()).toContain(i18n.global.t("desktop.offline", { machine: "Studio Mac" }))
  expect(send.attributes("disabled")).toBeDefined()
  await input.setValue("my new draft")
  await input.trigger("keydown", { key: "Enter" })
  const reads = api.snapshot.mock.calls.length
  dispatchAppForeground()
  await vi.advanceTimersByTimeAsync(6000); await flushPromises()
  expect(api.snapshot).toHaveBeenCalledTimes(reads)
  expect(api.send).not.toHaveBeenCalled()
  machines.value[0]!.online = true
  await flushPromises()
  expect(api.snapshot).toHaveBeenCalledTimes(reads + 1)
  expect(input.element.value).toBe("my new draft")
  expect(send.attributes("disabled")).toBeUndefined()
  expect(api.send).not.toHaveBeenCalled()
  await send.trigger("click"); await flushPromises()
  expect(api.send).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", messageId: expect.any(String), text: "my new draft" })
})

test("native resume and network recovery reconcile a project without repeating a lost submission", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const initial = room({ workspaceId: null })
  const { router, api, update } = await setup(initial, "team", true)
  const input = wrapper.get("textarea")
  api.send.mockRejectedValueOnce(new Error("Connection lost"))
  await input.setValue("fix project A"); await input.trigger("keydown", { key: "Enter" }); await flushPromises()
  const id = api.send.mock.calls[0]![0].messageId
  expect(input.element.value).toBe("fix project A")
  update({ ...initial, messages: [message("from-mac", { text: "Sent from the Mac" })] })
  window.dispatchEvent(new Event("online")); await flushPromises()
  expect(wrapper.text()).toContain("Sent from the Mac")
  expect(input.element.value).toBe("fix project A")
  update({ ...initial, messages: [message(id, { text: "fix project A", state: "transferred", targetWorkspaceId: "A" })] })
  dispatchAppForeground(); await flushPromises()
  expect(api.send).toHaveBeenCalledTimes(1)
  expect(input.element.value).toBe("")
  expect(router.currentRoute.value.params.workspaceId).toBe("A")
})

test.each([false, true])("sets native mode and tool approval independently for new Workers in the project (mobile=%s)", async ios => {
  const provider = { id: "registered-instance", name: "Execution Agent" }
  const { api } = await setup(room({ provider: provider.id, workerProviders: [provider], workerSelection: {}, workerAutoApprove: false }), "team", ios)
  const agents = useAgentSessionsStore(pinia)
  const openWorker = vi.spyOn(agents, "open")
  const lookup = vi.spyOn(agents, "agentConfiguration").mockResolvedValue({ provider, models: null, reasoningEfforts: null,
    modes: { id: "mode", currentValue: "read", options: [{ id: "read", name: "Read-only" }, { id: "approval-review", name: "Review tool requests" }] } })
  const trigger = wrapper.get("[data-project-model-trigger]")
  const body = new DOMWrapper(document.body)
  async function choose(row: string, value: string) {
    if (ios) await body.get(`select[data-project-model-row="executor-${row}"]`).setValue(value)
    else await selectProjectOption("executor-" + row, value || "default")
    await flushPromises()
  }
  async function menu() { await trigger.trigger("click"); await flushPromises() }
  await menu()
  await choose("mode", "approval-review")
  expect(api.settings.mock.lastCall?.[0]).toEqual({ workspaceId: "A", workerMode: { provider: provider.id, mode: "approval-review" } })
  expect(lookup).toHaveBeenLastCalledWith({ provider: provider.id, workspaceId: "A", mode: "approval-review", cache: true, includeMatrix: false })
  await choose("approval", "auto")
  expect(api.settings).toHaveBeenCalledTimes(1)
  await body.get('[data-confirm-cancel]').trigger("click")
  await flushPromises()
  expect(api.settings).toHaveBeenCalledTimes(1)
  await menu()
  await choose("approval", "auto")
  const dialog = body.findAll('[role="dialog"]').find(item => item.find("[data-confirm-cancel]").exists())!
  await dialog.findAll("button").find(b => b.text() === i18n.global.t("superAgent.autoApproval"))!.trigger("click")
  await flushPromises()
  expect(api.settings.mock.lastCall?.[0]).toEqual({ workspaceId: "A", workerAutoApprove: true })
  await menu()
  await choose("approval", "manual")
  expect(api.settings.mock.lastCall?.[0]).toEqual({ workspaceId: "A", workerAutoApprove: false })
  await choose("mode", "")
  expect(api.settings.mock.lastCall?.[0]).toEqual({ workspaceId: "A", workerMode: { provider: provider.id, mode: null } })
  expect(api.send).not.toHaveBeenCalled()
  expect(openWorker).not.toHaveBeenCalled()
})

test("six project rows edit the foreground provider and executor independently, including restoring defaults", async () => {
  const { api } = await setup(room({
    coordinator: "codex", coordinatorSelection: { model: "first", reasoningEffort: "low" },
    coordinatorOverrides: {}, coordinatorOptions: capabilities, coordinatorUsage: { used: 300, size: 1000 },
    workerProviders: [{ id: "codex", name: "Codex" }], workerSelection: {},
    tickets: [{ ...ticket("visible"), sessionId: "99" }], focusTicketId: "visible",
  }))
  const agents = useAgentSessionsStore(pinia)
  const inspectSession = vi.spyOn(agents, "open")
  const configuration = vi.spyOn(agents, "agentConfiguration").mockResolvedValue({
    provider: { id: "codex", name: "Codex" }, modes: null,
    models: { id: "model", currentValue: "worker-model", options: [{ id: "worker-model", name: "Worker" }] },
    reasoningEfforts: { id: "effort", currentValue: "low", options: [{ id: "high", name: "High" }] },
  })
  expect(wrapper.find("[data-composer-yolo]").exists()).toBe(false)
  expect(wrapper.find("[data-composer-ticket]").exists()).toBe(false)
  expect(wrapper.get("[data-coordinator-usage]").text()).toContain("30%")
  await wrapper.get("[data-project-model-trigger]").trigger("click")
  await flushPromises()
  expect(new DOMWrapper(document.body).findAll("[data-project-model-row]").map(row => row.attributes("data-project-model-row"))).toEqual([
    "coordinator-provider", "coordinator-model", "coordinator-effort", "executor-provider", "executor-model", "executor-effort",
  ])
  await selectProjectOption("coordinator-model", "second")
  await selectProjectOption("coordinator-effort", "low")
  expect(api.settings.mock.lastCall![0]).toEqual({ workspaceId: "A", coordinatorSelection: { provider: "codex", model: "second", reasoningEffort: "low" } })
  await selectProjectOption("coordinator-model", "default")
  expect(api.settings.mock.lastCall![0]).toEqual({ workspaceId: "A", coordinatorSelection: { provider: "codex", reasoningEffort: "low" } })
  expect(configuration).toHaveBeenCalledExactlyOnceWith({ provider: "codex", workspaceId: "A", cache: true, includeMatrix: false })
  await selectProjectOption("executor-effort", "high")
  expect(api.settings.mock.lastCall![0]).toEqual({ workspaceId: "A", workerSelection: { provider: "codex", reasoningEffort: "high" } })
  await selectProjectOption("executor-model", "worker-model")
  expect(api.settings.mock.lastCall![0]).toEqual({ workspaceId: "A", workerSelection: { provider: "codex", model: "worker-model", reasoningEffort: "high" } })
  await selectProjectOption("executor-effort", "default")
  expect(api.settings.mock.lastCall![0]).toEqual({ workspaceId: "A", workerSelection: { provider: "codex", model: "worker-model" } })
  expect(configuration).toHaveBeenCalledTimes(2)
  expect(inspectSession).not.toHaveBeenCalled()
  expect(api.send).not.toHaveBeenCalled()
})
test.each(["A", null])("the project menu preloads and shares one executor read across rows and reopens in %s", async workspaceId => {
  await setup(room({ workspaceId, workerProviders: [{ id: "codex", name: "Codex" }], workerSelection: {} }))
  const result = { provider: { id: "codex", name: "Codex" }, modes: null,
    models: { id: "model", currentValue: "first", options: [{ id: "first", name: "First" }] },
    reasoningEfforts: { id: "effort", currentValue: "high", options: [{ id: "high", name: "High" }] } }
  let finish!: (value: typeof result) => void
  const request = vi.spyOn(useAgentSessionsStore(pinia), "agentConfiguration").mockReturnValue(new Promise(resolve => { finish = resolve }))
  const trigger = wrapper.get("[data-project-model-trigger]")
  const body = new DOMWrapper(document.body)
  await trigger.trigger("click")
  await flushPromises()
  expect(request).toHaveBeenCalledExactlyOnceWith({ provider: "codex", workspaceId: workspaceId ?? undefined, cache: true, includeMatrix: false })
  await (await projectRow("executor-model")).trigger("click")
  await flushPromises()
  expect(body.text()).toContain(i18n.global.t("composer.loadingConfiguration"))
  await trigger.trigger("click")
  await flushPromises()
  await trigger.trigger("click")
  await (await projectRow("executor-effort")).trigger("click")
  finish(result)
  await flushPromises()
  expect(body.find('[data-project-model-choice="high"]').exists()).toBe(true)
  await (await projectRow("executor-model")).trigger("click")
  await flushPromises()
  expect(body.find('[data-project-model-choice="first"]').exists()).toBe(true)
  expect(request).toHaveBeenCalledTimes(1)
  const registration = useProvidersStore(pinia)
  registration.revision = "initial"
  await flushPromises()
  expect(request).toHaveBeenCalledTimes(1)
  request.mockResolvedValueOnce({ ...result, models: { id: "model", currentValue: "second", options: [{ id: "second", name: "Second" }] } })
  registration.revision = "edited"
  await flushPromises()
  expect(request).toHaveBeenCalledTimes(2)
  expect(body.find('[data-project-model-choice="first"]').exists()).toBe(false)
  expect(body.find('[data-project-model-choice="second"]').exists()).toBe(true)
})
test("a late response cannot replace the newly selected executor, and its failed read can be retried", async () => {
  const codex = { id: "codex", name: "Codex" }, other = { id: "other", name: "Other" }
  await setup(room({ workerProviders: [codex, other], workerSelection: {} }))
  const result = (id: string) => ({ provider: { id, name: id }, modes: null, reasoningEfforts: null,
    models: { id: "model", currentValue: id, options: [{ id, name: id }] } })
  let finish!: () => void
  const request = vi.spyOn(useAgentSessionsStore(pinia), "agentConfiguration")
    .mockReturnValueOnce(new Promise(resolve => { finish = () => resolve(result(codex.id)) }))
    .mockRejectedValueOnce(new Error("temporarily unavailable")).mockResolvedValue(result(other.id))
  const body = new DOMWrapper(document.body)
  await wrapper.get("[data-project-model-trigger]").trigger("click")
  await selectProjectOption("executor-provider", other.id)
  await (await projectRow("executor-model")).trigger("click")
  finish()
  await flushPromises()
  expect(body.get('[role="alert"]').text()).toBe("temporarily unavailable")
  expect(body.find('[data-project-model-choice="codex"]').exists()).toBe(false)
  await body.findAll("button").find(item => item.text() === i18n.global.t("composer.reloadConfiguration"))!.trigger("click")
  await flushPromises()
  expect(body.find('[role="alert"]').exists()).toBe(false)
  expect(body.find('[data-project-model-choice="other"]').exists()).toBe(true)
  expect(request.mock.calls.map(([params]) => params.provider)).toEqual([codex.id, other.id, other.id])
})
test("switches providers independently and older machines keep unsupported overrides read-only", async () => {
  const { api } = await setup(room({ provider: "worker-1", coordinator: "codex", coordinatorSelection: { model: "legacy" },
    workerProviders: [{ id: "codex", name: "Codex" }, { id: "claude-code", name: "Claude" }, { id: "worker-1", name: "One" }, { id: "worker-2", name: "Two" }],
    messages: [message("failed", { state: "failed", retryable: true })] }))
  expect(wrapper.get("[data-coordinator-usage]").text()).toBe("—")
  await wrapper.get('[data-super-message="failed"]').findAll("button").find(b => b.text() === "Change coordinator, then retry")!.trigger("click")
  expect((await projectRow("coordinator-model")).text()).toContain("legacy")
  expect((await projectRow("coordinator-model")).attributes("data-disabled")).toBeDefined()
  await (await projectRow("coordinator-provider")).trigger("click")
  await flushPromises()
  const choices = new DOMWrapper(document.body)
  expect(choices.get('[data-project-model-choice="worker-2"]').attributes("data-disabled")).toBeDefined()
  expect(choices.get('[data-project-model-choice="worker-2"]').text()).toContain(i18n.global.t("superAgent.hostUpdateRequired"))
  expect(choices.text()).toContain(i18n.global.t("superAgent.updateHostForProviders"))
  await choices.get('[data-project-model-choice="claude-code"]').trigger("click")
  await flushPromises()
  expect(api.settings).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", coordinator: "claude-code" })
  await selectProjectOption("executor-provider", "worker-2")
  expect(api.settings.mock.lastCall![0]).toEqual({ workspaceId: "A", provider: "worker-2" })
  expect(api.send).not.toHaveBeenCalled()
})

test.each(["A", null])("both provider menus track this machine’s registered instances in workspace %s", async workspaceId => {
  const codex = { id: "instance-1", name: "Local Codex" }
  const dsh = { id: "instance-2", name: "DeepSeek Harness" }
  const other = { id: "instance-3", name: "Custom worker" }
  const state = room({ workspaceId, workerProviders: [codex, other], coordinatorProviders: [codex],
    coordinator: codex.id, coordinatorOptions: capabilities, provider: codex.id })
  const { api, update } = await setup(state)
  await wrapper.get("[data-project-model-trigger]").trigger("click")
  await (await projectRow("coordinator-provider")).trigger("click")
  await flushPromises()
  const body = new DOMWrapper(document.body)
  const choices = () => body.findAll("[data-project-model-choice]").map(item => item.attributes("data-project-model-choice"))
  expect(choices()).toEqual([codex.id, other.id])
  expect(body.get('[data-project-model-choice="instance-3"]').text()).toContain("Execution only")
  expect(body.get('[data-project-model-choice="instance-3"]').attributes("data-disabled")).toBeDefined()
  expect(wrapper.get("[data-project-model-trigger]").text()).toContain(codex.name)

  update({ ...state, coordinatorProviders: [codex, dsh], workerProviders: [codex, dsh, other] })
  const registration = useProvidersStore(pinia)
  registration.providers = [{ ...dsh, template: "deepseek-harness" }]
  await flushPromises()
  expect(choices()).toEqual([codex.id, dsh.id, other.id])
  await body.get('[data-project-model-choice="instance-2"]').trigger("click")
  await flushPromises()
  expect(api.settings).toHaveBeenCalledExactlyOnceWith({ workspaceId, coordinator: dsh.id })
  expect((await projectRow("coordinator-provider")).text()).toContain(dsh.name)
  expect((await projectRow("executor-provider")).text()).toContain(codex.name)

  await (await projectRow("executor-provider")).trigger("click")
  await flushPromises()
  expect(choices()).toEqual([codex.id, dsh.id, other.id])
  expect(body.get('[data-project-model-choice="instance-3"]').attributes("data-disabled")).toBeUndefined()
  update({ ...state, coordinator: undefined, coordinatorSelection: undefined })
  registration.providers = []
  await flushPromises()
  expect(choices()).toEqual([codex.id, other.id])
  expect((await projectRow("coordinator-provider")).text()).toContain("Not selected")
  expect((await projectRow("coordinator-model")).attributes("data-disabled")).toBeDefined()
  const input = wrapper.get("textarea")
  await input.setValue("Review the README")
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(api.send).not.toHaveBeenCalled()
  expect(input.element.value).toBe("Review the README")
  expect(wrapper.get('[role="alert"]').text()).toContain(i18n.global.t("superAgent.chooseCoordinatorBeforeSending"))
})

test("an empty coordinator catalog guides setup and still accepts a direct Worker address", async () => {
  const { api } = await setup(room({ coordinatorProviders: [], workerProviders: [], provider: "", supportsWorkerReferences: true }))
  await wrapper.get("[data-project-model-trigger]").trigger("click")
  await (await projectRow("coordinator-provider")).trigger("click")
  await flushPromises()
  const body = new DOMWrapper(document.body)
  expect(body.find("[data-project-model-choice]").exists()).toBe(false)
  expect(body.findAll('[role="menuitem"]').some(item => item.text() === i18n.global.t("providers.manage"))).toBe(true)
  const input = wrapper.get("textarea")
  await input.setValue("Explain the README")
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(api.send).not.toHaveBeenCalled()
  expect(wrapper.get('[role="alert"]').text()).toContain(i18n.global.t("superAgent.addCoordinatorBeforeSending"))
  await input.setValue("@worker[team-a/host/42] continue")
  await input.trigger("keydown", { key: "Enter" })
  await flushPromises()
  expect(api.send).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", messageId: expect.any(String), text: "@worker[team-a/host/42] continue" })
})

test("old dispatch records become one execution status while the Super Agent reply keeps its own copy and quote", async () => {
  const reason = "No configured worker provider is available for this ticket."
  const answer = "Initial assessment in **Markdown**."
  const { api } = await setup(room({ tickets: [{ ...ticket("translate"), provider: "", status: "blocked", summary: reason }], messages: [
    message("source", { ticketId: "translate", state: "failed", reason, retryable: true }),
    message("answer", { role: "assistant", text: answer, sourceMessageId: "source" }),
    message("route", { role: "assistant", ticketId: "translate", text: "translate", reason: "Hand off for verification", sourceMessageId: "source" }),
    message("delivery", { role: "worker", ticketId: "translate", text: reason, sourceMessageId: "source" }),
    message("journal-error", { role: "worker", workerEvent: "error", ticketId: "translate", text: reason, sourceMessageId: "source" }),
  ] }))
  expect(wrapper.findAll("[data-super-message]").map(row => row.attributes("data-super-message"))).toEqual(["source", "answer"])
  expect(wrapper.findAll('[aria-label="Quote"]')).toHaveLength(2)
  const source = wrapper.get('[data-super-message="source"]')
  const reply = wrapper.get('[data-super-message="answer"]')
  expect(source.text()).toContain(i18n.global.t("superAgent.actions.workerNotStarted"))
  expect(source.text()).not.toContain(i18n.global.t("superAgent.state.failed"))
  expect(source.get('a[href="/settings/agents"]').text()).toBe(i18n.global.t("superAgent.actions.configureWorker"))
  await source.get("button[aria-expanded]").trigger("click")
  expect(source.text()).not.toContain(reason)
  expect(source.text().split(i18n.global.t("superAgent.actions.workerNotStarted"))).toHaveLength(2)
  const retry = source.findAll("button").find(button => button.text() === i18n.global.t("superAgent.actions.retryWorker"))!
  expect(retry.attributes("disabled")).toBeDefined()
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
  await reply.get('[aria-label="Copy message"]').trigger("click")
  await flushPromises()
  expect(writeText).toHaveBeenCalledExactlyOnceWith(answer)
  await reply.get('[aria-label="Quote"]').trigger("click")
  expect(wrapper.get('textarea').element.parentElement?.textContent).toContain(answer)
  useProvidersStore(pinia).providers = [{ id: "configured", name: "Codex", template: "codex" }]
  await flushPromises()
  expect(retry.attributes("disabled")).toBeUndefined()
  await retry.trigger("click")
  expect(api.send).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", messageId: "source", text: "source", retry: true, replyTo: undefined })
})

test("a split request exposes individual ticket references and an answer identical to its ticket title", async () => {
  const { api } = await setup(room({ tickets: [{ ...ticket("one"), sessionId: "1" }, { ...ticket("two"), sessionId: "2" }], messages: [
    message("ask", { state: "assigned" }),
    message("a", { role: "assistant", kind: "dispatch", sourceMessageId: "ask", ticketId: "one", text: "one" }),
    message("b", { role: "assistant", kind: "dispatch", sourceMessageId: "ask", ticketId: "two", text: "two" }),
    message("short-answer", { role: "assistant", sourceMessageId: "ask", ticketId: "one", text: "one" }),
    message("question", { role: "worker", workerEvent: "question", sourceMessageId: "ask", ticketId: "two", text: "Which format?" }),
  ] }))
  expect(wrapper.findAll("[data-super-message]")).toHaveLength(3)
  const row = wrapper.get('[data-super-message="ask"]')
  expect(row.findAll("a")).toHaveLength(0)
  await row.get("button[aria-expanded]").trigger("click")
  expect(row.findAll("a").map(link => [link.text(), link.attributes("href")])).toEqual([
    ["Open Session · one", "/sessions/1?superFrom=A&superMachine=local-daemon"],
    ["Open Session · two", "/sessions/2?superFrom=A&superMachine=local-daemon"],
  ])
  await row.get("button[aria-expanded]").trigger("click")
  expect(row.findAll("a")).toHaveLength(0)
  await wrapper.get('[aria-label="Quote two"]').trigger("click")
  await wrapper.get("textarea").setValue("Use Markdown")
  await wrapper.get("textarea").trigger("keydown", { key: "Enter" })
  expect(api.send).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", messageId: expect.any(String), text: "Use Markdown", replyTo: "b" })
})

test("a recovered dispatch keeps its original reply and loses the obsolete failure notice", async () => {
  await setup(room({ tickets: [ticket("owner")], messages: [
    message("ask", { state: "assigned", ticketId: "owner" }),
    message("old", { role: "worker", kind: "delivery", failureCode: "worker_unconfigured", sourceMessageId: "ask", ticketId: "owner", text: "Old delivery failure" }),
    message("reply", { role: "worker", workerEvent: "result", sourceMessageId: "ask", ticketId: "owner", text: "Done" }),
  ] }))
  expect(wrapper.findAll("[data-super-message]")).toHaveLength(2)
  expect(wrapper.text()).not.toContain("Old delivery failure")
  expect(wrapper.text()).not.toContain(i18n.global.t("superAgent.actions.workerNotStarted"))
  expect(wrapper.get('[data-super-message="reply"]').text()).toContain("Done")
})

test("worker choices and retry follow the host even when the central machine catalog is stale", async () => {
  const { api } = await setup(room({ provider: "actual", workerProviders: [{ id: "actual", name: "Local Codex" }], messages: [
    message("ask", { state: "failed", failureCode: "worker_unconfigured", retryable: true }),
  ] }))
  useProvidersStore(pinia).providers = [{ id: "stale", name: "Old agent", template: "codex" }]
  const source = wrapper.get('[data-super-message="ask"]')
  await source.findAll("button").find(button => button.text() === i18n.global.t("superAgent.actions.chooseWorker"))!.trigger("click")
  await (await projectRow("executor-provider")).trigger("click")
  await flushPromises()
  expect(new DOMWrapper(document.body).findAll("[data-project-model-choice]").map(item => item.text())).toEqual(["Local Codex"])
  const retry = source.findAll("button").find(button => button.text() === i18n.global.t("superAgent.actions.retryWorker"))!
  await retry.trigger("click")
  expect(api.send).toHaveBeenCalledExactlyOnceWith({ workspaceId: "A", messageId: "ask", text: "ask", replyTo: undefined, retry: true })
})

test("workspace inputs use the original account, delivery indicator, localized time and avatar", async () => {
  const createdAt = "2026-11-18T02:32:00Z"
  await setup(room({ messages: [
    message("old", { createdAt }),
    message("persisted", { createdAt, author: { kind: "user", userId: "signed-in" }, state: "failed" }),
  ] }), "team")
  for (const id of ["old", "persisted"]) {
    const row = wrapper.get(`[data-super-message="${id}"]`)
    const meta = row.get("[data-user-message-meta]")
    expect(meta.text()).toContain("Ada")
    expect(meta.get("time").attributes("datetime")).toBe(createdAt)
    expect(meta.get("time").text()).toMatch(/\d+:\d+/)
    expect(meta.find("svg.text-ui-focus").exists()).toBe(true)
    expect(row.find("[data-user-message-avatar]").exists()).toBe(true)
    expect(row.get("[data-user-message-bubble]").text()).toContain(id)
    expect(row.find('button[aria-label="Quote"]').exists()).toBe(true)
  }
  expect(wrapper.findAll("[data-conversation-entry]")).toHaveLength(2)
})

test("progress reports dispatched only after worker delivery succeeds, not while dispatching or after failure", async () => {
  const job = { ...ticket("verify"), status: "queued" as const }
  const source = message("ask", { state: "assigned", ticketId: job.id })
  const dispatching = message("dispatch", { role: "assistant", kind: "dispatch", sourceMessageId: source.id, ticketId: job.id, canStop: true, dispatching: true })
  const poll = await setupProgress(room({ supportsStop: true, tickets: [job], messages: [source, dispatching] }))
  expect(progressFor(source.id).text()).toContain(i18n.global.t("superAgent.progress.dispatching"))
  expect(progressFor(source.id).text()).not.toContain(i18n.global.t("superAgent.progress.queued"))
  expect(progressFor(source.id).find(`button[aria-label="${i18n.global.t("superAgent.stop.request")}"]`).exists()).toBe(true)

  const sent = { ...dispatching, dispatching: undefined, inputId: "input-1" }
  await poll(room({ supportsStop: true, tickets: [job], messages: [source, sent] }))
  expect(progressFor(source.id).text()).toContain(i18n.global.t("superAgent.progress.queued"))

  const failedSource = { ...source, state: "failed" as const, reason: "Worker unavailable" }
  const delivery = message("fail", { role: "worker", kind: "delivery", sourceMessageId: source.id, ticketId: job.id, text: "Worker unavailable" })
  await poll(room({ supportsStop: true, tickets: [{ ...job, status: "blocked" }], messages: [failedSource, { ...dispatching, dispatching: undefined, canStop: false }, delivery] }))
  expect(progressFor(source.id).exists()).toBe(false)
  expect(wrapper.get('[data-super-message="ask"]').text()).toContain(i18n.global.t("superAgent.actions.workerFailed"))
})
