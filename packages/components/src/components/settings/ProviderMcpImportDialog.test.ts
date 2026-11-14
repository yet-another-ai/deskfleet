import { client } from "@deskfleet/client/platform"
import type { McpServerConfig, McpServerInput } from "@deskfleet/client/mcp-servers"
import type { AgentProviderConfig, ProviderMcpServerDiscovery } from "../../../../../apps/daemon/src/provider-protocol.ts"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import { selectOption } from "../../test/controls.ts"
import ProviderMcpImportDialog from "./ProviderMcpImportDialog.vue"

vi.mock("../../stores/fleet.ts", () => ({ useFleetStore: () => ({ targetId: "machine-1" }) }))
const codex: AgentProviderConfig = { id: "codex-work", name: "Work Codex", template: "codex", env: {} }
const claude: AgentProviderConfig = { id: "claude-work", name: "Claude Code", template: "claude-code", env: {} }
const server: McpServerInput = { name: "GitHub", enabled: true, transport: "http", url: "https://mcp.example.test/tools?token=query-secret", headers: { Authorization: "Bearer header-secret" } }
const discovery: ProviderMcpServerDiscovery = { supported: true, warnings: [], candidates: [
  { id: "github", name: "GitHub", scope: "user", source: "config.toml", server },
  { id: "files", name: "Files", scope: "project", projectPath: "/code/app", source: "/code/app/.mcp.json", server: { name: "Files", enabled: false, transport: "stdio", command: "/tools/mcp", args: ["--token", "argument-secret"], env: { TOKEN: "environment-secret" } } },
  { id: "unsupported", name: "Browser login", scope: "user", source: "config.toml", unsupportedReason: "OAuth credentials cannot be imported." },
] }
let wrapper: VueWrapper | undefined
let account: AccountSession
let servers: McpServerConfig[]
let create: ReturnType<typeof vi.fn<(input: McpServerInput) => Promise<McpServerConfig>>>
let rpc: ReturnType<typeof vi.fn>
const row = (view: VueWrapper, id: string) => view.get(`[data-mcp-import-candidate="${id}"]`)
const button = (view: VueWrapper, text: string) => view.findAll("button").find(value => value.text() === text)!

beforeEach(async () => {
  servers = []
  create = vi.fn(async input => {
    const created = { ...input, id: `server-${servers.length + 1}` }
    servers.push(created)
    return created
  })
  const fake = fakeCentral({ machines: [machineFixture("machine-1", "team-1", "Build machine"), machineFixture("machine-2", "team-1", "Other machine")] })
  rpc = vi.fn(async (_team: string, _machine: string, method: string, params: Record<string, unknown>) => {
    if (method === "mcpServerList") return { revision: "1", servers: structuredClone(servers) }
    if (method === "mcpServerCreate") return create(params.server as McpServerInput)
    throw new Error(`Unexpected RPC: ${method}`)
  })
  fake.central.rpc = rpc as typeof fake.central.rpc
  account = createAccountSession(fake.central)
  await flushPromises()
  vi.spyOn(client.providers, "discoverMcpServers").mockResolvedValue(structuredClone(discovery))
  vi.spyOn(client.providers, "list").mockResolvedValue({ revision: "1", templates: [], shellEnvironmentDefault: false, providers: [codex, claude, { id: "custom", name: "Custom ACP", template: "acp", env: {} }] })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; account.dispose(); vi.restoreAllMocks() })

async function render(provider: AgentProviderConfig | null = codex) {
  wrapper = mount(ProviderMcpImportDialog, {
    props: { provider: provider ?? undefined, machineName: "Build machine" }, attachTo: document.body,
    global: { stubs: { teleport: { inheritAttrs: false, template: "<slot />" } }, plugins: [i18n], provide: { [accountSessionKey as symbol]: account } },
  })
  await flushPromises()
  return wrapper
}

