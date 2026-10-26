import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../../i18n/index.ts"
import SidebarNavigation from "./SidebarNavigation.vue"

let wrapper: VueWrapper | undefined
const sectionLink = (label: string) => wrapper!.get<HTMLAnchorElement>(`a[aria-label="${label}"]`)
const newSessionLink = () => wrapper!.findAll("a").find(link => link.text() === i18n.global.t("nav.newSession"))!

async function setup(path = "/") {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/schedules/:scheduleId?", name: "schedules", component: {} },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/workspaces/:workspaceId", name: "workspace", component: {} },
      { path: "/machines/:machineId/control", name: "machine-control", component: {} },
    ],
  })
  await router.push(path)
  wrapper = mount(SidebarNavigation, { attachTo: document.body, global: { plugins: [router, i18n] } })
  await flushPromises()
  return router
}

afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
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

test("localizes both section links and the New session action", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  await setup("/schedules")
  expect(wrapper!.get("nav").attributes("aria-label")).toBe("导航")
  expect(newSessionLink().text()).toBe("新会话")
  expect(sectionLink("计划任务").attributes("aria-current")).toBe("page")
  expect(sectionLink("对话").attributes("aria-current")).toBeUndefined()
  expect(sectionLink("对话").attributes("href")).toBe("/")
})
