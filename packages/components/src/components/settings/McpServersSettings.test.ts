import { client as platformClient } from "@deskfleet/client/platform"
import type { CentralApi } from "@deskfleet/client/central"
import type { McpServerConfig, McpServerInput } from "@deskfleet/client/mcp-servers"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { accountSessionKey, createAccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import McpServersSettings from "./McpServersSettings.vue"

const originalTarget = platformClient.target
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
  platformClient.target = originalTarget
  vi.restoreAllMocks()
})
const server: McpServerConfig = { id: "server-1", name: "Repository tools", enabled: true, transport: "stdio", command: "C:\\tools\\mcp.exe", args: ["--root", "C:\\code"], env: { ACCESS_TOKEN: "test-token" } }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

async function setup(initial: McpServerConfig[] = []) {
  platformClient.target = { id: "machine-1", local: false }
  const fake = fakeCentral({ machines: [machineFixture("machine-1", "team-1", "Build machine")] })
  let servers = clone(initial)
  const rpc = vi.fn(async (_machineId: string, method: string, params: unknown): Promise<unknown> => {
    if (method === "mcpServerList") return { revision: "1", servers: clone(servers) }
    if (method === "mcpServerCreate") {
      const created = { ...(params as { server: McpServerInput }).server, id: "server-new" }
      servers.push(created)
      return clone(created)
    }
    if (method === "mcpServerUpdate") {
      const { serverId, changes } = params as { serverId: string; changes: McpServerInput }
      const updated = { ...changes, id: serverId }
      servers = servers.map(value => value.id === serverId ? updated : value)
      return clone(updated)
    }
    if (method === "mcpServerRemove") {
      servers = servers.filter(value => value.id !== (params as { serverId: string }).serverId)
      return null
    }
    throw new Error(`Unexpected method ${method}`)
  })
  fake.central.rpc = rpc as CentralApi["rpc"]
  const account = createAccountSession(fake.central)
  await flushPromises()
  const pinia = createPinia()
  setActivePinia(pinia)
  const fleet = useFleetStore()
  fleet.localDesktopTarget.online = true
  const wrapper = mount(McpServersSettings, { attachTo: document.body, global: { plugins: [pinia, i18n], provide: { [accountSessionKey as symbol]: account } } })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia); account.dispose() })
  await flushPromises()
  return { wrapper, rpc, account }
}

test("settings lists only user-configured servers", async () => {
  const { wrapper, rpc } = await setup([server])
  expect(wrapper.findAll("[data-mcp-server]")).toHaveLength(1)
  expect(wrapper.get('[data-mcp-server="server-1"]').text()).toContain("Repository tools")
  expect(wrapper.text()).not.toContain("deskfleet")
  expect(wrapper.text()).not.toContain("Always enabled")
  expect(rpc).toHaveBeenCalledWith("machine-1", "mcpServerList", {})
  await wrapper.get("[data-mcp-add]").trigger("click")
  await wrapper.get('[name="mcp-name"]').setValue("Deskfleet")
  await wrapper.get('[name="mcp-command"]').setValue("C:\\tools\\other.exe")
  expect(wrapper.get("[data-mcp-save]").attributes("disabled")).toBeDefined()
})

test("creates a stdio server with ordered arguments, empty arguments, and exact environment values", async () => {
  const { wrapper, rpc } = await setup()
  await wrapper.get("[data-mcp-add]").trigger("click")
  await wrapper.get('[name="mcp-name"]').setValue("Repository tools")
  await wrapper.get('[name="mcp-command"]').setValue("C:\\tools\\mcp.exe")
  await wrapper.get("[data-mcp-add-arg]").trigger("click")
  await wrapper.get('[name="mcp-argument-0"]').setValue("--root=C:\\My Code")
  await wrapper.get("[data-mcp-add-arg]").trigger("click")
  await wrapper.get("[data-mcp-add-pair]").trigger("click")
  await wrapper.get('[name="mcp-key-0"]').setValue("ACCESS_TOKEN")
  await wrapper.get('[name="mcp-value-0"]').setValue("token=with=equals")
  await wrapper.get("dialog form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "mcpServerCreate", { server: {
    name: "Repository tools", enabled: true, transport: "stdio", command: "C:\\tools\\mcp.exe", args: ["--root=C:\\My Code", ""], env: { ACCESS_TOKEN: "token=with=equals" },
  } })
  expect(wrapper.find("dialog").exists()).toBe(false)
  expect(wrapper.get('[data-mcp-server="server-new"]').text()).toContain("Repository tools")
  expect(wrapper.text()).not.toContain("token=with=equals")
})

