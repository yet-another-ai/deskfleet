import { afterEach } from "vitest"
import type { DeskfleetDesktopApi } from "../../../shared/desktop-api.ts"

const api: DeskfleetDesktopApi = {
  platform: "linux",
  locale: "en-US",
  agents: {
    configuration: async () => { throw new Error("Agent unavailable") },
  },
  settings: {
    get: async () => ({ enabled: true, status: "stopped" }),
    setLocalAgentEnabled: async (enabled) => ({ enabled, status: enabled ? "running" : "stopped" }),
    onChanged: () => () => {},
  },
  catalog: {
    list: async () => { throw new Error("Daemon unavailable") },
    createWorkspace: async () => { throw new Error("Daemon unavailable") },
    updateWorkspace: async () => { throw new Error("Daemon unavailable") },
    deleteWorkspace: async () => { throw new Error("Daemon unavailable") },
    onChanged: () => () => {},
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
    capabilities: async () => ({ displays: [], codecs: [], audio: false }),
    offer: async () => { throw new Error("Daemon unavailable") },
    candidate: async () => {},
    start: async () => {},
    close: async () => {},
    onEvent: () => () => {},
  },
}

Object.defineProperty(window, "deskfleet", { configurable: true, value: api })

afterEach(() => {
  document.body.innerHTML = ""
})
