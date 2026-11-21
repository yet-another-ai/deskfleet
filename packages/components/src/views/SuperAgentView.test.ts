import { HttpError } from "@deskfleet/client/request-diagnostics"
import type { SuperAgentHistory, SuperAgentUsage } from "@deskfleet/client/super-agent"
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { accountSessionKey, createAccountSession } from "../composables/useAccountSession.ts"
import { i18n } from "../i18n/index.ts"
import { fakeCentral } from "../test/central.ts"
import SuperAgentView from "./SuperAgentView.vue"

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.useRealTimers() })

async function setup(configure?: (central: ReturnType<typeof fakeCentral>["central"]) => void) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  const { central } = fakeCentral({ teams: [
    { id: "alpha", name: "Product", role: "admin" },
    { id: "beta", name: "Support", role: "member" },
  ] })
  central.superAgentAvailability.mockImplementation(async team => ({ enabled: team === "alpha" }))
  configure?.(central)
  const account = createAccountSession(central)
  await flushPromises()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/super-agent", component: SuperAgentView }] })
  await router.push("/super-agent")
  const wrapper = mount(SuperAgentView, { attachTo: document.body, global: {
    plugins: [createPinia(), i18n, router], provide: { [accountSessionKey as symbol]: account },
    stubs: { AgentMarkdown: { props: ["text"], template: "<div>{{ text }}</div>" } },
  } })
  cleanup.push(() => { wrapper.unmount(); account.dispose() })
  await flushPromises()
  return { central, account, wrapper, visibility }
}

const at = "2026-11-21T08:00:00Z"

test("starts from a suggested prompt, creates only on send, then resumes committed history at the next cursor", async () => {
  const { central, wrapper } = await setup()
  expect(central.createSuperAgentSession).not.toHaveBeenCalled()
  await wrapper.findAll("button").find(button => button.text() === "Plan a release")!.trigger("click")
  expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toContain("release")
  await wrapper.get("textarea").setValue("Plan our release")
  central.createSuperAgentSession.mockResolvedValue({ sessionId: "release" })
  central.sendSuperAgentMessage.mockResolvedValue({ sessionId: "release", deliveryId: "msg-1" })
  const pendingSenders = [["msg-1", "user-1"]] as const
  central.superAgentHistory.mockResolvedValueOnce({ nextIndex: 2, messages: [], status: "working", pendingSenders })
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(central.createSuperAgentSession).toHaveBeenCalledExactlyOnceWith("alpha", expect.any(String))
  expect(central.sendSuperAgentMessage).toHaveBeenCalledExactlyOnceWith("alpha", "release", expect.any(String), "Plan our release")
  expect(central.superAgentHistory).toHaveBeenLastCalledWith("alpha", "release", 0, undefined)
  expect(wrapper.get('[data-user-message-meta]').text()).toContain("Ada")
  expect(wrapper.get('[data-user-message-bubble]').text()).toContain("Plan our release")

  central.superAgentHistory.mockResolvedValueOnce({ nextIndex: 8, status: "idle", messages: [
    { id: "msg-1", role: "user", text: "Plan our release", at, senderId: "user-1" },
    { id: "answer", role: "assistant", text: "Which date should we target?", at },
  ] })
  await vi.advanceTimersByTimeAsync(1500)
  await flushPromises()
  expect(central.superAgentHistory).toHaveBeenLastCalledWith("alpha", "release", 2, pendingSenders)
  expect(wrapper.findAll('[data-user-message-bubble]')).toHaveLength(1)
  expect(wrapper.get('[data-conversation-entry^="message-"]').text()).toContain("Which date should we target?")
  expect(wrapper.get("h1").text()).toBe("Plan our release")
  expect(wrapper.text()).toContain("Shared with Product")
  await wrapper.get('button[aria-label="New conversation"]').trigger("click")
  expect(wrapper.find('[data-conversation-entry^="input-"]').exists()).toBe(false)
  expect(central.createSuperAgentSession).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
  await wrapper.get('button[aria-label="Conversations"]').trigger("keydown", { key: "ArrowDown" })
  await flushPromises()
  await new DOMWrapper(document.body).get('#super-agent-history [role="menuitem"]').trigger("click")
  await flushPromises()
  expect(central.superAgentHistory).toHaveBeenLastCalledWith("alpha", "release", 0, undefined)
})

