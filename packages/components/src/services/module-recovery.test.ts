import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../i18n/index.ts"
import { defineRecoverableAsyncComponent } from "./async-component.ts"
import {
  installRouterModuleRecovery,
  installVitePreloadRecovery,
  isDynamicImportError,
  recoverFromModuleImportError,
} from "./module-recovery.ts"

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
  i18n.global.locale.value = "en-US"
})

test("identifies browser and Vite dynamic module import failures", () => {
  expect(isDynamicImportError(new TypeError("Importing a module script failed."))).toBe(true)
  expect(isDynamicImportError(new TypeError("Failed to fetch dynamically imported module: https://app.example/assets/foo-12345678.js"))).toBe(true)
  expect(isDynamicImportError(new Error("error loading dynamically imported module"))).toBe(true)
  expect(isDynamicImportError(new Error("Unable to preload CSS for /assets/foo-12345678.css"))).toBe(true)
  expect(isDynamicImportError(new Error("Loading chunk 42 failed"))).toBe(true)
  expect(isDynamicImportError(new Error("Permission denied"))).toBe(false)
  expect(isDynamicImportError(null)).toBe(false)
})

test("recoverFromModuleImportError reloads once per target within the cooldown window and recovers after expiry", () => {
  const storage = memoryStorage()
  let now = 1_000
  let hash = "#/sessions/1"
  const reload = vi.fn()
  const env = {
    now: () => now,
    storage,
    pathname: "/",
    search: "",
    get hash() { return hash },
    setHash: (next: string) => { hash = next },
    reload,
  }

  expect(recoverFromModuleImportError("#/machines/2/control", env)).toBe(true)
  expect(hash).toBe("#/machines/2/control")
  expect(reload).toHaveBeenCalledTimes(1)

  // Immediate repeat for the same target is loop-protected.
  now += 5_000
  expect(recoverFromModuleImportError("#/machines/2/control", env)).toBe(false)
  expect(reload).toHaveBeenCalledTimes(1)

  // A different navigation target can still recover once.
  expect(recoverFromModuleImportError("#/sessions/9", env)).toBe(true)
  expect(hash).toBe("#/sessions/9")
  expect(reload).toHaveBeenCalledTimes(2)

  // After the cooldown expires, the same target can recover again for a later deployment.
  now += 31_000
  expect(recoverFromModuleImportError("#/sessions/9", env)).toBe(true)
  expect(reload).toHaveBeenCalledTimes(3)
})

test("recoverFromModuleImportError refuses to loop when sessionStorage is unavailable", () => {
  const reload = vi.fn()
  expect(recoverFromModuleImportError("#/machines/2/control", { storage: null, reload })).toBe(false)
  expect(reload).not.toHaveBeenCalled()
})

test("installVitePreloadRecovery prevents default and preserves the destination hash during route navigation", async () => {
  const storage = memoryStorage()
  let hash = "#/sessions/1"
  const reload = vi.fn()
  const target = new EventTarget() as unknown as Window
  const env = {
    storage,
    pathname: "/",
    search: "",
    get hash() { return hash },
    setHash: (next: string) => { hash = next },
    reload,
  }
  cleanups.push(installVitePreloadRecovery(target, env))

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: defineComponent({ template: "<div />" }) },
      {
        path: "/machines/:machineId/control",
        component: () => {
          // Simulate Vite's __vitePreload dispatching vite:preloadError and resolving undefined when prevented.
          const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
            payload: new TypeError("Importing a module script failed."),
          })
          target.dispatchEvent(event)
          if (event.defaultPrevented) return Promise.resolve(undefined as never)
          return Promise.reject(event.payload)
        },
      },
    ],
  })
  cleanups.push(installRouterModuleRecovery(router, { enabled: () => true, env }))
  await router.push("/")

  await router.push("/machines/7/control").catch(() => {})
  expect(hash).toBe("#/machines/7/control")
  expect(reload).toHaveBeenCalledTimes(1)

  // A second preload error for the same target is loop-protected and does not preventDefault.
  const second = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
    payload: new TypeError("Importing a module script failed."),
  })
  target.dispatchEvent(second)
  expect(second.defaultPrevented).toBe(false)
  expect(reload).toHaveBeenCalledTimes(1)
})

