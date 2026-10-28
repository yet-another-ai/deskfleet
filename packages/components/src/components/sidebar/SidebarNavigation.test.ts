import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../../i18n/index.ts"
import SidebarNavigation from "./SidebarNavigation.vue"

let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia> | undefined
const sectionLink = (label: string) => wrapper!.get<HTMLAnchorElement>(`a[aria-label="${label}"]`)
const newSessionLink = () => wrapper!.findAll("a").find(link => link.text() === i18n.global.t("nav.newSession"))!

async function setup(path = "/") {
  pinia = createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/schedules/:scheduleId?", name: "schedules", component: {} },
      { path: "/sessions/archived", name: "archived-sessions", component: {}, meta: { hideDetails: true } },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/workspaces/:workspaceId", name: "workspace", component: {} },
      { path: "/worktrees/:worktreeId", name: "worktree", component: {} },
      { path: "/machines/:machineId/control", name: "machine-control", component: {} },
      {
        path: "/settings",
        meta: { fullWindow: true },
        children: [
          { path: "", name: "settings", redirect: { name: "settings-preferences" } },
          { path: "preferences", name: "settings-preferences", component: {} },
        ],
      },
    ],
  })
  await router.push(path)
  wrapper = mount(SidebarNavigation, { attachTo: document.body, global: { plugins: [pinia, router, i18n] } })
  await flushPromises()
  return router
}

afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  if (pinia) {
    disposePinia(pinia)
    pinia = undefined
  }
  window.localStorage.clear()
  await flushPromises()
  i18n.global.locale.value = "en-US"
})

test("keeps New session available alongside the section capsules", async () => {
  const router = await setup("/schedules/daily-review")
  expect(wrapper!.get("nav").attributes("aria-label")).toBe("Navigation")
  const newSession = newSessionLink()
  expect(newSession.text()).toBe("New session")
  expect(newSession.attributes("href")).toBe("/")
  await newSession.trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.name).toBe("new-session")
  expect(sectionLink("Conversations").attributes("aria-current")).toBe("page")
  expect(sectionLink("Schedules").attributes("aria-current")).toBeUndefined()
})

test.each(["/schedules", "/schedules/new", "/schedules/daily-review"])("recognizes %s as the Schedules section", async path => {
  await setup(path)
  expect(sectionLink("Schedules").attributes("aria-current")).toBe("page")
  expect(sectionLink("Schedules").attributes("href")).toBe(path)
  expect(sectionLink("Conversations").attributes("aria-current")).toBeUndefined()
})

test("switches sections and restores the previous conversation route including query and hash", async () => {
  const conversation = "/sessions/session-42?tab=changes#reply-7"
  const router = await setup(conversation)
  expect(sectionLink("Conversations").attributes("aria-current")).toBe("page")
  expect(sectionLink("Schedules").attributes("href")).toBe("/schedules")
  await sectionLink("Schedules").trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe("/schedules")
  expect(sectionLink("Schedules").attributes("aria-current")).toBe("page")
  await router.push("/schedules/daily-review")
  expect(sectionLink("Conversations").attributes("href")).toBe(conversation)
  await sectionLink("Conversations").trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe(conversation)
  expect(sectionLink("Conversations").attributes("aria-current")).toBe("page")
  expect(sectionLink("Schedules").attributes("aria-current")).toBeUndefined()
})

test("falls back to New session when opened directly on a schedule", async () => {
  const router = await setup("/schedules/daily-review")
  expect(sectionLink("Conversations").attributes("href")).toBe("/")
  await sectionLink("Conversations").trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe("/")
})

test("Archived sessions has no active capsule and preserves the previous conversation destination", async () => {
  const conversation = "/sessions/session-42?tab=changes#reply-7"
  const router = await setup(conversation)
  await router.push("/sessions/archived"); await flushPromises()
  expect(sectionLink("Conversations").attributes("aria-current")).toBeUndefined()
  expect(sectionLink("Schedules").attributes("aria-current")).toBeUndefined()
  expect(sectionLink("Conversations").attributes("href")).toBe(conversation)
  expect(window.localStorage.getItem("deskfleet.conversation-path")).toBe(conversation)
  await sectionLink("Conversations").trigger("click"); await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe(conversation)
})

