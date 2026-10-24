import { contextBridge, ipcRenderer } from "electron"
import { DESKTOP_MEDIA_CHANNEL, DESKTOP_MEDIA_EVENT, type DesktopEvent, type DesktopMediaResult } from "../shared/desktop-media.ts"
import type { DeskfleetDesktopApi } from "../shared/desktop-api.ts"
import { DEFAULT_LOCALE, isAppLocale, LOCALE_ARGUMENT_PREFIX } from "../shared/i18n.ts"
import { isMainRendererUrl } from "../shared/renderer-security.ts"
import { TERMINAL_SESSION_EVENT, type TerminalSessionEvent } from "../shared/terminal.ts"
import { CATALOG_CHANGED_EVENT } from "../shared/catalog.ts"
import { SETTINGS_CHANNEL, SETTINGS_CHANGED_EVENT, type LocalAgentState, type LocalAgentSettingsResult } from "../shared/local-agent.ts"

const locale = process.argv
  .find((argument) => argument.startsWith(LOCALE_ARGUMENT_PREFIX))
  ?.slice(LOCALE_ARGUMENT_PREFIX.length)

async function invokeDesktop<T>(method: string, params?: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(DESKTOP_MEDIA_CHANNEL, method, params) as DesktopMediaResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.value
}

async function invokeSettings(method: "get" | "setLocalAgentEnabled", enabled?: boolean): Promise<LocalAgentState> {
  const result = await ipcRenderer.invoke(SETTINGS_CHANNEL, method, enabled) as LocalAgentSettingsResult<LocalAgentState>
  if (!result.ok) throw new Error(result.error)
  return result.value
}

const api: DeskfleetDesktopApi = {
  platform: process.platform as DeskfleetDesktopApi["platform"],
  locale: isAppLocale(locale) ? locale : DEFAULT_LOCALE,
  settings: {
    get: () => invokeSettings("get"),
    setLocalAgentEnabled: (enabled) => invokeSettings("setLocalAgentEnabled", enabled),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: LocalAgentState) => listener(state)
      ipcRenderer.on(SETTINGS_CHANGED_EVENT, handler)
      return () => ipcRenderer.removeListener(SETTINGS_CHANGED_EVENT, handler)
    },
  },
  agents: {
    configuration: (params) => invokeDesktop("agentConfiguration", params),
  },
  catalog: {
    list: () => invokeDesktop("catalogList", {}),
    createWorkspace: (name, directories) => invokeDesktop("workspaceCreate", { name, directories }),
    updateWorkspace: (workspaceId, name, directories) => invokeDesktop("workspaceUpdate", { workspaceId, name, directories }),
    deleteWorkspace: (workspaceId) => invokeDesktop("workspaceDelete", { workspaceId }),
    onChanged: (listener) => {
      const handler = () => listener()
      ipcRenderer.on(CATALOG_CHANGED_EVENT, handler)
      return () => ipcRenderer.removeListener(CATALOG_CHANGED_EVENT, handler)
    },
  },
  terminal: {
    list: () => invokeDesktop("terminalList", {}),
    dial: (options) => invokeDesktop("terminalDial", options),
    hangup: (terminalId) => invokeDesktop("terminalHangup", { terminalId }),
    onSessionEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, event: TerminalSessionEvent) => listener(event)
      ipcRenderer.on(TERMINAL_SESSION_EVENT, handler)
      return () => ipcRenderer.removeListener(TERMINAL_SESSION_EVENT, handler)
    },
    offer: (options) => invokeDesktop("terminalOffer", options),
    candidate: (sessionId, candidate) => invokeDesktop("candidate", { sessionId, candidate }),
    close: (sessionId) => invokeDesktop("close", { sessionId }),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, event: DesktopEvent) => listener(event)
      ipcRenderer.on(DESKTOP_MEDIA_EVENT, handler)
      return () => ipcRenderer.removeListener(DESKTOP_MEDIA_EVENT, handler)
    },
  },
  desktop: {
    target: () => invokeDesktop("target"),
    capabilities: () => invokeDesktop("capabilities"),
    offer: (options) => invokeDesktop("offer", options),
    candidate: (sessionId, candidate) => invokeDesktop("candidate", { sessionId, candidate }),
    start: (options) => invokeDesktop("start", options),
    close: (sessionId) => invokeDesktop("close", { sessionId }),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, event: DesktopEvent) => listener(event)
      ipcRenderer.on(DESKTOP_MEDIA_EVENT, handler)
      return () => ipcRenderer.removeListener(DESKTOP_MEDIA_EVENT, handler)
    },
  },
}

if (isMainRendererUrl(globalThis.location.href)) {
  contextBridge.exposeInMainWorld("deskfleet", api)
}
