import { configureClient } from "@deskfleet/client/platform"
import { afterEach, vi } from "vitest"
import type { DeskfleetDesktopApi } from "../../../client/src/desktop-api.ts"
import { loadProviderIcons } from "../services/provider-icons.ts"

if (document.compatMode !== "CSS1Compat") {
  Object.defineProperty(document, "compatMode", { value: "CSS1Compat", configurable: true })
}

const api: DeskfleetDesktopApi = {
  platform: "linux",
  locale: "en-US",
  providers: {
    list: async () => ({
      revision: "test-settings",
      shellEnvironmentDefault: true,
      templates: [{ id: "codex", name: "Codex", defaultBinaryPath: "codex" }, { id: "claude-code", name: "Claude Code", defaultBinaryPath: "claude" }, { id: "cursor", name: "Cursor", defaultBinaryPath: "agent" }, { id: "grok", name: "Grok", defaultBinaryPath: "grok" }, { id: "pi", name: "Pi Coding Agent", defaultBinaryPath: "pi" }, { id: "omp", name: "Oh My Pi", defaultBinaryPath: "omp" }, { id: "deepseek-harness", name: "DeepSeek Harness", defaultBinaryPath: "dsh" }, { id: "antigravity", name: "Antigravity", defaultBinaryPath: "agy_acp_server.par" }, { id: "acp", name: "ACP", defaultBinaryPath: "acp-agent" }],
      providers: [{ id: "codex", template: "codex", name: "Codex", env: {} }],
    }),
    create: async () => { throw new Error("Daemon unavailable") },
    update: async () => { throw new Error("Daemon unavailable") },
    remove: async () => { throw new Error("Daemon unavailable") },
    test: async () => { throw new Error("Daemon unavailable") },
    probe: async () => ({ status: "missing", auth: "unknown", installable: true, loginAvailable: false }),
    install: async () => { throw new Error("Daemon unavailable") },
    login: async () => { throw new Error("Daemon unavailable") },
    onChanged: () => () => {},
  },
  agent: {
    offer: async () => { throw new Error("Daemon unavailable") },
    candidate: async () => {},
    close: async () => {},
    onEvent: () => () => {},
  },
  files: {
    list: async () => { throw new Error("Daemon unavailable") },
    chooseLocalDirectory: async () => null,
    enqueue: async () => { throw new Error("Daemon unavailable") },
    transfers: async () => [],
    cancel: async () => { throw new Error("Daemon unavailable") },
    retry: async () => { throw new Error("Daemon unavailable") },
    onChanged: () => () => {},
    resolveResource: async () => { throw new Error("Daemon unavailable") },
    readResource: async () => { throw new Error("Daemon unavailable") },
    saveResource: async () => null,
    uploadAttachment: async () => { throw new Error("Daemon unavailable") },
  },
  settings: {
    get: async () => ({ enabled: true, status: "stopped" }),
    setLocalAgentEnabled: async (enabled) => ({ enabled, status: enabled ? "running" : "stopped" }),
    getLaunchAtStartup: async () => ({ available: false, enabled: false }),
    setLaunchAtStartup: async (enabled) => ({ available: true, enabled }),
    getKeepAwake: async () => ({ enabled: false }),
    getRemoteAgentSettings: async () => ({ allowRead: false, allowOperate: false }),
    setRemoteAgentSettings: async (settings) => settings,
    setKeepAwake: async (enabled) => ({ enabled }),
    getAutoDownloadUpdates: async () => ({ enabled: true }),
    setAutoDownloadUpdates: async (enabled) => ({ enabled }),
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
// Avatars probe Gravatar with an image element. Default to a miss so unrelated tests keep initials.
vi.stubGlobal("Image", class {
  referrerPolicy = ""
  onload: (() => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  set src(_url: string) {
    queueMicrotask(() => this.onerror?.(new Event("error")))
  }
})
// Keep accidental renderer fetches local; avatars no longer use fetch for Gravatar.
vi.stubGlobal("fetch", vi.fn(async () => new Response("404 Not Found", { status: 404, headers: { "content-type": "text/html" } })))
// Icon chunks are hundreds of SVG modules. Finish that import before a worker exits.
await loadProviderIcons()

afterEach(() => {
  document.body.innerHTML = ""
})
