import type { Router } from "vue-router"

const STORAGE_KEY = "deskfleet:module-import-reload"
const RELOAD_COOLDOWN_MS = 30_000

const DYNAMIC_IMPORT_ERROR_PATTERNS = [
  /importing a module script failed/i,
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /unable to preload css/i,
  /loading (?:css )?chunk [^\s]+ failed/i,
]

let pendingNavigationHash: string | undefined

export interface ModuleRecoveryEnvironment {
  now?: () => number
  storage?: Pick<Storage, "getItem" | "setItem"> | null
  pathname?: string
  search?: string
  hash?: string
  setHash?: (hash: string) => void
  reload?: () => void
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    if ("payload" in error) return errorMessage((error as { payload?: unknown }).payload)
    if ("message" in error && typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message
    }
  }
  return ""
}

export function isDynamicImportError(error: unknown): boolean {
  const message = errorMessage(error)
  return message.length > 0 && DYNAMIC_IMPORT_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

function defaultEnvironment(): ModuleRecoveryEnvironment {
  if (typeof window === "undefined") return {}
  let storage: Storage | null = null
  try {
    storage = window.sessionStorage
  } catch {
    storage = null
  }
  return {
    now: () => Date.now(),
    storage,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    setHash: hash => { window.location.hash = hash },
    reload: () => { window.location.reload() },
  }
}

/**
 * Reloads the page at most once per navigation target within the cooldown window
 * to recover from superseded hashed chunks after a server deployment.
 */
export function recoverFromModuleImportError(targetHash?: string, env?: ModuleRecoveryEnvironment): boolean {
  const runtime = { ...defaultEnvironment(), ...env }
  if (!runtime.storage || !runtime.reload) return false
  const now = runtime.now?.() ?? Date.now()
  const hash = targetHash ?? runtime.hash ?? ""
  const target = `${runtime.pathname ?? ""}${runtime.search ?? ""}${hash}`
  try {
    const raw = runtime.storage.getItem(STORAGE_KEY)
    if (raw) {
      const previous = JSON.parse(raw) as { target?: unknown; at?: unknown }
      if (previous.target === target && typeof previous.at === "number" && now - previous.at < RELOAD_COOLDOWN_MS) {
        return false
      }
    }
    runtime.storage.setItem(STORAGE_KEY, JSON.stringify({ target, at: now }))
  } catch {
    return false
  }
  if (targetHash !== undefined && targetHash !== runtime.hash) {
    runtime.setHash?.(targetHash)
  }
  runtime.reload()
  return true
}

export function installVitePreloadRecovery(
  target: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = typeof window === "undefined" ? undefined : window,
  env?: ModuleRecoveryEnvironment,
): () => void {
  if (!target) return () => {}
  const onPreloadError = (event: Event) => {
    const payload = "payload" in event ? (event as Event & { payload?: unknown }).payload : event
    if (isDynamicImportError(payload) && recoverFromModuleImportError(pendingNavigationHash, env)) {
      pendingNavigationHash = undefined
      event.preventDefault()
    }
  }
  target.addEventListener("vite:preloadError", onPreloadError)
  return () => { target.removeEventListener("vite:preloadError", onPreloadError) }
}

export function installRouterModuleRecovery(
  router: Pick<Router, "beforeEach" | "afterEach" | "onError">,
  options: { enabled?: () => boolean; env?: ModuleRecoveryEnvironment } = {},
): () => void {
  const removeBefore = router.beforeEach(to => {
    pendingNavigationHash = to.fullPath ? `#${to.fullPath}` : undefined
  })
  const removeAfter = router.afterEach(() => {
    pendingNavigationHash = undefined
  })
  const removeError = router.onError((error, to) => {
    const targetHash = to?.fullPath ? `#${to.fullPath}` : pendingNavigationHash
    pendingNavigationHash = undefined
    if (options.enabled && !options.enabled()) return
    if (!isDynamicImportError(error)) return
    recoverFromModuleImportError(targetHash, options.env)
  })
  return () => {
    pendingNavigationHash = undefined
    removeBefore()
    removeAfter()
    removeError()
  }
}
