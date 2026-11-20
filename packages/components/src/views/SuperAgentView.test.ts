import { HttpError } from "@deskfleet/client/request-diagnostics"
import type { SuperAgentHistory, SuperAgentUsage } from "@deskfleet/client/super-agent"
import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { accountSessionKey, createAccountSession } from "../composables/useAccountSession.ts"
import { i18n } from "../i18n/index.ts"
import { fakeCentral } from "../test/central.ts"
import SuperAgentView from "./SuperAgentView.vue"

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.useRealTimers() })

async function setup(configure?: (central: ReturnType<typeof fakeCentral>["central"]) => void) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  const { central } = fakeCentral({ teams: [
    { id: "alpha", name: "Product", role: "admin" },
    { id: "beta", name: "Support", role: "member" },
  ] })
  central.superAgentAvailability.mockImplementation(async team => ({ enabled: team === "alpha" }))
  configure?.(central)
  const account = createAccountSession(central)
  await flushPromises()
  const wrapper = mount(SuperAgentView, { attachTo: document.body, global: {
    plugins: [i18n], provide: { [accountSessionKey as symbol]: account },
    stubs: { AgentMarkdown: { props: ["text"], template: "<div>{{ text }}</div>" } },
  } })
  cleanup.push(() => { wrapper.unmount(); account.dispose() })
  await flushPromises()
  return { central, account, wrapper }
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
  central.superAgentHistory.mockResolvedValueOnce({ nextIndex: 2, messages: [], status: "working" })
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(central.createSuperAgentSession).toHaveBeenCalledExactlyOnceWith("alpha", expect.any(String))
  expect(central.sendSuperAgentMessage).toHaveBeenCalledExactlyOnceWith("alpha", "release", expect.any(String), "Plan our release")
  expect(central.superAgentHistory).toHaveBeenLastCalledWith("alpha", "release", 0)
  expect(wrapper.get('[data-message-role="user"]').text()).toContain("Plan our release")

  central.superAgentHistory.mockResolvedValueOnce({ nextIndex: 8, status: "idle", messages: [
    { id: "msg-1", role: "user", text: "Plan our release", at },
    { id: "answer", role: "assistant", text: "Which date should we target?", at },
  ] })
  await vi.advanceTimersByTimeAsync(1500)
  await flushPromises()
  expect(central.superAgentHistory).toHaveBeenLastCalledWith("alpha", "release", 2)
  expect(wrapper.findAll('[data-message-role="user"]')).toHaveLength(1)
  expect(wrapper.get('[data-message-role="assistant"]').text()).toContain("Which date should we target?")
  expect(wrapper.get("h1").text()).toBe("Plan our release")
  expect(wrapper.text()).toContain("Shared with Product")
  await wrapper.get('button[aria-label="New conversation"]').trigger("click")
  expect(wrapper.find("[data-message-role]").exists()).toBe(false)
  expect(central.createSuperAgentSession).toHaveBeenCalledTimes(1)
  await wrapper.get("#super-agent-history li button").trigger("click")
  await flushPromises()
  expect(central.superAgentHistory).toHaveBeenLastCalledWith("alpha", "release", 0)
})

test("keeps the draft and reuses each operation ID when a create or a delivery acknowledgement is lost", async () => {
  const { central, wrapper } = await setup()
  central.createSuperAgentSession.mockRejectedValueOnce(new Error("Lost connection")).mockResolvedValue({ sessionId: "work" })
  central.sendSuperAgentMessage.mockRejectedValueOnce(new Error("Lost connection"))
  await wrapper.get("textarea").setValue("Review our plan")
  const submit = async () => { await wrapper.get("form").trigger("submit"); await flushPromises() }
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
    const usage: SuperAgentUsage = { runtimeConfigured: true, admitted: false, includedTokens: 100, usedTokens: 100, start: at, end: at, plan: "go" }
    central.superAgentUsage.mockResolvedValue(usage)
    central.superAgentSessions.mockResolvedValue([{ sessionId: "existing", title: "Review", lastActiveAt: Date.parse(at) }])
    central.superAgentHistory.mockResolvedValue({ nextIndex: 1, messages: [{ id: "reply", role: "assistant", text: "Previous reply", at }] })
  })
  expect(wrapper.get('[data-message-role="assistant"]').text()).toContain("Previous reply")
  expect(wrapper.get("textarea").attributes("disabled")).toBeDefined()
  expect(wrapper.text()).toContain("Your team has used all its credits for this billing period.")
  await wrapper.get("form").trigger("submit")
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
  expect(central.superAgentHistory).toHaveBeenCalledExactlyOnceWith("alpha", "private", 0)
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
  await wrapper.get("form").trigger("submit")
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
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(wrapper.find('[data-message-role="user"]').exists()).toBe(true)
  await vi.advanceTimersByTimeAsync(1500)
  await flushPromises()
  expect(wrapper.find('[data-message-role="user"]').exists()).toBe(false)
  expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("Review our plan")
  expect(wrapper.text()).toContain("Super Agent couldn’t complete this turn.")
  expect(wrapper.text()).not.toContain("Waiting for Super Agent")
  await vi.advanceTimersByTimeAsync(1500)
  expect(central.superAgentHistory).toHaveBeenCalledTimes(2)
})
