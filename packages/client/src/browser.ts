import { HttpCentralClient, type SavedAccount } from "./http-central.ts"
import type { DeskfleetDesktopApi } from "./desktop-api.ts"
import { resolveAppLocale } from "./i18n.ts"
import { createBrowserFiles } from "./browser-files.ts"

const accountKey = "deskfleet.account"
const verifierKey = "deskfleet.login-verifier"

/** The browser hosts no daemon; all machine access is obtained through its signed-in account. */
export async function browserClient(defaultServerUrl: string): Promise<DeskfleetDesktopApi> {
  let account: SavedAccount = { serverUrl: defaultServerUrl }
  let initialError: string | undefined
  const saved = sessionStorage.getItem(accountKey)
  if (saved) account = JSON.parse(saved) as SavedAccount
  const central = new HttpCentralClient({
    account,
    persist: async value => { sessionStorage.setItem(accountKey, JSON.stringify(value)) },
    authorize: async client => {
      const returnTo = `${location.origin}${location.pathname}`
      const result = await client.authorizationUrl(returnTo)
      sessionStorage.setItem(verifierKey, result.loginVerifier)
      location.assign(result.authorizationUrl)
    },
  })
  const code = new URLSearchParams(location.hash.slice(1)).get("loginCode")
  if (code) {
    const verifier = sessionStorage.getItem(verifierKey)
    sessionStorage.removeItem(verifierKey)
    history.replaceState(null, "", location.pathname + location.search)
    try {
      if (!verifier) throw new Error("The login session has expired. Sign in again.")
      await central.exchange(code, verifier)
    } catch (reason) { initialError = reason instanceof Error ? reason.message : String(reason) }
  }
  const unavailable = async (): Promise<never> => { throw new Error("Select a machine to continue") }
  const subscribe = () => () => {}
  const signaling = { offer: unavailable, candidate: unavailable, close: unavailable, onEvent: subscribe }
  return {
    platform: "web", locale: resolveAppLocale(navigator.languages), central, initialError,
    files: createBrowserFiles(central),
    settings: {
      get: async () => ({ enabled: false, status: "stopped" }), setLocalAgentEnabled: unavailable,
      getLaunchAtStartup: async () => ({ available: false, enabled: false }), setLaunchAtStartup: unavailable,
      getKeepAwake: async () => ({ enabled: false }), setKeepAwake: unavailable,
      getWorktreeRoot: unavailable, setWorktreeRoot: unavailable, chooseWorktreeRoot: unavailable,
      getNotifications: async () => ({ enabled: false, taskCompleted: false, taskNeedsInput: false }), setNotifications: unavailable,
      onChanged: subscribe,
    },
    catalog: { list: unavailable, createWorkspace: unavailable, updateWorkspace: unavailable, deleteWorkspace: unavailable, onChanged: subscribe },
    filesystem: { listDirectories: unavailable },
    providers: { list: unavailable, create: unavailable, update: unavailable, remove: unavailable, test: unavailable, onChanged: subscribe },
    agent: signaling,
    terminal: { ...signaling, list: unavailable, dial: unavailable, hangup: unavailable, onSessionEvent: subscribe },
    desktop: { ...signaling, target: unavailable, capabilities: unavailable, start: unavailable },
  }
}
