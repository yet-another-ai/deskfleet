import { HttpCentralClient, serverAddress, type SavedAccount } from "./http-central.ts"
import type { DeskfleetDesktopApi } from "./desktop-api.ts"
import { resolveAppLocale } from "./i18n.ts"
import { createBrowserFiles } from "./browser-files.ts"
import { createBrowserNotificationSettings } from "./browser-notification-settings.ts"
import { reportingCentral, type CentralErrorReporter } from "./reporting-central.ts"

export interface BrowserClientOptions {
  mobile?: boolean
  account?: SavedAccount
  cookieAuth?: boolean
  persist?: (account: SavedAccount) => Promise<void>
  authorize?: (client: HttpCentralClient) => Promise<void>
  openExternal?: (url: string) => Promise<unknown>
}

/** The browser owns no bearer token; its login session stays in an HttpOnly cookie unless native bearer auth is configured. */
export async function browserClient(
  configuredServerUrl: string,
  report: CentralErrorReporter = () => {},
  options: BrowserClientOptions = {},
): Promise<DeskfleetDesktopApi> {
  const serverUrl = serverAddress(configuredServerUrl)
  const central = reportingCentral(new HttpCentralClient({
    account: options.account ? { ...options.account, serverUrl } : { serverUrl },
    cookieAuth: options.cookieAuth ?? true,
    transport: "browser_fetch",
    persist: options.persist ?? (async () => {}),
    authorize: options.authorize ?? (async () => { location.assign("/auth/login") }),
    openExternal: options.openExternal ?? (async url => { location.assign(url) }),
  }), report)
  const unavailable = async (): Promise<never> => { throw new Error("Select a machine to continue") }
  const subscribe = () => () => {}
  const signaling = { offer: unavailable, candidate: unavailable, close: unavailable, onEvent: subscribe }
  return {
    platform: "web", ...(options.mobile ? { mobile: true } : {}),
    locale: resolveAppLocale(navigator.languages), central,
    siteAdministration: options.mobile ? undefined : central,
    files: createBrowserFiles(central),
    settings: {
      get: async () => ({ enabled: false, status: "stopped" }), setLocalAgentEnabled: unavailable,
      getLaunchAtStartup: async () => ({ available: false, enabled: false }), setLaunchAtStartup: unavailable,
      getKeepAwake: async () => ({ enabled: false }), setKeepAwake: unavailable,
      getAutoDownloadUpdates: async () => ({ enabled: false }), setAutoDownloadUpdates: unavailable,
      getWorktreeRoot: unavailable, setWorktreeRoot: unavailable, chooseWorktreeRoot: unavailable,
      getRemoteAgentSettings: unavailable, setRemoteAgentSettings: unavailable,
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
