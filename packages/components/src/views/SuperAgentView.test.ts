import { HttpError } from "@deskfleet/client/request-diagnostics"
import type { SuperAgentConfig, SuperAgentHistory, SuperAgentUsage } from "@deskfleet/client/super-agent"
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { accountSessionKey, createAccountSession } from "../composables/useAccountSession.ts"
import { machineRuntimesKey } from "../composables/useMachineRuntimes.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { i18n } from "../i18n/index.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import SuperAgentView from "./SuperAgentView.vue"

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.useRealTimers() })

async function setup(
  configure?: (central: ReturnType<typeof fakeCentral>["central"], state: ReturnType<typeof fakeCentral>["state"]) => void,
  options?: { route?: string; machines?: Map<string, { state: ReturnType<typeof createPinia> }> },
) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  const { central, state } = fakeCentral({ teams: [
    { id: "alpha", name: "Product", role: "admin" },
    { id: "beta", name: "Support", role: "member" },
  ] })
  central.superAgentAvailability.mockImplementation(async team => ({ enabled: team === "alpha" }))
  configure?.(central, state)
  const account = createAccountSession(central)
  await flushPromises()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/super-agent", name: "super-agent", component: SuperAgentView }] })
  await router.push(options?.route ?? "/super-agent")
  const wrapper = mount(SuperAgentView, { attachTo: document.body, global: {
    plugins: [createPinia(), i18n, router], provide: { [accountSessionKey as symbol]: account, ...(options?.machines && { [machineRuntimesKey as symbol]: { opened: options.machines } }) },
    stubs: { ...(options?.machines && { SuperAgentByoaHost: true }), AgentMarkdown: { props: ["text"], template: "<div>{{ text }}</div>" } },
  } })
  cleanup.push(() => { wrapper.unmount(); account.dispose() })
  await flushPromises()
  return { central, account, router, wrapper, visibility }
}

const at = "2026-11-21T08:00:00Z"

