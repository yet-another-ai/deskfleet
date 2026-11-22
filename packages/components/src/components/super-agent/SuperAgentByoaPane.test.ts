import { DOMWrapper, flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useProvidersStore } from "../../stores/providers.ts"
import { agentSnapshot } from "../../test/agent.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import SuperAgentByoaPane from "./SuperAgentByoaPane.vue"

let pinia: ReturnType<typeof createPinia>
let account: AccountSession | undefined
const cleanups: (() => void)[] = []

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  i18n.global.locale.value = "en-US"
})

afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) dispose()
  disposePinia(pinia)
  account?.dispose()
  account = undefined
  await flushPromises()
  vi.restoreAllMocks()
})

async function setup(options: { yolo?: boolean } = {}) {
  const { central } = fakeCentral({ teams: [{ id: "alpha", name: "Product", role: "admin" }] })
  account = createAccountSession(central)
  await flushPromises()

  const fleet = useFleetStore()
  const agents = useAgentSessionsStore()
  const providers = useProvidersStore()
  vi.spyOn(fleet, "refreshLocal").mockResolvedValue()
  vi.spyOn(agents, "refresh").mockResolvedValue()
  vi.spyOn(providers, "refresh").mockResolvedValue()
  vi.spyOn(agents, "open").mockResolvedValue()

  const onSessionChange = vi.fn()
  const onOpenConfig = vi.fn()
  const onSwitchToCloud = vi.fn()
  const machine = machineFixture("m1", "alpha", "Mac Studio", true)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: { template: "<div />" } }] })
  await router.push("/")

  const wrapper = mount(SuperAgentByoaPane, {
    attachTo: document.body,
    props: {
      teamId: "alpha",
      machine,
      target: {
        machineId: "m1",
        machineName: "Mac Studio",
        machineOnline: true,
        providerId: "claude-code",
        providerName: "Claude Code",
        yolo: options.yolo ?? false,
      },
      canConfigure: true,
      hostedConfigured: true,
      onSessionChange,
      onOpenConfig,
      onSwitchToCloud,
    },
    global: {
      plugins: [pinia, router, i18n],
      provide: { [accountSessionKey as symbol]: account },
    },
  })
  cleanups.push(() => wrapper.unmount())
  await flushPromises()
  return { central, agents, wrapper, onSessionChange }
}

test("isolates BYOA YOLO from ordinary draftYolo and respects Team BYOA YOLO configuration", async () => {
  const { central, agents, wrapper, onSessionChange } = await setup({ yolo: false })
  agents.draftYolo = true
  const created = agentSnapshot()
  created.session = { ...created.session, id: "byoa-session-1", lifecycle: "provisioning", superAgent: true }
  const createSpy = vi.spyOn(agents, "create").mockResolvedValue(created)
  const submitSpy = vi.spyOn(agents, "submit").mockResolvedValue({ operationId: "op-1", commandId: "cmd-1", sessionId: "byoa-session-1", inputId: "in-1" })

  // Ordinary session draftYolo does not bleed into BYOA composer.
  expect(wrapper.get("[data-composer-yolo]").attributes("aria-pressed")).toBe("false")
  await wrapper.get("textarea").setValue("Coordinate our release")
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()

  expect(createSpy).toHaveBeenCalledOnce()
  expect(createSpy).toHaveBeenCalledWith(
    undefined,
    "Coordinate our release",
    "directory",
    "claude-code",
    undefined,
    undefined,
    false,
    { deferStartup: true, superAgent: true },
  )
  expect(central.registerSuperAgentMachineSession).toHaveBeenCalledOnce()
  expect(submitSpy).toHaveBeenCalledWith("byoa-session-1", "Coordinate our release", "backlog", undefined, "Coordinate our release", { mentions: [], attachmentIds: [] })
  expect(onSessionChange).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "byoa-session-1", engine: "byoa" }), true)
})

test("creates a BYOA Super Agent with YOLO enabled when configured on the Team or toggled in the composer", async () => {
  const { agents, wrapper } = await setup({ yolo: true })
  const created = agentSnapshot()
  created.session = { ...created.session, id: "byoa-yolo-1", lifecycle: "provisioning", superAgent: true, yolo: true }
  const createSpy = vi.spyOn(agents, "create").mockResolvedValue(created)
  vi.spyOn(agents, "submit").mockResolvedValue({ operationId: "op-y1", commandId: "cmd-y1", sessionId: "byoa-yolo-1", inputId: "in-y1" })

  expect(wrapper.get("[data-composer-yolo]").attributes("aria-pressed")).toBe("true")
  await wrapper.get("textarea").setValue("Run release checks")
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()

  expect(createSpy).toHaveBeenCalledWith(
    undefined,
    "Run release checks",
    "directory",
    "claude-code",
    undefined,
    undefined,
    true,
    { deferStartup: true, superAgent: true },
  )

  // Can also toggle YOLO explicitly via the composer when Team default is off.
  const second = await setup({ yolo: false })
  const created2 = agentSnapshot()
  created2.session = { ...created2.session, id: "byoa-yolo-2", lifecycle: "provisioning", superAgent: true, yolo: true }
  const createSpy2 = vi.spyOn(second.agents, "create").mockResolvedValue(created2)
  vi.spyOn(second.agents, "submit").mockResolvedValue({ operationId: "op-y2", commandId: "cmd-y2", sessionId: "byoa-yolo-2", inputId: "in-y2" })
  await second.wrapper.get("[data-composer-yolo]").trigger("click")
  await flushPromises()
  await new DOMWrapper(document.body).get('[role="dialog"] button[data-confirm], [role="dialog"] .ui-button-primary, [role="dialog"] button:last-of-type').trigger("click")
  await flushPromises()
  expect(second.wrapper.get("[data-composer-yolo]").attributes("aria-pressed")).toBe("true")
  await second.wrapper.get("textarea").setValue("Run checks with YOLO")
  await second.wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(createSpy2).toHaveBeenCalledWith(
    undefined,
    "Run checks with YOLO",
    "directory",
    "claude-code",
    undefined,
    undefined,
    true,
    { deferStartup: true, superAgent: true },
  )
})

