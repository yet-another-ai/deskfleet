import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { getClient } from "@deskfleet/client/platform"
import type { McpServerConfig, McpServerInput, McpServerSnapshot } from "@deskfleet/client/mcp-servers"
import AccountShell from "./AccountShell.vue"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import { fakeCentral, machineFixture } from "./test/central.ts"

const page = () => new DOMWrapper(document.body)
const tabs = () => page().get(`nav[aria-label="${i18n.global.t("mcpServers.machines")}"]`)
const tab = (name: string) => tabs().findAll("button").find(value => value.text().includes(name))!
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
let view: VueWrapper | undefined
let state: Pinia

beforeAll(async () => {
  await Promise.all([
    import("./components/account/MachineSurface.vue"),
    import("./views/SettingsView.vue"),
    import("./components/settings/McpServersSettings.vue"),
  ])
})
beforeEach(() => { state = createPinia() })
afterEach(async () => {
  view?.unmount()
  view = undefined
  disposePinia(state)
  await router.replace("/")
  vi.restoreAllMocks()
})

async function settled(probe: () => void): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt < 30; attempt++) {
    try { probe(); return } catch (reason) { failure = reason }
    await flushPromises()
  }
  throw failure
}

function fixture() {
  const fake = fakeCentral({ machines: [
    machineFixture("m1", "team-1", "First machine"),
    machineFixture("m2", "team-1", "Second machine"),
    machineFixture("m3", "team-1", "Offline machine", false),
  ] })
  const servers = new Map<string, McpServerConfig[]>(["m1", "m2", "m3"].map(id => [id, [{
    id: "shared-server", name: `Tools ${id}`, enabled: true, transport: "stdio",
    command: `/tools/${id}/mcp`, args: [], env: {},
  }]]))
  const list = vi.fn(async (machineId: string): Promise<McpServerSnapshot> => ({ revision: machineId, servers: clone(servers.get(machineId)!) }))
  const rpc = vi.fn(async (_teamId: string, machineId: string, method: string, params: Record<string, unknown>) => {
    const values = servers.get(machineId)!
    if (method === "mcpServerList") return list(machineId)
    if (method === "mcpServerCreate") {
      const server = { ...(params.server as McpServerInput), id: "created-server" }
      values.push(server)
      return clone(server)
    }
    if (method === "mcpServerUpdate") {
      const server = { ...(params.changes as McpServerInput), id: params.serverId as string }
      servers.set(machineId, values.map(value => value.id === server.id ? server : value))
      return clone(server)
    }
    if (method === "mcpServerRemove") {
      servers.set(machineId, values.filter(value => value.id !== params.serverId))
      return null
    }
    if (method === "terminalList") return []
    throw new Error(`Unexpected RPC: ${machineId} ${method}`)
  })
  Object.assign(fake.central, {
    rpc,
    catalog: vi.fn(async (_teamId: string, machineId: string) => ({
      machineId, lastObservedAt: "2026-11-01T00:00:00Z", providers: { providers: [] },
      snapshot: { teamId: "team-1", machineId, machineName: fake.state.machines.find(machine => machine.id === machineId)!.name, workspaces: [], sessions: [] },
    })),
    sessions: vi.fn(async () => []),
  })
  async function render() {
    await router.push("/settings/mcp-servers")
    view = mount(AccountShell, {
      props: { host: { ...getClient(), platform: "web", central: fake.central } },
      global: { plugins: [state, router, i18n] }, attachTo: document.body,
    })
    await settled(() => expect(tabs().findAll("button")).toHaveLength(3))
  }
  return { ...fake, servers, list, rpc, render }
}