test("starts from a suggested prompt, creates only on send, then resumes committed history at the next cursor", async () => {
  const { central, router, wrapper } = await setup()
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
  await flushPromises()
  expect(wrapper.find('[data-conversation-entry^="input-"]').exists()).toBe(false)
  expect(central.createSuperAgentSession).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
  await router.push({ name: "super-agent", query: { session: "hosted:release" } })
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

test("lists unified Cloud and BYOA conversations with engine labels and opens the runtime configuration dialog", async () => {
  const { central, wrapper } = await setup((central, state) => {
    state.machines.push(machineFixture("m1", "alpha", "Mac Studio", true))
    central.catalog = vi.fn(async () => ({
      machineId: "m1",
      lastObservedAt: at,
      snapshot: {
        teamId: "alpha",
        machineId: "m1",
        machineName: "Mac Studio",
        workspaces: [{ id: "ws-1", name: "Web App", worktrees: [] }],
        sessions: [],
        terminals: [],
      },
      providers: {
        templates: [],
        providers: [{ id: "claude-code", template: "claude", name: "Claude Code", status: "ready" }],
      },
    })) as unknown as typeof central.catalog
    central.rpc = vi.fn(async () => ({ providers: [{ id: "claude-code", name: "Claude Code" }] })) as unknown as typeof central.rpc
    central.superAgentSessions.mockResolvedValue([
      { sessionId: "cloud-1", title: "Cloud roadmap", lastActiveAt: Date.parse(at), engine: "hosted" },
      {
        sessionId: "byoa-1", title: "Local audit", lastActiveAt: Date.parse(at) - 1000, engine: "byoa",
        machineId: "m1", machineName: "Mac Studio", providerId: "claude-code", providerName: "Claude Code",
      },
    ])
    central.superAgentHistory.mockResolvedValue({ nextIndex: 1, messages: [{ id: "r1", role: "assistant", text: "Hosted reply", at }] })
  })

  vi.useRealTimers()
  await wrapper.get('[data-super-agent-config-trigger]').trigger("click")
  await flushPromises()
  const body = new DOMWrapper(document.body)
  await body.get('[data-super-agent-mode="byoa"]').trigger("click")
  await flushPromises()
  expect(body.find('[data-super-agent-byoa-fields]').exists()).toBe(true)
  expect(body.find('[name="super-agent-workspace"]').exists()).toBe(false)
  expect(body.text()).toContain("Mac Studio")
  expect(body.text()).toContain("Claude Code")
  await body.get('[data-super-agent-yolo]').trigger("click")
  await flushPromises()
  await body.get('[data-super-agent-config-save]').trigger("click")
  await flushPromises()
  expect(central.updateSuperAgentConfig).toHaveBeenCalledWith("alpha", {
    mode: "byoa",
    byoa: {
      machineId: "m1",
      providerId: "claude-code",
      providerName: "Claude Code",
      cwd: null,
      yolo: true,
    },
  })
  expect(wrapper.get('[data-super-agent-config-trigger]').text()).toContain("Mac Studio")
})

test("offers switching to a local Agent when hosted credits are exhausted and machines are enrolled", async () => {
  const { wrapper } = await setup(central => {
    central.machines.mockResolvedValue([machineFixture("m1", "alpha", "Dev Box", true)])
    central.superAgentUsage.mockResolvedValue({
      runtimeConfigured: true, admitted: false, includedCredits: 100, usedCredits: "100",
      includedTokens: 100, usedTokens: 100, start: at, end: at, plan: "go",
    })
  })
  expect(wrapper.text()).toContain("Use local Agent")
})

test("waits for Team config before enabling Cloud send on an empty history and flips cleanly to BYOA", async () => {
  const configDeferred = Promise.withResolvers<SuperAgentConfig>()
  const { central, wrapper } = await setup((central, state) => {
    state.machines.push(machineFixture("m1", "alpha", "Mac Studio", true))
    central.superAgentConfig.mockReturnValue(configDeferred.promise)
    central.superAgentSessions.mockResolvedValue([])
  })

  expect(wrapper.get("textarea").attributes("disabled")).toBeDefined()
  expect(wrapper.text()).not.toContain("Plan a release")
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(central.createSuperAgentSession).not.toHaveBeenCalled()

  configDeferred.resolve({
    mode: "byoa",
    hostedConfigured: true,
    canConfigure: true,
    byoa: {
      machineId: "m1",
      machineName: "Mac Studio",
      machineOnline: true,
      providerId: "claude-code",
      providerName: "Claude Code",
      yolo: false,
    },
  })
  await flushPromises()

  expect(wrapper.find('[data-super-agent-config-trigger]').text()).toContain("Mac Studio")
  expect(wrapper.text()).toContain("Mac Studio")
  expect(central.createSuperAgentSession).not.toHaveBeenCalled()
})

test("keeps Cloud composer disabled when Team config fails to load on an empty history", async () => {
  const { central, wrapper } = await setup(central => {
    central.superAgentConfig.mockRejectedValueOnce(new Error("Config unavailable"))
    central.superAgentSessions.mockResolvedValue([])
  })

  expect(wrapper.get("textarea").attributes("disabled")).toBeDefined()
  expect(wrapper.get('[role="alert"]').text()).toContain("Couldn’t load Super Agent settings")
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(central.createSuperAgentSession).not.toHaveBeenCalled()
})

test("archives the selected hosted conversation and clears its route only after confirmed deletion succeeds", async () => {
  const { wrapper, central, router } = await setup(central => {
    central.superAgentSessions.mockResolvedValue([{ sessionId: "release", title: "Release plan", lastActiveAt: 20 }])
  })
  vi.useRealTimers()
  const page = new DOMWrapper(document.body)
  const action = async (label: string) => { await wrapper.get(`button[aria-label="${label}"]`).trigger("click"); await flushPromises() }
  const confirm = async (variant: string) => { await page.get(`[role="dialog"] .ui-button-${variant}`).trigger("click"); await flushPromises() }

  await action("Archive session")
  expect(page.get('[role="dialog"]').text()).toContain("Release plan")
  expect(central.archiveSuperAgentSession).not.toHaveBeenCalled()
  await confirm("primary")
  expect(central.archiveSuperAgentSession).toHaveBeenCalledExactlyOnceWith("alpha", "release")
  expect(wrapper.find("textarea").exists()).toBe(false)
  expect(wrapper.text()).toContain("This session is archived.")
  expect(router.currentRoute.value.query.session).toBe("hosted:release")

  await action("Delete session")
  await page.get("[data-confirm-cancel]").trigger("click")
  await flushPromises()
  expect(central.deleteSuperAgentSession).not.toHaveBeenCalled()
  await action("Delete session")
  central.deleteSuperAgentSession.mockRejectedValueOnce(new Error("Try again later"))
  await confirm("danger")
  expect(page.get('[role="dialog"] [role="alert"]').text()).toContain("Try again later")
  expect(wrapper.get("h1").text()).toBe("Release plan")

  await confirm("danger")
  expect(central.deleteSuperAgentSession).toHaveBeenCalledWith("alpha", "release")
  expect(wrapper.get("h1").text()).toBe("New conversation")
  expect(wrapper.find('[aria-label="Conversations"]').exists()).toBe(false)
  expect(router.currentRoute.value.query.session).toBeUndefined()
})

test("opens an archived conversation from history and restores it for sending", async () => {
  const { wrapper, central } = await setup(central => {
    central.superAgentSessions.mockResolvedValue([{ sessionId: "old", title: "Previous launch", lastActiveAt: 40, archived: true }])
  })
  vi.useRealTimers()
  expect(wrapper.get("h1").text()).toBe("New conversation")
  const page = new DOMWrapper(document.body)
  await wrapper.get('button[aria-label="Conversations"]').trigger("keydown", { key: "ArrowDown" })
  await flushPromises()
  await page.get('[role="menuitem"]').trigger("click")
  await flushPromises()
  expect(central.superAgentHistory).toHaveBeenCalledWith("alpha", "old", 0, undefined)
  expect(wrapper.find("textarea").exists()).toBe(false)
  await wrapper.get('button[aria-label="Restore session"]').trigger("click")
  await flushPromises()
  await page.get('[role="dialog"] .ui-button-primary').trigger("click")
  await flushPromises()
  expect(central.restoreSuperAgentSession).toHaveBeenCalledExactlyOnceWith("alpha", "old")
  expect(wrapper.get("h1").text()).toBe("Previous launch")
  expect(wrapper.get("textarea").attributes("disabled")).toBeUndefined()
})

test("deletes an archived BYOA deep link only on its owning machine when other conversations share the ID", async () => {
  const first = createPinia()
  const second = createPinia()
  cleanup.push(() => { disposePinia(first); disposePinia(second) })
  const firstDelete = vi.spyOn(useAgentSessionsStore(first), "remove").mockResolvedValue()
  const secondDelete = vi.spyOn(useAgentSessionsStore(second), "remove").mockResolvedValue()
  const { wrapper, central } = await setup((central, state) => {
    state.machines.push(machineFixture("m1", "alpha", "Mac"), machineFixture("m2", "alpha", "Linux"))
    central.superAgentSessions.mockResolvedValue([
      { engine: "hosted", sessionId: "7", title: "Cloud", lastActiveAt: 40 },
      { engine: "byoa", sessionId: "7", title: "Mac conversation", machineId: "m1", lastActiveAt: 30 },
      { engine: "byoa", sessionId: "7", title: "Linux conversation", machineId: "m2", lastActiveAt: 10, archived: true },
    ])
  }, { route: "/super-agent?session=byoa:m2:7", machines: new Map([["m1", { state: first }], ["m2", { state: second }]]) })
  vi.useRealTimers()
  expect(wrapper.get("h1").text()).toBe("Linux conversation")
  expect(central.superAgentHistory).not.toHaveBeenCalled()
  await wrapper.get('button[aria-label="Delete session"]').trigger("click")
  await flushPromises()
  await new DOMWrapper(document.body).get('[role="dialog"] .ui-button-danger').trigger("click")
  await flushPromises()
  expect(secondDelete).toHaveBeenCalledExactlyOnceWith("7")
  expect(firstDelete).not.toHaveBeenCalled()
  expect(central.deleteSuperAgentSession).not.toHaveBeenCalled()
})