test("shows unchecked scoped candidates and unsupported reasons without exposing credentials", async () => {
  const view = await render()
  expect(client.providers.discoverMcpServers).toHaveBeenCalledExactlyOnceWith("codex-work")
  expect(rpc).toHaveBeenCalledWith("team-1", "machine-1", "mcpServerList", {})
  expect(view.text()).toContain("all Agents for this machine in the current Team")
  expect(row(view, "files").text()).toContain("Project configuration")
  expect(row(view, "files").text()).toContain("/code/app")
  expect(row(view, "files").text()).toContain("Disabled")
  expect(row(view, "unsupported").text()).toContain("OAuth credentials cannot be imported")
  expect(row(view, "unsupported").get('[role="checkbox"]').attributes("disabled")).toBeDefined()
  expect(view.findAll('[role="checkbox"]').every(checkbox => checkbox.attributes("aria-checked") === "false")).toBe(true)
  for (const secret of ["query-secret", "header-secret", "argument-secret", "environment-secret", "Authorization", "https://mcp.example.test"]) expect(view.html()).not.toContain(secret)
  await view.get("[data-mcp-import-close]").trigger("click")
  await vi.waitFor(() => expect(view.emitted("close")).toHaveLength(1))
  expect(create).not.toHaveBeenCalled()
})

test("renames case-insensitive existing names and preserves imported transport values exactly", async () => {
  servers = [{ ...server, id: "existing", name: "github" }]
  const view = await render()
  expect(row(view, "github").get('[role="checkbox"]').attributes("disabled")).toBeDefined()
  expect(row(view, "github").text()).toContain("already exists")
  await row(view, "github").get("input.ui-input").setValue("GitHub work")
  await row(view, "github").get('[role="checkbox"]').trigger("click")
  await view.get("[data-mcp-import-selected]").trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledExactlyOnceWith({ ...server, name: "GitHub work" })
  expect(rpc).toHaveBeenCalledWith("team-1", "machine-1", "mcpServerCreate", { server: { ...server, name: "GitHub work" } })
  expect(row(view, "github").text()).toContain("Imported")
  expect(view.emitted("imported")).toHaveLength(1)
})

test("keeps partial successes and retries only failed selected servers", async () => {
  create.mockRejectedValueOnce(new Error("Could not save MCP settings"))
  const view = await render()
  await row(view, "github").get('[role="checkbox"]').trigger("click")
  await row(view, "files").get('[role="checkbox"]').trigger("click")
  await view.get("[data-mcp-import-selected]").trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledTimes(2)
  expect(row(view, "github").get('[role="alert"]').text()).toBe("Could not save MCP settings")
  expect(row(view, "files").text()).toContain("Imported")
  expect(row(view, "files").get('[role="checkbox"]').attributes("disabled")).toBeDefined()
  expect(view.get("[data-mcp-import-selected]").attributes("disabled"), view.text()).toBeUndefined()
  await view.get("[data-mcp-import-selected]").trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledTimes(3)
  expect(create).toHaveBeenLastCalledWith(server)
  expect(view.text()).toContain("2 MCP servers imported")
})

test("reconnecting during a create preserves reviewed rows and requires an explicit retry for the remaining imports", async () => {
  let finish!: () => void
  create.mockImplementationOnce(input => new Promise(resolve => {
    finish = () => {
      const created = { ...input, id: "in-flight" }
      servers.push(created)
      resolve(created)
    }
  }))
  const view = await render()
  await row(view, "github").get("input.ui-input").setValue("GitHub work")
  await row(view, "files").get("input.ui-input").setValue("Project files")
  await row(view, "github").get('[role="checkbox"]').trigger("click")
  await row(view, "files").get('[role="checkbox"]').trigger("click")
  await view.get("[data-mcp-import-selected]").trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledTimes(1)

  account.machines.value[0]!.online = false
  await flushPromises()
  expect((row(view, "github").get("input.ui-input").element as HTMLInputElement).value).toBe("GitHub work")
  expect((row(view, "files").get("input.ui-input").element as HTMLInputElement).value).toBe("Project files")
  account.machines.value[0]!.online = true
  await flushPromises()
  expect(client.providers.discoverMcpServers).toHaveBeenCalledOnce()

  finish()
  await flushPromises()
  expect(create).toHaveBeenCalledTimes(1)
  expect(row(view, "github").text()).toContain("Imported")
  expect(row(view, "github").get('[role="checkbox"]').attributes("disabled")).toBeDefined()
  expect(row(view, "files").get('[role="checkbox"]').attributes("aria-checked")).toBe("true")
  expect(view.text()).toContain("1 MCP server imported")

  const reads = rpc.mock.calls.filter(([, , method]) => method === "mcpServerList").length
  await view.get("[data-mcp-import-selected]").trigger("click")
  await flushPromises()
  expect(rpc.mock.calls.filter(([, , method]) => method === "mcpServerList")).toHaveLength(reads + 1)
  expect(create).toHaveBeenCalledTimes(2)
  expect(create).toHaveBeenLastCalledWith({ ...discovery.candidates[1]!.server!, name: "Project files" })
  expect(view.text()).toContain("2 MCP servers imported")
  expect(client.providers.discoverMcpServers).toHaveBeenCalledOnce()
})

