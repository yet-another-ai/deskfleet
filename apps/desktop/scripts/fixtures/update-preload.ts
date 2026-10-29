import { contextBridge } from "electron"
import type { CentralApi } from "../../../../packages/client/src/central.ts"
import { desktopApi } from "../../src/preload/api.ts"
import { isMainRendererUrl } from "../../src/shared/renderer-security.ts"

// Only unrelated machine/account services are fixtures; updates and appearance use real IPC.
const api = desktopApi()
api.desktop.target = async () => ({ id: "local-daemon", name: "Development computer", online: true, desktop: false })
api.catalog.list = async () => ({ teamId: "1", machineId: "1", machineName: "Development computer", sessions: [], workspaces: [
  { id: "1", name: "DeskFleet", worktrees: [{ id: "1", workspaceId: "1", directories: [{ path: "/projects/deskfleet" }] }] },
] })
api.terminal.list = async () => []
api.agent.history = {
  available: () => false,
  list: async () => [],
  events: async () => [],
  snapshot: async () => { throw new Error("No conversations in the update fixture") },
}
api.providers.list = async () => ({ revision: "updates-smoke", templates: [], providers: [] })
api.settings.get = async () => ({ enabled: false, status: "stopped" })
api.settings.getLaunchAtStartup = async () => ({ available: false, enabled: false })
api.settings.getKeepAwake = async () => ({ enabled: false })
api.settings.getWorktreeRoot = async () => ({ root: null, defaultRoot: "/projects/worktrees" })
if (process.argv.includes("--updates-account")) {
  api.central = {
    status: async () => ({ serverUrl: "https://fleet.example", siteAdmin: false, user: { id: "user-1", name: "Ada", email: "ada@example.test" } }),
    site: async () => ({ siteName: "DeskFleet", announcement: "", allowTeamCreation: true, termsOfServiceUrl: "", privacyTermsUrl: "" }),
    teams: async () => [{ id: "team-1", name: "Design team", role: "admin" }],
    machines: async () => [],
    members: async () => [],
    onEvent: () => () => {},
  } as unknown as CentralApi
}
if (isMainRendererUrl(globalThis.location.href)) contextBridge.exposeInMainWorld("deskfleet", api)
