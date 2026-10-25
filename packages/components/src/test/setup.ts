import { configureClient } from "@deskfleet/client/platform"
import { afterEach } from "vitest"
import type { DeskfleetDesktopApi } from "../../../client/src/desktop-api.ts"
import { loadProviderIcons } from "../services/provider-icons.ts"

const api: DeskfleetDesktopApi = {
  platform: "linux",
  locale: "en-US",
  providers: {
    list: async () => ({
      templates: [{ id: "codex", name: "Codex", defaultBinaryPath: "codex" }, { id: "claude-code", name: "Claude Code", defaultBinaryPath: "claude" }, { id: "cursor", name: "Cursor", defaultBinaryPath: "agent" }, { id: "grok", name: "Grok", defaultBinaryPath: "grok" }, { id: "acp", name: "ACP", defaultBinaryPath: "acp-agent" }],
      providers: [{ id: "codex", template: "codex", name: "Codex", env: {} }],
    }),
    create: async () => { throw new Error("Daemon unavailable") },
    update: async () => { throw new Error("Daemon unavailable") },
    remove: async () => { throw new Error("Daemon unavailable") },
    test: async () => { throw new Error("Daemon unavailable") },
    onChanged: () => () => {},
  },
  agent: {
    offer: async () => { throw new Error("Daemon unavailable") },
    candidate: async () => {},
    close: async () => {},
    onEvent: () => () => {},
  },
  settings: {
    get: async () => ({ enabled: true, status: "stopped" }),
    setLocalAgentEnabled: async (enabled) => ({ enabled, status: enabled ? "running" : "stopped" }),
    getLaunchAtStartup: async () => ({ available: false, enabled: false }),
    setLaunchAtStartup: async (enabled) => ({ available: true, enabled }),
    getKeepAwake: async () => ({ enabled: false }),
    setKeepAwake: async (enabled) => ({ enabled }),
    getWorktreeRoot: async () => ({ root: null, defaultRoot: "/home/user/.deskfleet/worktrees" }),
    setWorktreeRoot: async (root) => ({ root, defaultRoot: "/home/user/.deskfleet/worktrees" }),
    chooseWorktreeRoot: async () => null,
    getNotifications: async () => ({ enabled: true, taskCompleted: true, taskNeedsInput: true }),
    setNotifications: async (settings) => settings,
    onChanged: () => () => {},
  },
  catalog: {
    list: async () => { throw new Error("Daemon unavailable") },
    createWorkspace: async () => { throw new Error("Daemon unavailable") },
    updateWorkspace: async () => { throw new Error("Daemon unavailable") },
    deleteWorkspace: async () => { throw new Error("Daemon unavailable") },
    onChanged: () => () => {},
  },
  filesystem: {
    listDirectories: async () => { throw new Error("Daemon unavailable") },
  },
  terminal: {
    list: async () => [],
    dial: async () => { throw new Error("Daemon unavailable") },
    hangup: async () => {},
    onSessionEvent: () => () => {},
    offer: async () => { throw new Error("Daemon unavailable") },
    candidate: async () => {},
    close: async () => {},
    onEvent: () => () => {},
  },
  desktop: {
    target: async () => ({ id: "local-daemon", name: "localhost", online: false, desktop: false }),
    capabilities: async () => ({ displays: [], audio: false }),
    offer: async () => { throw new Error("Daemon unavailable") },
    candidate: async () => {},
    start: async () => {},
    close: async () => {},
    onEvent: () => () => {},
  },
}

configureClient(api)
// Icon chunks are hundreds of SVG modules. Finish that import before a worker exits.
await loadProviderIcons()

afterEach(() => {
  document.body.innerHTML = ""
})
