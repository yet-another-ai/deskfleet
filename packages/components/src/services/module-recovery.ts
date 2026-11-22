import { defineAsyncComponent, defineComponent, h, inject, provide, ref, type AsyncComponentLoader, type Component, type InjectionKey } from "vue"
import type { Router } from "vue-router"
import AsyncLoadError from "../components/common/AsyncLoadError.vue"

const STORAGE_KEY = "deskfleet:module-import-reload"
const RELOAD_COOLDOWN_MS = 30_000
const RETRY_DELAY_MS = 250

const DYNAMIC_IMPORT_ERROR_PATTERNS = [
  /importing a module script failed/i,
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /unable to preload css/i,
  /loading (?:css )?chunk [^\s]+ failed/i,
]

export interface ModuleRecoveryEnvironment {
  now?: () => number
  storage?: Pick<Storage, "getItem" | "setItem"> | null
  pathname?: string
  search?: string
  hash?: string
  setHash?: (hash: string) => void
  reload?: () => void
}

export interface AsyncLoadErrorActions {
  retry(): void
  reload(): void
}

export const asyncLoadErrorActionsKey: InjectionKey<AsyncLoadErrorActions> = Symbol("deskfleet:async-load-error-actions")

export function useAsyncLoadErrorActions(): AsyncLoadErrorActions | undefined {
  return inject(asyncLoadErrorActionsKey, undefined)
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
    if (isDynamicImportError(payload) && recoverFromModuleImportError(undefined, env)) {
      event.preventDefault()
    }
  }
  target.addEventListener("vite:preloadError", onPreloadError)
  return () => { target.removeEventListener("vite:preloadError", onPreloadError) }
}

export function installRouterModuleRecovery(
  router: Pick<Router, "onError">,
  options: { enabled?: () => boolean; env?: ModuleRecoveryEnvironment } = {},
): void {
  router.onError((error, to) => {
    if (options.enabled && !options.enabled()) return
    if (!isDynamicImportError(error)) return
    const targetHash = to?.fullPath ? `#${to.fullPath}` : undefined
    recoverFromModuleImportError(targetHash, options.env)
  })
}

export interface RecoverableAsyncComponentOptions {
  /** Automatically attempt a guarded page reload on stale dynamic import errors. */
  allowReload?: () => boolean
  /** Retry delay before the automatic transient retry attempt. */
  retryDelayMs?: number
  /** Custom recovery environment (for tests). */
  env?: ModuleRecoveryEnvironment
}

export function defineRecoverableAsyncComponent<T extends Component = Component>(
  loader: AsyncComponentLoader<T>,
  options: RecoverableAsyncComponentOptions = {},
): Component {
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS
  const Inner = defineAsyncComponent({
    loader,
    errorComponent: AsyncLoadError,
    onError(error, retry, fail, attempts) {
      if (!isDynamicImportError(error)) {
        fail()
        return
      }
      if (attempts <= 1) {
        if (retryDelayMs <= 0) retry()
        else setTimeout(retry, retryDelayMs)
        return
      }
      const reloadAllowed = options.allowReload ? options.allowReload() : true
      if (reloadAllowed && recoverFromModuleImportError(undefined, options.env)) {
        return
      }
      fail()
    },
  })

  return defineComponent({
    name: "RecoverableAsyncComponent",
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      const attempt = ref(0)
      provide(asyncLoadErrorActionsKey, {
        retry: () => { attempt.value += 1 },
        reload: () => {
          const reload = options.env?.reload ?? (typeof window !== "undefined" ? () => window.location.reload() : undefined)
          reload?.()
        },
      })
      return () => h(Inner, { ...attrs, key: attempt.value }, slots)
    },
  })
}
