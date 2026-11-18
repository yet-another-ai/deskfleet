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
const item: GithubRepositoryItem = { repository: "org/site", number: 9, title: "Repair navigation", body: "Keep the selected tab.", kind: "issue", url: "https://github.com/org/site/issues/9" }
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

test("tracks repository and kind across pages and ignores late responses to an old query", async () => {
  const pending = Promise.withResolvers<GithubRepositoryItemsPage>()
  const list = vi.fn(async (query: GithubRepositoryItemsQuery) => {
    if (query.page === 2) return pending.promise
    return { items: [], nextPage: query.kind === "issue" ? 2 : null }
  })
  await setup(list)
  expect(list).toHaveBeenLastCalledWith({ owner: "org", repo: "site", page: 1, kind: "issue" })
  expect(wrapper.text()).toContain("No open issues on this page.")
  await wrapper.get("nav button:last-child").trigger("click")
  expect(list).toHaveBeenLastCalledWith({ owner: "org", repo: "site", page: 2, kind: "issue" })
  await wrapper.get('button[aria-pressed="false"]').trigger("click")
  await flushPromises()
  expect(list).toHaveBeenLastCalledWith({ owner: "org", repo: "site", page: 1, kind: "pullRequest" })
  pending.resolve({ items: [item], nextPage: null })
  await flushPromises()
  expect(wrapper.text()).not.toContain(item.title)
  wrapper.getComponent(UiSelect).vm.$emit("update:modelValue", "org/api")
  await flushPromises()
  expect(list).toHaveBeenLastCalledWith({ owner: "org", repo: "api", page: 1, kind: "pullRequest" })
})

test("drags a scoped reference and inserts the same item into the Session draft on click", async () => {
  await setup(async () => ({ items: [item], nextPage: null }))
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
  const list = vi.fn().mockResolvedValueOnce({ items: [], nextPage: null }).mockResolvedValueOnce({ items: [item], nextPage: null })
  await setup(list)
  await wrapper.get('[aria-label="Refresh GitHub items"]').trigger("click")
  await flushPromises()
  expect(list).toHaveBeenCalledTimes(2)
  expect(wrapper.text()).toContain(item.title)
})