test("edits HTTP settings, preserving headers when switching to SSE and rejecting duplicate header names", async () => {
  const { wrapper, rpc } = await setup([{ id: "remote", name: "Remote tools", enabled: true, transport: "http", url: "https://mcp.example.test/tools", headers: { Authorization: "Bearer test-token" } }])
  await wrapper.get("[data-mcp-edit]").trigger("click")
  await wrapper.get('[name="mcp-transport"]').setValue("sse")
  await wrapper.get("[data-mcp-add-pair]").trigger("click")
  await wrapper.get('[name="mcp-key-1"]').setValue("authorization")
  await wrapper.get('[name="mcp-value-1"]').setValue("duplicate")
  await wrapper.get("dialog form").trigger("submit")
  expect(wrapper.get('[role="alert"]').text()).toContain("must be unique")
  expect(rpc.mock.calls.filter(([, method]) => method === "mcpServerUpdate")).toHaveLength(0)
  await wrapper.get('button[aria-label="Remove entry 2"]').trigger("click")
  await wrapper.get("dialog form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "mcpServerUpdate", { serverId: "remote", changes: {
    name: "Remote tools", enabled: true, transport: "sse", url: "https://mcp.example.test/tools", headers: { Authorization: "Bearer test-token" },
  } })
})

test("disable sends the complete config without its ID", async () => {
  const { wrapper, rpc } = await setup([server])
  await wrapper.get("[data-mcp-toggle]").trigger("click")
  await flushPromises()
  const { id, ...input } = server
  expect(rpc).toHaveBeenCalledWith("machine-1", "mcpServerUpdate", { serverId: id, changes: { ...input, enabled: false } })
  expect(wrapper.get("[data-mcp-toggle]").text()).toBe("Disabled")
})

test("removal failures stay in the confirmation dialog and a successful retry removes only the extra server", async () => {
  const { wrapper, rpc } = await setup([server])
  await wrapper.get("[data-mcp-remove]").trigger("click")
  rpc.mockRejectedValueOnce(new Error("Machine disconnected"))
  await wrapper.get("dialog .ui-button-danger").trigger("click")
  await flushPromises()
  expect(wrapper.get("dialog [role=alert]").text()).toContain("Machine disconnected")
  expect(wrapper.find('[data-mcp-server="server-1"]').exists()).toBe(true)
  await wrapper.get("dialog .ui-button-danger").trigger("click")
  await flushPromises()
  expect(wrapper.find("dialog").exists()).toBe(false)
  expect(wrapper.find('[data-mcp-server="server-1"]').exists()).toBe(false)
  expect(wrapper.findAll("[data-mcp-server]")).toHaveLength(0)
})

test("losing the machine connection disables editing and saving an open form", async () => {
  const { wrapper, account, rpc } = await setup([server])
  await wrapper.get("[data-mcp-edit]").trigger("click")
  account.machines.value[0]!.online = false
  await flushPromises()
  expect(wrapper.get("[data-mcp-save]").attributes("disabled")).toBeDefined()
  expect(wrapper.get("[data-mcp-toggle]").attributes("disabled")).toBeDefined()
  await wrapper.get("dialog form").trigger("submit")
  expect(rpc.mock.calls.filter(([, method]) => method === "mcpServerUpdate")).toHaveLength(0)
})