test("opening Archived sessions directly returns Conversations to New session", async () => {
  const router = await setup("/sessions/archived")
  expect(sectionLink("Conversations").attributes("aria-current")).toBeUndefined()
  expect(sectionLink("Conversations").attributes("href")).toBe("/")
  await sectionLink("Conversations").trigger("click"); await flushPromises()
  expect(router.currentRoute.value.name).toBe("new-session")
})

test.each([
  { path: "/sessions/session-42?tab=changes", section: "Conversations" },
  { path: "/schedules/new", section: "Schedules" },
])("selecting the active $section section keeps $path", async ({ path, section }) => {
  const router = await setup(path)
  expect(sectionLink(section).attributes("href")).toBe(path)
  await sectionLink(section).trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe(path)
  expect(sectionLink(section).attributes("aria-current")).toBe("page")
})

test("external navigation updates the active capsule and conversation return route", async () => {
  const router = await setup("/sessions/session-42")
  await router.push("/workspaces/project-7")
  await flushPromises()
  expect(sectionLink("Conversations").attributes("aria-current")).toBe("page")
  expect(sectionLink("Conversations").attributes("href")).toBe("/workspaces/project-7")
  await router.push("/schedules/daily-review")
  expect(sectionLink("Schedules").attributes("aria-current")).toBe("page")
  expect(sectionLink("Conversations").attributes("aria-current")).toBeUndefined()
  await sectionLink("Conversations").trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe("/workspaces/project-7")
})

test("remounting while on Schedules keeps the last conversation path", async () => {
  const conversation = "/sessions/session-42?tab=changes#reply-7"
  const router = await setup(conversation)
  await sectionLink("Schedules").trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe("/schedules")
  expect(window.localStorage.getItem("deskfleet.conversation-path")).toBe(conversation)
  // AppSidebar remounts on hide/show and Settings; the layout store outlives it.
  wrapper!.unmount()
  wrapper = mount(SidebarNavigation, { attachTo: document.body, global: { plugins: [pinia!, router, i18n] } })
  await flushPromises()
  expect(window.localStorage.getItem("deskfleet.conversation-path")).toBe(conversation)
  expect(sectionLink("Schedules").attributes("aria-current")).toBe("page")
  expect(sectionLink("Conversations").attributes("href")).toBe(conversation)
  await sectionLink("Conversations").trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe(conversation)
})

test("Settings does not overwrite the Conversations return path", async () => {
  const conversation = "/workspaces/project-7"
  const router = await setup(conversation)
  await router.push("/settings/preferences")
  await flushPromises()
  expect(router.currentRoute.value.name).toBe("settings-preferences")
  expect(window.localStorage.getItem("deskfleet.conversation-path")).toBe(conversation)
  // fullWindow unmounts the sidebar; returning to Schedules remounts it.
  wrapper!.unmount()
  await router.push("/schedules")
  wrapper = mount(SidebarNavigation, { attachTo: document.body, global: { plugins: [pinia!, router, i18n] } })
  await flushPromises()
  expect(sectionLink("Schedules").attributes("aria-current")).toBe("page")
  expect(sectionLink("Conversations").attributes("href")).toBe(conversation)
  await sectionLink("Conversations").trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe(conversation)
  expect(router.currentRoute.value.name).not.toBe("settings-preferences")
})

test("localizes both section links and the New session action", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  await setup("/schedules")
  expect(wrapper!.get("nav").attributes("aria-label")).toBe("导航")
  expect(newSessionLink().text()).toBe("新会话")
  expect(sectionLink("计划任务").attributes("aria-current")).toBe("page")
  expect(sectionLink("对话").attributes("aria-current")).toBeUndefined()
  expect(sectionLink("对话").attributes("href")).toBe("/")
})