test("names senders from the Team roster even without a Machine and preserves legacy attribution", async () => {
  const { wrapper } = await setup(central => {
    central.superAgentSessions.mockResolvedValue([{ sessionId: "release", title: "Release plan", lastActiveAt: Date.parse(at) }])
    central.superAgentHistory.mockResolvedValue({ nextIndex: 9, messages: [
      { id: "ada", role: "user", text: "Plan our release", at, senderId: "user-1" },
      { id: "bob", role: "user", text: "Review the dates", at, senderId: "user-2" },
      { id: "former", role: "user", text: "I can review it", at, senderId: "user-3" },
      { id: "older", role: "user", text: "Update the plan", at },
    ] })
  })
  expect(wrapper.findAll('[data-user-message-meta] .font-medium').map(label => label.text())).toEqual(["Ada", "Bob", "user-3", "Team member"])
})

test("keeps the draft and reuses each operation ID when a create or a delivery acknowledgement is lost", async () => {
  const { central, wrapper } = await setup()
  central.createSuperAgentSession.mockRejectedValueOnce(new Error("Lost connection")).mockResolvedValue({ sessionId: "work" })
  central.sendSuperAgentMessage.mockRejectedValueOnce(new Error("Lost connection"))
  await wrapper.get("textarea").setValue("Review our plan")
  const submit = async () => { await wrapper.get(".composer-send").trigger("click"); await flushPromises() }
  await submit()
  expect(wrapper.get('[role="alert"]').text()).toContain("Couldn’t send your message")
  await submit()
  expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("Review our plan")
  await submit()
  expect(central.createSuperAgentSession.mock.calls[1]).toEqual(central.createSuperAgentSession.mock.calls[0])
  expect(central.sendSuperAgentMessage.mock.calls[1]).toEqual(central.sendSuperAgentMessage.mock.calls[0])
  expect(central.createSuperAgentSession).toHaveBeenCalledTimes(2)
  expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("")
})

test("a Team at its limit can read an existing conversation without creating or sending", async () => {
  const { wrapper, central } = await setup(central => {
    const usage: SuperAgentUsage = { runtimeConfigured: true, admitted: false, includedCredits: 100, usedCredits: "100", includedTokens: 0, usedTokens: 200, start: at, end: at, plan: "go" }
    central.superAgentUsage.mockResolvedValue(usage)
    central.superAgentSessions.mockResolvedValue([{ sessionId: "existing", title: "Review", lastActiveAt: Date.parse(at) }])
    central.superAgentHistory.mockResolvedValue({ nextIndex: 1, messages: [{ id: "reply", role: "assistant", text: "Previous reply", at }] })
  })
  expect(wrapper.get('[data-conversation-entry^="message-"]').text()).toContain("Previous reply")
  expect(wrapper.get("textarea").attributes("disabled")).toBeDefined()
  expect(wrapper.text()).toContain("Your team has used all its credits for this billing period.")
  await wrapper.get(".composer-send").trigger("click")
  expect(central.sendSuperAgentMessage).not.toHaveBeenCalled()
})

test("ignores late history and avoids feature reads while the next Team's gate is pending or off", async () => {
  const deferred = Promise.withResolvers<SuperAgentHistory>()
  const gate = Promise.withResolvers<{ enabled: boolean }>()
  const { account, central, wrapper } = await setup(central => {
    central.superAgentSessions.mockResolvedValue([{ sessionId: "private", title: "Private plan", lastActiveAt: Date.parse(at) }])
    central.superAgentHistory.mockReturnValue(deferred.promise)
    central.superAgentAvailability.mockImplementation(team => team === "alpha" ? Promise.resolve({ enabled: true }) : gate.promise)
  })
  expect(central.superAgentHistory).toHaveBeenCalledExactlyOnceWith("alpha", "private", 0, undefined)
  await account.selectTeam("beta")
  deferred.resolve({ nextIndex: 1, messages: [{ id: "reply", role: "assistant", text: "Private response", at }] })
  await flushPromises()
  expect(account.superAgentEnabled.value).toBeUndefined()
  expect(wrapper.text()).not.toContain("Private")
  gate.resolve({ enabled: false })
  await flushPromises()
  expect(account.superAgentEnabled.value).toBe(false)
  expect(central.superAgentSessions).toHaveBeenCalledExactlyOnceWith("alpha")
  expect(central.superAgentUsage).toHaveBeenCalledExactlyOnceWith("alpha")
})

test("refreshes the route gate on revocation at the API", async () => {
  const { central, account, wrapper } = await setup()
  central.superAgentAvailability.mockResolvedValue({ enabled: false })
  central.createSuperAgentSession.mockRejectedValue(new HttpError(404, "Feature disabled", undefined, "super_agent_disabled"))
  await wrapper.get("textarea").setValue("Plan a trip")
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(account.superAgentEnabled.value).toBe(false)
  expect(central.sendSuperAgentMessage).not.toHaveBeenCalled()
})

