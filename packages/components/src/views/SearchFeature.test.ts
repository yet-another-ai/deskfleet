import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { initializeAnalytics, shutdownAnalytics } from "../services/analytics.ts"
import { useSearchFeature } from "../services/search-feature.ts"
import { accountSessionKey, createAccountSession } from "../composables/useAccountSession.ts"
import { fakeCentral } from "../test/central.ts"
import { i18n } from "../i18n/index.ts"
import SearchView from "./SearchView.vue"

const cleanup: (() => void)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.useRealTimers(); await shutdownAnalytics() })

test.each(["web", "desktop"] as const)("%s without Statsig fails closed even on a direct search link", async platform => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  initializeAnalytics({ platform, environment: "test" })
  expect(useSearchFeature().value).toBe(false)
  const fake = fakeCentral()
  const account = createAccountSession(fake.central)
  await flushPromises()
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "new-session", component: {} },
    { path: "/search", name: "search", component: SearchView },
  ] })
  await router.push("/search?q=private")
  const wrapper = mount(SearchView, { global: { plugins: [router, i18n], provide: { [accountSessionKey as symbol]: account } } })
  cleanup.push(() => { wrapper.unmount(); account.dispose() })
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
  expect(fake.central.search).not.toHaveBeenCalled()
  expect(wrapper.find("input").exists()).toBe(false)
  expect(router.currentRoute.value.name).toBe("new-session")
})