test("reuses the created session on registration failure and transitions with draft preserved when initial submit fails", async () => {
  const { central, agents, wrapper, onSessionChange } = await setup()
  agents.state = "connected"
  const created = agentSnapshot()
  created.session = { ...created.session, id: "byoa-session-2", lifecycle: "ready", superAgent: true }
  const createSpy = vi.spyOn(agents, "create").mockImplementation(async () => {
    agents.sessions[created.session.id] = created.session
    agents.views[created.session.id] = {
      snapshot: created,
      events: [],
      historySeq: "0",
      snapshotSeq: "0",
      loading: false,
      syncing: false,
      error: null,
      relayDeniedReason: undefined,
    }
    return created
  })
  central.registerSuperAgentMachineSession
    .mockRejectedValueOnce(new Error("Central temporarily unreachable"))
    .mockResolvedValue({
      sessionId: "byoa-session-2",
      title: "Audit machines",
      lastActiveAt: Date.now(),
      engine: "byoa",
      machineId: "m1",
      machineName: "Mac Studio",
      providerId: "claude-code",
      providerName: "Claude Code",
    })
  const submitSpy = vi.spyOn(agents, "submit")
    .mockRejectedValueOnce(new Error("Daemon temporarily unreachable"))
    .mockResolvedValue({ operationId: "op-2", commandId: "cmd-2", sessionId: "byoa-session-2", inputId: "in-2" })

  onSessionChange.mockImplementation((session, selectIt) => {
    if (selectIt) void wrapper.setProps({ sessionId: session.sessionId, sessionMeta: session })
  })

  await wrapper.get("textarea").setValue("Audit machines")

  // Attempt 1: create succeeds, central registration fails -> stays on New with pendingCreation.
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(createSpy).toHaveBeenCalledTimes(1)
  expect(central.registerSuperAgentMachineSession).toHaveBeenCalledTimes(1)
  expect(submitSpy).not.toHaveBeenCalled()
  expect(onSessionChange).not.toHaveBeenCalled()
  expect(wrapper.get('[role="alert"]').text()).toContain("Central temporarily unreachable")

  // Attempt 2: reuses created session, registration succeeds -> switches to session with draft & error intact even when initial submit fails.
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(createSpy).toHaveBeenCalledTimes(1)
  expect(central.registerSuperAgentMachineSession).toHaveBeenCalledTimes(2)
  expect(submitSpy).toHaveBeenCalledTimes(1)
  expect(onSessionChange).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "byoa-session-2" }), true)
  expect(wrapper.props("sessionId")).toBe("byoa-session-2")
  expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("Audit machines")
  expect(wrapper.get('[role="alert"]').text()).toContain("Daemon temporarily unreachable")

  // Attempt 3: sends directly into the selected session without creating a duplicate.
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(createSpy).toHaveBeenCalledTimes(1)
  expect(submitSpy).toHaveBeenCalledTimes(2)
})

test("clears a failed pending creation when navigating to another BYOA conversation", async () => {
  const { central, agents, wrapper } = await setup()
  const first = agentSnapshot()
  first.session = { ...first.session, id: "byoa-half-1", lifecycle: "provisioning", superAgent: true }
  const second = agentSnapshot()
  second.session = { ...second.session, id: "byoa-fresh-2", lifecycle: "provisioning", superAgent: true }
  const createSpy = vi.spyOn(agents, "create")
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
  central.registerSuperAgentMachineSession
    .mockRejectedValueOnce(new Error("Transient error"))
    .mockResolvedValue({
      sessionId: "byoa-fresh-2",
      title: "Fresh conversation",
      lastActiveAt: Date.now(),
      engine: "byoa",
      machineId: "m1",
      machineName: "Mac Studio",
      providerId: "claude-code",
      providerName: "Claude Code",
    })
  const submitSpy = vi.spyOn(agents, "submit").mockResolvedValue({ operationId: "op-3", commandId: "cmd-3", sessionId: "byoa-fresh-2", inputId: "in-3" })

  await wrapper.get("textarea").setValue("First attempt")
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(createSpy).toHaveBeenCalledTimes(1)

  // Navigate to a different existing BYOA conversation, then back to New.
  await wrapper.setProps({ sessionId: "existing-other-session" })
  await flushPromises()
  await wrapper.setProps({ sessionId: undefined })
  await flushPromises()

  await wrapper.get("textarea").setValue("Fresh conversation")
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()

  expect(createSpy).toHaveBeenCalledTimes(2)
  expect(submitSpy).toHaveBeenCalledWith("byoa-fresh-2", "Fresh conversation", "backlog", undefined, "Fresh conversation", { mentions: [], attachmentIds: [] })
})
