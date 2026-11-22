import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../i18n/index.ts"
import {
  defineRecoverableAsyncComponent,
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

afterEach(() => {
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

test("installVitePreloadRecovery prevents default and triggers guarded reload on vite:preloadError", () => {
  const storage = memoryStorage()
  const reload = vi.fn()
  const target = new EventTarget() as unknown as Window
  const stop = installVitePreloadRecovery(target, { storage, reload, pathname: "/", search: "", hash: "#/machines/1/control" })

  const first = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
    payload: new TypeError("Importing a module script failed."),
  })
  target.dispatchEvent(first)
  expect(first.defaultPrevented).toBe(true)
  expect(reload).toHaveBeenCalledTimes(1)

  const second = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
    payload: new TypeError("Importing a module script failed."),
  })
  target.dispatchEvent(second)
  expect(second.defaultPrevented).toBe(false)
  expect(reload).toHaveBeenCalledTimes(1)

  stop()
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
  installRouterModuleRecovery(router, {
    enabled: () => enabled,
    env: {
      storage,
      pathname: "/",
      search: "",
      get hash() { return hash },
      setHash: next => { hash = next },
      reload,
    },
  })
  await router.push("/")

  await expect(router.push("/machines/7/control")).rejects.toThrow(/Importing a module script failed/)
  expect(reload).not.toHaveBeenCalled()

  enabled = true
  await expect(router.push("/machines/7/control")).rejects.toThrow(/Importing a module script failed/)
  expect(hash).toBe("#/machines/7/control")
  expect(reload).toHaveBeenCalledTimes(1)
})

test("defineRecoverableAsyncComponent retries transient failures automatically", async () => {
  const Loaded = defineComponent({ template: '<div data-loaded="ok">Loaded</div>' })
  let calls = 0
  const AsyncView = defineRecoverableAsyncComponent(async () => {
    calls += 1
    if (calls === 1) throw new TypeError("Importing a module script failed.")
    return Loaded
  }, { allowReload: () => false, retryDelayMs: 0 })

  const wrapper = mount(AsyncView, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(calls).toBe(2)
  expect(wrapper.find('[data-loaded="ok"]').exists()).toBe(true)
  wrapper.unmount()
})

test("defineRecoverableAsyncComponent renders retry and reload actions when reload is suppressed", async () => {
  const Loaded = defineComponent({ template: '<div data-loaded="recovered">Recovered</div>' })
  const storage = memoryStorage()
  const reload = vi.fn()
  let calls = 0
  let shouldFail = true
  // Pre-seed the cooldown marker so auto-reload is suppressed and fallback UI renders.
  const now = 10_000
  storage.setItem("deskfleet:module-import-reload", JSON.stringify({ target: "/#/machines/1/control", at: now }))

  const AsyncView = defineRecoverableAsyncComponent(async () => {
    calls += 1
    if (shouldFail) throw new TypeError("Importing a module script failed.")
    return Loaded
  }, {
    allowReload: () => true,
    retryDelayMs: 0,
    env: { now: () => now + 1_000, storage, pathname: "/", search: "", hash: "#/machines/1/control", reload },
  })

  const wrapper = mount(AsyncView, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(calls).toBe(2)
  expect(reload).not.toHaveBeenCalled()
  expect(wrapper.find("[data-async-load-error]").exists()).toBe(true)

  await wrapper.get("[data-async-reload]").trigger("click")
  expect(reload).toHaveBeenCalledTimes(1)

  shouldFail = false
  await wrapper.get("[data-async-retry]").trigger("click")
  await flushPromises()
  expect(wrapper.find('[data-loaded="recovered"]').exists()).toBe(true)
  wrapper.unmount()
})