test("MCP tabs isolate drafts and target server operations at the selected machine", async () => {
  const f = fixture()
  await f.render()
  await settled(() => expect(page().get('[data-mcp-server="shared-server"]').text()).toContain("Tools m1"))
  await page().get("[data-mcp-edit]").trigger("click")
  await page().get('[name="mcp-name"]').setValue("Unsaved first machine name")

  await tab("Second machine").trigger("click")
  await settled(() => expect(page().get('[data-mcp-server="shared-server"]').text()).toContain("Tools m2"))
  expect(router.currentRoute.value.path).toBe("/settings/mcp-servers")
  expect(tab("Second machine").attributes("aria-current")).toBe("page")
  expect(tab("First machine").attributes("aria-current")).toBeUndefined()
  expect(page().find("[role=dialog]").exists()).toBe(false)
  expect(f.list).toHaveBeenCalledWith("m2")

  f.rpc.mockClear()
  await page().get("[data-mcp-edit]").trigger("click")
  expect((page().get('[name="mcp-command"]').element as HTMLInputElement).value).toBe("/tools/m2/mcp")
  await page().get('[name="mcp-name"]').setValue("Second machine tools")
  await page().get("[role=dialog] form").trigger("submit")
  await settled(() => expect(page().find("[role=dialog]").exists()).toBe(false))
  expect(f.rpc).toHaveBeenCalledWith("team-1", "m2", "mcpServerUpdate", { serverId: "shared-server", changes: expect.objectContaining({ name: "Second machine tools", command: "/tools/m2/mcp" }) })

  const rpc = f.rpc.getMockImplementation()!
  let finishToggle!: () => void
  f.rpc.mockImplementationOnce(async (...args) => {
    const result = await rpc(...args)
    await new Promise<void>(resolve => { finishToggle = resolve })
    return result
  })
  await settled(() => expect(page().get("[data-mcp-toggle]").attributes("disabled")).toBeUndefined())
  await page().get("[data-mcp-toggle]").trigger("click")
  await flushPromises()
  expect(f.rpc).toHaveBeenCalledWith("team-1", "m2", "mcpServerUpdate", { serverId: "shared-server", changes: expect.objectContaining({ enabled: false }) })
  expect(tabs().findAll("button").every(button => button.attributes("disabled") !== undefined)).toBe(true)
  finishToggle()
  await settled(() => expect(page().get("[data-mcp-toggle]").attributes("aria-checked")).toBe("false"))
  expect(tab("First machine").attributes("disabled")).toBeUndefined()

  await page().get("[data-mcp-add]").trigger("click")
  await page().get('[name="mcp-name"]').setValue("Extra second machine tools")
  await page().get('[name="mcp-command"]').setValue("/tools/m2/extra")
  await page().get("[role=dialog] form").trigger("submit")
  await settled(() => expect(page().find("[role=dialog]").exists()).toBe(false))
  expect(f.rpc).toHaveBeenCalledWith("team-1", "m2", "mcpServerCreate", { server: expect.objectContaining({ name: "Extra second machine tools" }) })

  await page().get('[data-mcp-server="shared-server"] [data-mcp-remove]').trigger("click")
  await page().get("[role=dialog] .ui-button-danger").trigger("click")
  await settled(() => expect(page().find('[data-mcp-server="shared-server"]').exists()).toBe(false))
  expect(f.rpc).toHaveBeenCalledWith("team-1", "m2", "mcpServerRemove", { serverId: "shared-server" })
  expect(f.rpc.mock.calls.filter(([, , method]) => method.startsWith("mcpServer")).every(([, id]) => id === "m2")).toBe(true)

  await tab("First machine").trigger("click")
  await settled(() => expect(page().get('[data-mcp-server="shared-server"]').text()).toContain("Tools m1"))
  expect(page().findAll("[data-mcp-server]")).toHaveLength(1)
  expect(f.servers.get("m1")![0]).toMatchObject({ name: "Tools m1", enabled: true, command: "/tools/m1/mcp" })
  await page().get("[data-mcp-edit]").trigger("click")
  expect((page().get('[name="mcp-name"]').element as HTMLInputElement).value).toBe("Tools m1")
})

test("late MCP reads stay on their machine and offline tabs load only after reconnecting", async () => {
  const f = fixture()
  let finishFirst!: (snapshot: McpServerSnapshot) => void
  f.list.mockImplementation(machineId => machineId === "m1"
    ? new Promise(resolve => { finishFirst = resolve })
    : Promise.resolve({ revision: machineId, servers: clone(f.servers.get(machineId)!) }))
  await f.render()
  await settled(() => expect(f.list).toHaveBeenCalledWith("m1"))
  await tab("Second machine").trigger("click")
  await settled(() => expect(page().get('[data-mcp-server="shared-server"]').text()).toContain("Tools m2"))
  finishFirst({ revision: "m1", servers: clone(f.servers.get("m1")!) })
  await flushPromises()
  expect(page().get('[data-mcp-server="shared-server"]').text()).toContain("Tools m2")

  f.rpc.mockClear()
  await tab("Offline machine").trigger("click")
  await settled(() => expect(tabs().get('[aria-current="page"]').text()).toContain("Offline machine"))
  expect(page().get("[data-mcp-add]").attributes("disabled")).toBeDefined()
  expect(page().find("[data-mcp-server]").exists()).toBe(false)
  expect(f.rpc.mock.calls.filter(([, , method]) => method.startsWith("mcpServer"))).toEqual([])
  expect(router.currentRoute.value.path).toBe("/settings/mcp-servers")

  f.emit({ type: "presence", teamId: "team-1", machineId: "m3", online: true })
  await settled(() => expect(page().get('[data-mcp-server="shared-server"]').text()).toContain("Tools m3"))
  expect(page().get("[data-mcp-add]").attributes("disabled")).toBeUndefined()
  expect(f.rpc).toHaveBeenCalledWith("team-1", "m3", "mcpServerList", {})
})
