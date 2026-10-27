import { HttpCentralClient } from "./http-central.ts"
import type { DeskfleetDesktopApi } from "./desktop-api.ts"
import { resolveAppLocale } from "./i18n.ts"
import { createBrowserFiles } from "./browser-files.ts"
import { createBrowserNotificationSettings } from "./browser-notification-settings.ts"

const accountKey = "deskfleet.account"
/** The browser owns no bearer token; its login session stays in an HttpOnly cookie. */
export async function browserClient(defaultServerUrl: string): Promise<DeskfleetDesktopApi> {
  let serverUrl = defaultServerUrl
  const saved = sessionStorage.getItem(accountKey)
  if (saved) {
    try { serverUrl = (JSON.parse(saved) as { serverUrl: string }).serverUrl || defaultServerUrl } catch { /* A stale preference can be discarded. */ }
  }
  const central = new HttpCentralClient({
    account: { serverUrl }, cookieAuth: true,
    persist: async value => { sessionStorage.setItem(accountKey, JSON.stringify({ serverUrl: value.serverUrl })) },
    authorize: async () => { location.assign("/auth/login") },
    openExternal: async url => { location.assign(url) },
  })
  sessionStorage.setItem(accountKey, JSON.stringify({ serverUrl }))
  const unavailable = async (): Promise<never> => { throw new Error("Select a machine to continue") }
  const subscribe = () => () => {}
  const signaling = { offer: unavailable, candidate: unavailable, close: unavailable, onEvent: subscribe }
  return {
    platform: "web", locale: resolveAppLocale(navigator.languages), central, siteAdministration: central,
    files: createBrowserFiles(central),
    settings: {
      get: async () => ({ enabled: false, status: "stopped" }), setLocalAgentEnabled: unavailable,
      getLaunchAtStartup: async () => ({ available: false, enabled: false }), setLaunchAtStartup: unavailable,
      getKeepAwake: async () => ({ enabled: false }), setKeepAwake: unavailable,
      getWorktreeRoot: unavailable, setWorktreeRoot: unavailable, chooseWorktreeRoot: unavailable,
      ...createBrowserNotificationSettings(localStorage),
      onChanged: subscribe,
    },
    catalog: { list: unavailable, createWorkspace: unavailable, updateWorkspace: unavailable, deleteWorkspace: unavailable, onChanged: subscribe },
    filesystem: { listDirectories: unavailable },
    providers: { list: unavailable, create: unavailable, update: unavailable, remove: unavailable, test: unavailable, probe: unavailable, install: unavailable, login: unavailable, onChanged: subscribe },
    agent: signaling,
    terminal: { ...signaling, list: unavailable, dial: unavailable, hangup: unavailable, onSessionEvent: subscribe },
    desktop: { ...signaling, target: unavailable, capabilities: unavailable, start: unavailable },
  }
}