test("removes a refused optimistic delivery, restores its draft, and leaves fast polling", async () => {
  const { central, wrapper } = await setup()
  central.createSuperAgentSession.mockResolvedValue({ sessionId: "work" })
  central.sendSuperAgentMessage.mockResolvedValue({ sessionId: "work", deliveryId: "refused" })
  central.superAgentHistory.mockResolvedValueOnce({ messages: [], nextIndex: 1 })
    .mockResolvedValueOnce({ messages: [], nextIndex: 2, undeliveredIds: ["refused"], status: "failed" })
  await wrapper.get("textarea").setValue("Review our plan")
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(wrapper.find('[data-user-message-bubble]').exists()).toBe(true)
  await vi.advanceTimersByTimeAsync(1500)
  await flushPromises()
  expect(wrapper.find('[data-user-message-bubble]').exists()).toBe(false)
  expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("Review our plan")
  expect(wrapper.text()).toContain("Super Agent couldn’t complete this turn.")
  expect(wrapper.text()).not.toContain("Waiting for Super Agent")
  await vi.advanceTimersByTimeAsync(1500)
  expect(central.superAgentHistory).toHaveBeenCalledTimes(2)
})

test("sends a local file through the common composer and restores it after a refusal", async () => {
  const { central, wrapper } = await setup()
  central.createSuperAgentSession.mockResolvedValue({ sessionId: "work" })
  central.sendSuperAgentMessage.mockResolvedValue({ sessionId: "work", deliveryId: "file-delivery" })
  central.superAgentHistory.mockResolvedValueOnce({ messages: [], nextIndex: 1 })
    .mockResolvedValueOnce({ messages: [], nextIndex: 2, undeliveredIds: ["file-delivery"], status: "failed" })

  const input = wrapper.get<HTMLInputElement>("[data-composer-file-input]")
  Object.defineProperty(input.element, "files", { value: [new File(["Checklist"], "release.txt", { type: "text/plain" })] })
  await input.trigger("change")
  await flushPromises()
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(central.sendSuperAgentMessage).toHaveBeenCalledWith("alpha", "work", expect.any(String), [
    { type: "file", mediaType: "text/plain", filename: "release.txt", data: "Q2hlY2tsaXN0" },
  ])
  expect(wrapper.get("[data-user-message-bubble]").text()).toContain("release.txt")
  await vi.advanceTimersByTimeAsync(1500)
  await flushPromises()
  expect(wrapper.find('button[aria-label="Remove release.txt"]').exists()).toBe(true)
  expect(wrapper.find("[data-user-message-bubble]").exists()).toBe(false)
})

test.each(["text", "attachment"])("quota exhaustion allows cancellation with an unsent %s draft", async draftKind => {
  const { central, wrapper, visibility } = await setup(central => {
    central.superAgentSessions.mockResolvedValue([{ sessionId: "work", title: "Shared work", lastActiveAt: Date.parse(at) }])
    central.superAgentHistory.mockResolvedValueOnce({ nextIndex: 2, status: "working", turns: [{ id: "turn-1", state: "running", startedAt: at }], messages: [] })
  })
  const textarea = wrapper.get<HTMLTextAreaElement>("textarea")
  const draft = draftKind === "text" ? "Follow up on the release" : ""
  if (draftKind === "text") await textarea.setValue(draft)
  else {
    const input = wrapper.get<HTMLInputElement>("[data-composer-file-input]")
    Object.defineProperty(input.element, "files", { value: [new File(["Checklist"], "release.txt", { type: "text/plain" })] })
    await input.trigger("change")
    await flushPromises()
  }
  expect(wrapper.get(".composer-send").attributes("disabled")).toBeUndefined()

  central.superAgentUsage.mockResolvedValue({ runtimeConfigured: true, admitted: false, includedTokens: 200, usedTokens: 200, start: at, end: at, plan: "go" })
  visibility.mockReturnValue("hidden")
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()
  visibility.mockReturnValue("visible")
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()

  central.superAgentHistory.mockResolvedValueOnce({ nextIndex: 3, status: "idle", turns: [{ id: "turn-1", state: "cancelled", endedAt: at }], messages: [] })
  expect(wrapper.get("textarea").attributes("disabled")).toBeDefined()
  await wrapper.get('button[aria-label="Cancel turn"]').trigger("click")
  await flushPromises()
  expect(central.cancelSuperAgentTurn).toHaveBeenCalledExactlyOnceWith("alpha", "work", "turn-1")
  expect(central.sendSuperAgentMessage).not.toHaveBeenCalled()
  expect(textarea.element.value).toBe(draft)
  if (draftKind === "attachment") expect(wrapper.find('button[aria-label="Remove release.txt"]').exists()).toBe(true)
  expect(wrapper.find('button[aria-label="Cancel turn"]').exists()).toBe(false)
  expect(wrapper.text()).not.toContain("Cancelling the turn…")
})
