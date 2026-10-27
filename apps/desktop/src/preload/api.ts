import type { CentralApi } from "@deskfleet/client/central"
import { ipcRenderer } from "electron"
import { DESKTOP_MEDIA_CHANNEL, DESKTOP_MEDIA_EVENT, type DesktopEvent, type DesktopMediaResult, type IceCandidate } from "../../../../packages/client/src/desktop-media.ts"
import type { DeskfleetDesktopApi } from "../../../../packages/client/src/desktop-api.ts"
import { DEFAULT_LOCALE, isAppLocale, LOCALE_ARGUMENT_PREFIX } from "../../../../packages/client/src/i18n.ts"
import { TERMINAL_SESSION_EVENT, type TerminalSessionEvent } from "../../../../packages/client/src/terminal.ts"
import { CATALOG_CHANGED_EVENT } from "../../../../packages/client/src/catalog.ts"
import { PROVIDERS_CHANGED_EVENT } from "../../../../packages/client/src/providers.ts"
import type { LocalAgentState } from "../../../../packages/client/src/local-agent.ts"
import { SETTINGS_CHANNEL, SETTINGS_CHANGED_EVENT, type SettingsResult } from "../../../../packages/client/src/settings.ts"
import { filesApi } from "./files.ts"
import { onboardingApi } from "./onboarding.ts"
import { appearanceApi } from "./appearance.ts"

const locale = process.argv
  .find((argument) => argument.startsWith(LOCALE_ARGUMENT_PREFIX))
  ?.slice(LOCALE_ARGUMENT_PREFIX.length)

async function invokeDesktop<T>(method: string, params?: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(DESKTOP_MEDIA_CHANNEL, method, params) as DesktopMediaResult<T>
  if (!result.ok) {
    const error = new Error(result.error)
    if (result.reason === "encoder") (error as Error & { reason?: "encoder" }).reason = "encoder"
    throw error
  }
  return result.value
}

async function invokeSettings<T>(method: "get" | "setLocalAgentEnabled" | "getLaunchAtStartup" | "setLaunchAtStartup" | "getKeepAwake" | "setKeepAwake" | "getWorktreeRoot" | "setWorktreeRoot" | "chooseWorktreeRoot" | "getNotifications" | "setNotifications", value?: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(SETTINGS_CHANNEL, method, value) as SettingsResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.value
}

const peerSignaling = {
  candidate: (sessionId: string, candidate: IceCandidate) => invokeDesktop<void>("candidate", { sessionId, candidate }),
  close: (sessionId: string) => invokeDesktop<void>("close", { sessionId }),
  onEvent: (listener: (event: DesktopEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: DesktopEvent) => listener(event)
    ipcRenderer.on(DESKTOP_MEDIA_EVENT, handler)
    return () => ipcRenderer.removeListener(DESKTOP_MEDIA_EVENT, handler)
  },
}

export function desktopApi(central?: CentralApi): DeskfleetDesktopApi {
return {
  ...(central ? { central, onboarding: onboardingApi() } : {}),
  platform: process.platform as DeskfleetDesktopApi["platform"],
  locale: isAppLocale(locale) ? locale : DEFAULT_LOCALE,
  appearance: appearanceApi(),
  files: filesApi(),
  settings: {
    get: () => invokeSettings("get"),
    setLocalAgentEnabled: (enabled) => invokeSettings("setLocalAgentEnabled", enabled),
    getLaunchAtStartup: () => invokeSettings("getLaunchAtStartup"),
    setLaunchAtStartup: (enabled) => invokeSettings("setLaunchAtStartup", enabled),
    getKeepAwake: () => invokeSettings("getKeepAwake"),
    setKeepAwake: (enabled) => invokeSettings("setKeepAwake", enabled),
    getWorktreeRoot: () => invokeSettings("getWorktreeRoot"),
    setWorktreeRoot: (root) => invokeSettings("setWorktreeRoot", root),
    chooseWorktreeRoot: () => invokeSettings("chooseWorktreeRoot"),
    getNotifications: () => invokeSettings("getNotifications"),
    setNotifications: (settings) => invokeSettings("setNotifications", settings),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: LocalAgentState) => listener(state)
      ipcRenderer.on(SETTINGS_CHANGED_EVENT, handler)
      return () => ipcRenderer.removeListener(SETTINGS_CHANGED_EVENT, handler)
    },
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
  filesystem: {
    listDirectories: (path) => invokeDesktop("directoryList", path === undefined ? {} : { path }),
  },
  system: { status: () => invokeDesktop("systemStatus", {}) },
  providers: {
    list: () => invokeDesktop("providerList", {}),
    create: (provider) => invokeDesktop("providerCreate", { provider }),
    update: (providerId, changes) => invokeDesktop("providerUpdate", { providerId, changes }),
    remove: (providerId) => invokeDesktop("providerRemove", { providerId }),
    test: (provider) => invokeDesktop("providerTest", { provider }),
    probe: (provider) => invokeDesktop("providerProbe", { provider }),
    install: (provider) => invokeDesktop("providerInstall", { provider }),
    login: (provider) => invokeDesktop("providerLogin", { provider }),
    onChanged: (listener) => {
      const handler = () => listener()
      ipcRenderer.on(PROVIDERS_CHANGED_EVENT, handler)
      return () => ipcRenderer.removeListener(PROVIDERS_CHANGED_EVENT, handler)
    },
  },
  agent: {
    offer: (options) => invokeDesktop("agentOffer", options),
    ...peerSignaling,
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
    ...peerSignaling,
  },
  desktop: {
    target: () => invokeDesktop("target"),
    capabilities: () => invokeDesktop("capabilities"),
    offer: (options) => invokeDesktop("offer", options),
    start: (options) => invokeDesktop("start", options),
    ...peerSignaling,
  },
}
}
