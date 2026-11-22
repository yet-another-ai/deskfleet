import { flushPromises, mount } from "@vue/test-utils"
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

async function setup() {
  const { central } = fakeCentral({ teams: [{ id: "alpha", name: "Product", role: "admin" }] })
  account = createAccountSession(central)
  await flushPromises()

  const fleet = useFleetStore()
  const agents = useAgentSessionsStore()
  const providers = useProvidersStore()
  vi.spyOn(fleet, "refreshLocal").mockResolvedValue()
  vi.spyOn(agents, "refresh").mockResolvedValue()
  vi.spyOn(providers, "refresh").mockResolvedValue()

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
        workspaceId: "ws-1",
        workspaceName: "Web App",
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

test("explicitly disables YOLO when creating a BYOA Super Agent even if draftYolo is enabled", async () => {
  const { central, agents, wrapper, onSessionChange } = await setup()
  agents.draftYolo = true
  const created = agentSnapshot()
  created.session = { ...created.session, id: "byoa-session-1", lifecycle: "provisioning", superAgent: true }
  const createSpy = vi.spyOn(agents, "create").mockResolvedValue(created)
  const submitSpy = vi.spyOn(agents, "submit").mockResolvedValue({ operationId: "op-1", commandId: "cmd-1", sessionId: "byoa-session-1", inputId: "in-1" })

  await wrapper.get("textarea").setValue("Coordinate our release")
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()

  expect(createSpy).toHaveBeenCalledOnce()
  expect(createSpy).toHaveBeenCalledWith(
    "ws-1",
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

test("reuses the created BYOA session on retry when registration or initial submit fails", async () => {
  const { central, agents, wrapper, onSessionChange } = await setup()
  const created = agentSnapshot()
  created.session = { ...created.session, id: "byoa-session-2", lifecycle: "provisioning", superAgent: true }
  const createSpy = vi.spyOn(agents, "create").mockImplementation(async () => {
    agents.sessions[created.session.id] = created.session
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
      workspaceId: "ws-1",
      workspaceName: "Web App",
    })
  const submitSpy = vi.spyOn(agents, "submit")
    .mockRejectedValueOnce(new Error("Daemon temporarily unreachable"))
    .mockResolvedValue({ operationId: "op-2", commandId: "cmd-2", sessionId: "byoa-session-2", inputId: "in-2" })

  await wrapper.get("textarea").setValue("Audit machines")

  // Attempt 1: create succeeds, central registration fails.
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(createSpy).toHaveBeenCalledTimes(1)
  expect(central.registerSuperAgentMachineSession).toHaveBeenCalledTimes(1)
  expect(submitSpy).not.toHaveBeenCalled()
  expect(wrapper.get('[role="alert"]').text()).toContain("Central temporarily unreachable")

  // Attempt 2: reuses created session, registration succeeds, submit fails.
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(createSpy).toHaveBeenCalledTimes(1)
  expect(central.registerSuperAgentMachineSession).toHaveBeenCalledTimes(2)
  expect(submitSpy).toHaveBeenCalledTimes(1)
  expect(onSessionChange).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "byoa-session-2" }), false)
  expect(wrapper.get('[role="alert"]').text()).toContain("Daemon temporarily unreachable")

  // Attempt 3: reuses created session & registration, submit succeeds and selects session.
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()
  expect(createSpy).toHaveBeenCalledTimes(1)
  expect(central.registerSuperAgentMachineSession).toHaveBeenCalledTimes(2)
  expect(submitSpy).toHaveBeenCalledTimes(2)
  expect(onSessionChange).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "byoa-session-2" }), true)
})
