import { getClient } from "@deskfleet/client/platform"
import type { McpServerConfig, McpServerInput } from "@deskfleet/client/mcp-servers"
import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { nextTick, provide } from "vue"
import type { AgentProviderConfig, ProviderMcpServerDiscovery } from "../../../../../apps/daemon/src/provider-protocol.ts"
import { accountSessionKey, useAccountSession } from "../../composables/useAccountSession.ts"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import ProviderMcpImportDialog from "./ProviderMcpImportDialog.vue"

const provider: AgentProviderConfig = { id: "codex-work", name: "Codex", template: "codex", env: {} }
const candidates: ProviderMcpServerDiscovery["candidates"] = [
  { id: "github", name: "GitHub", source: "/Users/ada/.codex/config.toml", scope: "user", server: { name: "GitHub", enabled: true, transport: "http", url: "https://mcp.example.test/github", headers: {} } },
  { id: "docs", name: "Project docs", source: "/Users/ada/Projects/team-website/.codex/config.toml", scope: "project", projectPath: "/Users/ada/Projects/team-website", server: { name: "Project docs", enabled: true, transport: "stdio", command: "/usr/local/bin/docs-mcp", args: [], env: {} } },
  { id: "browser", name: "Browser tools", source: "/Users/ada/.codex/config.toml", scope: "user", unsupportedReason: "This server requires an Agent-managed OAuth login. Configure its credentials in DeskFleet before adding it." },
]
type Scenario = "ready" | "mixed" | "loading" | "error" | "empty" | "partial"
const meta = {
  title: "Settings/ProviderMcpImportDialog",
  args: { scenario: "ready", sourcePicker: false },
  render: args => ({
    components: { ProviderMcpImportDialog },
    setup() {
      const base = getClient()
      const account = useAccountSession()!
      const servers: McpServerConfig[] = args.scenario === "mixed" ? [{ ...candidates[0]!.server!, id: "existing" }] : []
      let creates = 0
      provide(platformClientKey, {
        ...base,
        providers: {
          ...base.providers,
          list: async () => ({ revision: "story", templates: [], shellEnvironmentDefault: false, providers: [provider, { id: "claude-work", name: "Claude Code", template: "claude-code", env: {} }] }),
          discoverMcpServers: async () => {
            if (args.scenario === "loading") return new Promise(() => {})
            if (args.scenario === "error") throw new Error("Could not read Agent configuration. Check the machine connection and try again.")
            return { supported: true, candidates: args.scenario === "empty" ? [] : structuredClone(args.scenario === "mixed" ? candidates : candidates.slice(0, 2)), warnings: [] }
          },
        },
      })
      provide(accountSessionKey, {
        ...account,
        central: { ...account.central, rpc: async <T,>(_team: string, _machine: string, method: string, params: unknown): Promise<T> => {
          if (method === "mcpServerList") return { revision: "story", servers: structuredClone(servers) } as T
          if (method === "mcpServerCreate") {
            creates++
            if (args.scenario === "partial" && creates === 2) throw new Error("Could not save this server. Try importing it again.")
            const created = { ...(params as { server: McpServerInput }).server, id: `new-${creates}` }
            servers.push(created)
            return created as T
          }
          throw new Error(`Unexpected story RPC: ${method}`)
        } },
      })
      return { args, provider }
    },
    template: '<ProviderMcpImportDialog :provider="args.sourcePicker ? undefined : provider" machine-name="MacBook Pro" />',
  }),
} satisfies Meta<{ scenario: Scenario; sourcePicker: boolean }>
export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {}
export const Mixed: Story = { args: { scenario: "mixed" } }
export const SourcePicker: Story = { args: { sourcePicker: true } }
export const Loading: Story = { args: { scenario: "loading" } }
export const Failed: Story = { args: { scenario: "error" } }
export const Empty: Story = { args: { scenario: "empty" } }
export const Partial: Story = {
  args: { scenario: "partial" },
  play: async ({ canvasElement }) => {
    const page = canvasElement.ownerDocument
    for (let attempt = 0; attempt < 40; attempt++) {
      if (page.querySelectorAll('[data-mcp-import-candidate] [role="checkbox"]').length === 2) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    for (const checkbox of page.querySelectorAll<HTMLButtonElement>('[data-mcp-import-candidate] [role="checkbox"]')) checkbox.click()
    await nextTick()
    page.querySelector<HTMLButtonElement>("[data-mcp-import-selected]")?.click()
  },
}
