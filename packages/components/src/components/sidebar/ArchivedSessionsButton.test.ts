import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../../i18n/index.ts"
import ArchivedSessionsButton from "./ArchivedSessionsButton.vue"

let wrapper: VueWrapper | undefined
afterEach(async () => {
  wrapper?.unmount(); wrapper = undefined
  await flushPromises()
  i18n.global.locale.value = "en-US"
})

async function render(path = "/") {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "new-session", component: {} },
    { path: "/sessions/archived", name: "archived-sessions", component: {} },
    { path: "/sessions/:sessionId", name: "session", component: {} },
  ] })
  await router.push(path)
  wrapper = mount(ArchivedSessionsButton, { attachTo: document.body, global: { plugins: [router, i18n] } })
  return router
}

test("the footer archive link navigates to its page without opening a dialog", async () => {
  const router = await render("/sessions/30")
  const link = wrapper!.get('a[aria-label="Archived sessions"]')
  expect(link.attributes("href")).toBe("/sessions/archived")
  expect(link.attributes("aria-current")).toBeUndefined()
  await link.trigger("click"); await flushPromises()
  expect(router.currentRoute.value.name).toBe("archived-sessions")
  expect(link.attributes("aria-current")).toBe("page")
  expect(link.classes()).toContain("ui-nav-active")
  expect(new DOMWrapper(document.body).find('[role="dialog"]').exists()).toBe(false)
  router.back(); await flushPromises()
  expect(router.currentRoute.value.path).toBe("/sessions/30")
  expect(link.attributes("aria-current")).toBeUndefined()
})

test("direct archive navigation marks its localized footer link active", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  await render("/sessions/archived")
  const link = wrapper!.get('a[aria-label="已归档会话"]')
  expect(link.attributes("aria-current")).toBe("page")
  expect(link.classes()).toContain("ui-nav-active")
})
