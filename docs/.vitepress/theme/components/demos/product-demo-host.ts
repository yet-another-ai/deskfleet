import { configureClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { AppLocale } from "@deskfleet/client/i18n"
import type { CatalogWorkspace } from "@deskfleet/client/catalog"
import type { NotificationSettings } from "@deskfleet/client/settings"
import { AGENT_PROVIDER_TEMPLATES } from "../../../../../apps/daemon/src/provider-protocol.ts"
import { desktopPreview } from "./product-demo-media.ts"

const subscribe = () => () => {}
const unavailable = async (): Promise<never> => { throw new Error("This operation needs a connected machine.") }
const providers = AGENT_PROVIDER_TEMPLATES.filter(template => template.id !== "acp").map(template => ({
  id: template.id as string, template: template.id, name: template.name, env: {},
}))
const workspaces: CatalogWorkspace[] = []
let keepAwake = false
let worktreeRoot: string | null = null
let notifications: NotificationSettings = { enabled: true, taskCompleted: true, taskNeedsInput: true }

/** Only sample data lives here. The website mounts the unmodified application UI. */
const host: DeskfleetDesktopApi = {
  platform: "web",
  locale: "en-US",
  target: { id: "demo-machine", local: true },
  settings: {
    get: async () => ({ enabled: true, status: "running" }),
    setLocalAgentEnabled: async enabled => ({ enabled, status: enabled ? "running" : "stopped" }),
    getLaunchAtStartup: async () => ({ available: false, enabled: false }),
    setLaunchAtStartup: async () => ({ available: false, enabled: false }),
    getKeepAwake: async () => ({ enabled: keepAwake }),
    setKeepAwake: async enabled => ({ enabled: keepAwake = enabled }),
    getWorktreeRoot: async () => ({ root: worktreeRoot, defaultRoot: "/workspace/.worktrees" }),
    setWorktreeRoot: async root => ({ root: worktreeRoot = root, defaultRoot: "/workspace/.worktrees" }),
    chooseWorktreeRoot: async () => null,
    getNotifications: async () => ({ ...notifications }),
    setNotifications: async settings => { notifications = { ...settings }; return { ...notifications } },
    onChanged: subscribe,
  },
  catalog: {
    list: async () => ({ teamId: "1", machineId: "1", machineName: "Studio Mac", workspaces }),
    createWorkspace: async (name, directories) => {
      const id = String(900 + workspaces.length)
      const workspace = { id, name, worktrees: [{ id, workspaceId: id, directories }] }
      workspaces.push(workspace)
      return workspace
    },
    updateWorkspace: async (id, name, directories) => {
      const workspace = workspaces.find(workspace => workspace.id === id)
      if (!workspace) return unavailable()
      workspace.name = name
      workspace.worktrees[0]!.directories = directories
      return workspace
    },
    deleteWorkspace: async id => { const index = workspaces.findIndex(workspace => workspace.id === id); if (index >= 0) workspaces.splice(index, 1) },
    onChanged: subscribe,
  },
  filesystem: {
    listDirectories: async (path = "/workspace") => ({
      path, parentPath: path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/", homePath: "/workspace", roots: [{ name: "/", path: "/" }],
      directories: (path === "/" ? ["workspace"] : path === "/workspace" ? ["website", "api"] : [])
        .map(name => ({ name, path: `${path === "/" ? "" : path}/${name}`, hidden: false })),
    }),
  },
  providers: {
    list: async () => ({ templates: [...AGENT_PROVIDER_TEMPLATES], providers }),
    display: async () => ({ providers }),
    create: async provider => { const created = { ...provider, id: crypto.randomUUID() }; providers.push(created); return created },
    update: async (id, changes) => { const provider = providers.find(provider => provider.id === id); if (!provider) return unavailable(); Object.assign(provider, changes); return provider },
    remove: async id => { const index = providers.findIndex(provider => provider.id === id); if (index >= 0) providers.splice(index, 1) },
    test: async provider => ({ agentName: provider.name }),
    onChanged: subscribe,
  },
  agent: { offer: unavailable, candidate: async () => {}, close: async () => {}, onEvent: subscribe },
  terminal: {
    list: async () => [], dial: unavailable, hangup: async () => {}, onSessionEvent: subscribe,
    offer: unavailable, candidate: async () => {}, close: async () => {}, onEvent: subscribe,
  },
  desktop: desktopPreview,
}

export function configureProductDemoHost(locale: AppLocale): void {
  host.locale = locale
  configureClient(host)
}