test("a brief disconnect while checking existing names stops the batch even after connectivity returns", async () => {
  const view = await render()
  let finish!: () => void
  rpc.mockImplementationOnce(() => new Promise(resolve => {
    finish = () => resolve({ revision: "1", servers: [] })
  }))
  await row(view, "github").get('[role="checkbox"]').trigger("click")
  await view.get("[data-mcp-import-selected]").trigger("click")
  await flushPromises()
  // Both transitions occur before Vue's next render, while the list read is pending.
  account.machines.value[0]!.online = false
  account.machines.value[0]!.online = true
  finish()
  await flushPromises()
  expect(create).not.toHaveBeenCalled()
  expect(row(view, "github").get('[role="checkbox"]').attributes("aria-checked")).toBe("true")
  expect(client.providers.discoverMcpServers).toHaveBeenCalledOnce()
  await view.get("[data-mcp-import-selected]").trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledExactlyOnceWith(server)
})

test("rechecks names before import and blocks duplicates among selected candidates", async () => {
  const view = await render()
  await row(view, "github").get('[role="checkbox"]').trigger("click")
  await row(view, "files").get("input.ui-input").setValue("GITHUB")
  expect(row(view, "files").get('[role="checkbox"]').attributes("disabled")).toBeDefined()
  await row(view, "files").get("input.ui-input").setValue("Files")
  servers.push({ ...server, id: "added-elsewhere" })
  await view.get("[data-mcp-import-selected]").trigger("click")
  await flushPromises()
  expect(create).not.toHaveBeenCalled()
  expect(row(view, "github").text()).toContain("already exists")
  await row(view, "github").get("input.ui-input").setValue("deskfleet")
  expect(row(view, "github").text()).toContain("reserved")
})

test("discovery errors retry and empty or unsupported results remain dismissible", async () => {
  vi.mocked(client.providers.discoverMcpServers).mockRejectedValueOnce(new Error("Could not read Agent configuration"))
  const view = await render()
  expect(view.get('[role="alert"]').text()).toBe("Could not read Agent configuration")
  vi.mocked(client.providers.discoverMcpServers).mockResolvedValue({ supported: false, candidates: [], warnings: [] })
  await button(view, "Retry").trigger("click")
  await flushPromises()
  expect(view.text()).toContain("MCP import is not available")
  expect(view.get("[data-mcp-import-close]").attributes("disabled")).toBeUndefined()
})

test("changing the source Agent discards a late discovery response", async () => {
  let finish!: (value: ProviderMcpServerDiscovery) => void
  vi.mocked(client.providers.discoverMcpServers).mockImplementation(id => id === codex.id ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ supported: true, candidates: [], warnings: [] }))
  const view = await render(null)
  await selectOption(view, '[role="combobox"][aria-label="Source Agent"]', "Claude Code")
  expect(client.providers.discoverMcpServers).toHaveBeenLastCalledWith(claude.id)
  finish(structuredClone(discovery))
  await flushPromises()
  expect(view.findAll("[data-mcp-import-candidate]")).toHaveLength(0)
  expect(view.text()).toContain("No MCP servers found")
})

for (const scope of ["machine", "team"] as const) test(`changing ${scope} closes the dialog and stops remaining imports`, async () => {
  let finish!: () => void
  create.mockImplementationOnce(input => new Promise(resolve => { finish = () => resolve({ ...input, id: "in-flight" }) }))
  const view = await render()
  await row(view, "github").get('[role="checkbox"]').trigger("click")
  await row(view, "files").get('[role="checkbox"]').trigger("click")
  await view.get("[data-mcp-import-selected]").trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledTimes(1)
  if (scope === "machine") account.machineId.value = "machine-2"
  else account.teamId.value = "team-2"
  finish()
  await flushPromises()
  expect(create).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(view.emitted("close")).toHaveLength(1))
})

test("offline status prevents importing and leaving stops pending batch work", async () => {
  const view = await render()
  await row(view, "github").get('[role="checkbox"]').trigger("click")
  account.machines.value[0]!.online = false
  await flushPromises()
  expect(view.text()).toContain("offline")
  expect(create).not.toHaveBeenCalled()
  view.unmount()
  wrapper = undefined
})
