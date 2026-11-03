import { configureClient, getClient } from "@deskfleet/client/platform"
import { flushPromises } from "@vue/test-utils"
import { afterEach, beforeAll, expect, test, vi } from "vitest"

vi.mock("vitepress", () => ({ withBase: (path: string) => path }))

const { mountProductDemo } = await import("../../../docs/.vitepress/theme/components/demos/product-demo-runtime.ts")

const originalClient = getClient()
const cleanups: (() => void)[] = []

beforeAll(async () => {
  await Promise.all([
    import("./App.vue"),
    import("./views/NewSessionView.vue"),
    import("./views/SessionView.vue"),
    import("./views/RemoteControlView.vue"),
    import("./views/DesktopView.vue"),
    import("./views/SettingsView.vue"),
    import("./components/settings/AgentsSettings.vue"),
    import("./components/settings/PreferencesSettings.vue"),
  ])
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  configureClient(originalClient)
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flushPromises()
}

function visibleAlerts(container: ParentNode): Element[] {
  return [...container.querySelectorAll('[role="alert"]:not(.dv-live-region-assertive)')]
}

test.each([
  { kind: "agents" as const, initialRoute: "/" },
  { kind: "session" as const, initialRoute: "/sessions/301" },
  { kind: "team" as const, initialRoute: "/sessions/303" },
  { kind: "agents" as const, initialRoute: "/settings/agents" },
  { kind: "remote" as const, initialRoute: "/machines/demo-machine/control?tab=desktop" },
])("product demo route $initialRoute renders without download prompts or connection errors", async ({ kind, initialRoute }) => {
  const container = document.createElement("div")
  Object.defineProperty(container, "clientWidth", { value: 1280 })
  document.body.appendChild(container)
  cleanups.push(await mountProductDemo(container, { kind, initialRoute, sidebar: true }))
  await settle()

  expect(container.querySelector("[data-app-download]")).toBeNull()
  expect(visibleAlerts(container)).toEqual([])
  expect(container.textContent).not.toContain("Disconnected from agent")
  expect(container.textContent).not.toContain("This operation needs a connected machine.")
})

test("product demo composer preparation and team session controls run locally without daemon errors", async () => {
  const agentsTarget = document.createElement("div")
  Object.defineProperty(agentsTarget, "clientWidth", { value: 1280 })
  document.body.appendChild(agentsTarget)
  cleanups.push(await mountProductDemo(agentsTarget, { kind: "agents", initialRoute: "/", sidebar: true }))
  await settle()

  const prepareButton = agentsTarget.querySelector<HTMLButtonElement>("[data-prepare-session]")
  expect(prepareButton).not.toBeNull()
  prepareButton!.click()
  await settle()
  expect(visibleAlerts(agentsTarget)).toEqual([])

  const teamTarget = document.createElement("div")
  Object.defineProperty(teamTarget, "clientWidth", { value: 1280 })
  document.body.appendChild(teamTarget)
  cleanups.push(await mountProductDemo(teamTarget, { kind: "team", initialRoute: "/sessions/303", sidebar: true }))
  await settle()

  expect(teamTarget.textContent).toContain("Keyboard navigation")
  const allowButton = [...teamTarget.querySelectorAll("button")].find(button => button.textContent?.includes("Allow once"))
  expect(allowButton).toBeDefined()
  allowButton!.click()
  await settle()
  expect(visibleAlerts(teamTarget)).toEqual([])
})