test("a canceled earlier navigation does not clear the newer navigation's pending recovery hash", async () => {
  const storage = memoryStorage()
  let hash = "#/sessions/1"
  const reload = vi.fn()
  const target = new EventTarget() as unknown as Window
  const env = {
    storage,
    pathname: "/",
    search: "",
    get hash() { return hash },
    setHash: (next: string) => { hash = next },
    reload,
  }
  cleanups.push(installVitePreloadRecovery(target, env))

  let releaseSlow!: () => void
  let failNewer!: () => void
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: defineComponent({ template: "<div />" }) },
      {
        path: "/slow",
        component: () => new Promise(resolve => {
          releaseSlow = () => resolve(defineComponent({ template: "<div />" }))
        }),
      },
      {
        path: "/machines/:machineId/control",
        component: () => new Promise((resolve, reject) => {
          failNewer = () => {
            const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
              payload: new TypeError("Importing a module script failed."),
            })
            target.dispatchEvent(event)
            if (event.defaultPrevented) resolve(undefined as never)
            else reject(event.payload)
          }
        }),
      },
    ],
  })
  cleanups.push(installRouterModuleRecovery(router, { enabled: () => true, env }))
  await router.push("/")

  const firstNav = router.push("/slow")
  await flushPromises()
  const secondNav = router.push("/machines/9/control")
  await flushPromises()

  // Complete the superseded first navigation so Vue Router fires afterEach with a cancellation failure.
  releaseSlow()
  await firstNav
  await flushPromises()

  // Now the newer navigation's chunk fails to preload; it must still recover to /machines/9/control.
  failNewer()
  await secondNav.catch(() => {})
  expect(hash).toBe("#/machines/9/control")
  expect(reload).toHaveBeenCalledTimes(1)
})

test("installRouterModuleRecovery reloads toward the failed route only when enabled", async () => {
  const storage = memoryStorage()
  const reload = vi.fn()
  let hash = "#/"
  let enabled = false
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: defineComponent({ template: "<div />" }) },
      {
        path: "/machines/:machineId/control",
        component: () => Promise.reject(new TypeError("Importing a module script failed.")),
      },
    ],
  })
  cleanups.push(installRouterModuleRecovery(router, {
    enabled: () => enabled,
    env: {
      storage,
      pathname: "/",
      search: "",
      get hash() { return hash },
      setHash: next => { hash = next },
      reload,
    },
  }))
  await router.push("/")

  await expect(router.push("/machines/7/control")).rejects.toThrow(/Importing a module script failed/)
  expect(reload).not.toHaveBeenCalled()

  enabled = true
  await expect(router.push("/machines/7/control")).rejects.toThrow(/Importing a module script failed/)
  expect(hash).toBe("#/machines/7/control")
  expect(reload).toHaveBeenCalledTimes(1)
})

test("defineRecoverableAsyncComponent reloads immediately on dynamic import error without a futile in-place retry", async () => {
  const storage = memoryStorage()
  const reload = vi.fn()
  let calls = 0
  const AsyncView = defineRecoverableAsyncComponent(async () => {
    calls += 1
    throw new TypeError("Importing a module script failed.")
  }, {
    allowReload: () => true,
    env: { storage, pathname: "/", search: "", hash: "#/machines/1/control", reload },
  })

  const wrapper = mount(AsyncView, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(calls).toBe(1)
  expect(reload).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

test("defineRecoverableAsyncComponent renders reload-only fallback for suppressed module import errors and retry for non-import errors", async () => {
  const storage = memoryStorage()
  const reload = vi.fn()
  const now = 10_000
  storage.setItem("deskfleet:module-import-reload", JSON.stringify({ target: "/#/machines/1/control", at: now }))

  const FailedImport = defineRecoverableAsyncComponent(async () => {
    throw new TypeError("Importing a module script failed.")
  }, {
    allowReload: () => true,
    env: { now: () => now + 1_000, storage, pathname: "/", search: "", hash: "#/machines/1/control", reload },
  })

  const importWrapper = mount(FailedImport, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(reload).not.toHaveBeenCalled()
  expect(importWrapper.find("[data-async-load-error]").exists()).toBe(true)
  expect(importWrapper.find("[data-async-retry]").exists()).toBe(false)
  await importWrapper.get("[data-async-reload]").trigger("click")
  expect(reload).toHaveBeenCalledTimes(1)
  importWrapper.unmount()

  const Loaded = defineComponent({ template: '<div data-loaded="recovered">Recovered</div>' })
  let shouldFail = true
  const TransientNonImport = defineRecoverableAsyncComponent(async () => {
    if (shouldFail) throw new Error("Temporary initialization failure")
    return Loaded
  }, { allowReload: () => true, env: { storage, pathname: "/", search: "", hash: "#/machines/1/control", reload } })

  const retryWrapper = mount(TransientNonImport, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(retryWrapper.find("[data-async-retry]").exists()).toBe(true)
  shouldFail = false
  await retryWrapper.get("[data-async-retry]").trigger("click")
  await flushPromises()
  expect(retryWrapper.find('[data-loaded="recovered"]').exists()).toBe(true)
  retryWrapper.unmount()
})
