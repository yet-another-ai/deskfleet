import type { GithubAppSettings, GithubRepositoryItem, GithubRepositoryItemsPage, GithubRepositoryItemsQuery } from "@deskfleet/client/central"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { accountSessionKey } from "../../composables/account-session-context.ts"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { readGithubItemDrag } from "../../services/github-composer-reference.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { catalogFixture, sessionId, workspaceId } from "../../test/catalog.ts"
import UiSelect from "../common/UiSelect.vue"
import GithubPanel from "./GithubPanel.vue"

const settings: GithubAppSettings = { authorized: true, configured: true, actAsYou: true, login: "demo", manageUrl: null }
const item: GithubRepositoryItem = { repository: "org/site", number: 9, title: "Repair navigation", body: "Keep the selected tab.", kind: "issue", state: "open", url: "https://github.com/org/site/issues/9" }
let wrapper: VueWrapper
let pinia: ReturnType<typeof createPinia>

async function setup(githubRepositoryItems: (query: GithubRepositoryItemsQuery) => Promise<GithubRepositoryItemsPage>, access = settings) {
  pinia = createPinia()
  useFleetStore(pinia).catalog = { ...catalogFixture(), workspaceGithubRepositories: [{ workspaceId, repositories: ["org/site", "org/api"] }] }
  wrapper = mount(GithubPanel, {
    props: { sessionId },
    global: { plugins: [pinia, router, i18n], provide: {
      [accountSessionKey as symbol]: { central: { githubSettings: async () => access, githubRepositoryItems } },
    } },
  })
  await flushPromises()
}
afterEach(() => { wrapper?.unmount(); disposePinia(pinia) })

const next = () => wrapper.get("nav button:last-child")
const previous = () => wrapper.get("nav button:first-child")

test("shows the current page and follows the response cursor forward and backward", async () => {
  const list = vi.fn(async ({ cursor }: GithubRepositoryItemsQuery) => ({
    items: cursor ? [item] : [], nextCursor: cursor ? null : "after-30",
  }))
  await setup(list)
  expect(list).toHaveBeenLastCalledWith({ owner: "org", repo: "site", includeClosed: false, cursor: undefined, kind: "issue" })
  expect(wrapper.get("nav").text()).toContain("Page 1")
  expect(previous().attributes("disabled")).toBeDefined()
  expect(next().attributes("disabled")).toBeUndefined()
  expect(wrapper.text()).toContain("No issues on this page.")
  await next().trigger("click")
  await flushPromises()
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "after-30" }))
  expect(wrapper.get("nav").text()).toContain("Page 2")
  expect(next().attributes("disabled")).toBeDefined()
  expect(previous().attributes("disabled")).toBeUndefined()
  expect(wrapper.get("li").text()).toContain("#9 · Open")
  await previous().trigger("click")
  await flushPromises()
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: undefined }))
  expect(wrapper.get("nav").text()).toContain("Page 1")
})

test.each(["filter", "repository", "kind"])("changing the %s resets paging and ignores an in-flight page", async change => {
  const pending = Promise.withResolvers<GithubRepositoryItemsPage>()
  const list = vi.fn(async ({ cursor }: GithubRepositoryItemsQuery) => cursor ? pending.promise : { items: [], nextCursor: "after-30" })
  await setup(list)
  await next().trigger("click")
  if (change === "filter") await wrapper.get('[role="switch"]').trigger("click")
  if (change === "repository") wrapper.getComponent(UiSelect).vm.$emit("update:modelValue", "org/api")
  if (change === "kind") await wrapper.get('button[aria-pressed="false"]').trigger("click")
  await flushPromises()
  expect(list).toHaveBeenLastCalledWith({
    owner: "org", repo: change === "repository" ? "api" : "site", kind: change === "kind" ? "pullRequest" : "issue",
    includeClosed: change === "filter", cursor: undefined,
  })
  pending.resolve({ items: [item], nextCursor: null })
  await flushPromises()
  expect(wrapper.text()).not.toContain(item.title)
  expect(wrapper.get("nav").text()).toContain("Page 1")
  expect(previous().attributes("disabled")).toBeDefined()
})

test("shows open, closed and merged items with visible status and returns to open-only results", async () => {
  const list = vi.fn(async ({ includeClosed, kind }: GithubRepositoryItemsQuery) => {
    const rows: GithubRepositoryItem[] = [{ ...item, kind }]
    if (includeClosed) rows.push({ ...item, kind, title: "Finished", state: "closed", number: 10, url: "https://github.com/org/site/issues/10" })
    if (includeClosed && kind === "pullRequest") rows.push({ ...item, kind, title: "Shipped", state: "merged", number: 11, url: "https://github.com/org/site/pull/11" })
    return { items: rows, nextCursor: null }
  })
  await setup(list)
  expect(wrapper.get('[role="switch"]').attributes("aria-checked")).toBe("false")
  expect(previous().attributes("disabled")).toBeDefined()
  expect(next().attributes("disabled")).toBeDefined()
  await wrapper.get('[role="switch"]').trigger("click")
  await flushPromises()
  expect(wrapper.get('[role="switch"]').attributes("aria-checked")).toBe("true")
  expect(wrapper.text()).toContain("#10 · Closed")
  await wrapper.get('button[aria-pressed="false"]').trigger("click")
  await flushPromises()
  expect(wrapper.text()).toContain("#11 · Merged")
  await wrapper.get('[role="switch"]').trigger("click")
  await flushPromises()
  expect(wrapper.findAll("li")).toHaveLength(1)
  expect(wrapper.get("li").text()).toContain("#9 · Open")
})

test("drags a scoped reference and inserts the same item into the Session draft on click", async () => {
  await setup(async () => ({ items: [item], nextCursor: null }))
  const row = wrapper.get('[draggable="true"]')
  const transfer = new DataTransfer()
  await row.trigger("dragstart", { dataTransfer: transfer })
  const catalog = useFleetStore(pinia).catalog!
  expect(readGithubItemDrag(transfer, { teamId: catalog.teamId, machineId: catalog.machineId, workspaceId })).toEqual(item)
  await row.get("button").trigger("click")
  expect(wrapper.emitted("insert")).toHaveLength(1)
  expect(useAgentSessionsStore(pinia).draftAttachments[sessionId]).toEqual([{ kind: "github", id: expect.any(String), item }])
})

test("explains how to enable access before listing repository data", async () => {
  const list = vi.fn()
  await setup(list, { ...settings, actAsYou: false })
  expect(list).not.toHaveBeenCalled()
  expect(wrapper.get("a").text()).toBe("Open GitHub settings")
  expect(wrapper.text()).toContain("turn on Act as you")
})

test("refresh fetches new repository items when the GitHub permissions stay the same", async () => {
  const list = vi.fn().mockResolvedValueOnce({ items: [], nextCursor: null }).mockResolvedValueOnce({ items: [item], nextCursor: null })
  await setup(list)
  await wrapper.get('[aria-label="Refresh GitHub items"]').trigger("click")
  await flushPromises()
  expect(list).toHaveBeenCalledTimes(2)
  expect(wrapper.text()).toContain(item.title)
})
