import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { computed, ref } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi, Team } from "@deskfleet/client/central"
import { accountContextKey, type AccountContext } from "../../composables/useAccountContext.ts"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import SettingsView from "../../views/SettingsView.vue"
import TeamSettingsPage from "./TeamSettingsPage.vue"

let view: VueWrapper | undefined
afterEach(async () => { view?.unmount(); view = undefined; await router.replace("/") })
function context() {
  const teamId = ref("first")
  const teams: Team[] = [{ id: "first", name: "First team", role: "admin" }, { id: "second", name: "Second team", role: "admin" }]
  return {
    teamId, team: computed(() => teams.find(team => team.id === teamId.value)),
    account: ref({ serverUrl: "https://fleet.example", user: { id: "user-1", name: "Ada" } }),
    central: { members: vi.fn(async () => []), renameTeam: vi.fn(async () => {}) } as unknown as CentralApi,
    reload: vi.fn(async () => {}),
  } as unknown as AccountContext
}

test("team settings follow account context and reload after saving", async () => {
  const account = context()
  view = mount(TeamSettingsPage, { global: { plugins: [i18n], provide: { [accountContextKey as symbol]: account } } })
  await flushPromises()
  await view.get('[name="team-name"]').setValue("Edited name")
  await view.get("section form").trigger("submit")
  await flushPromises()
  expect(account.central.renameTeam).toHaveBeenCalledExactlyOnceWith("first", "Edited name")
  expect(account.reload).toHaveBeenCalledOnce()
  account.teamId.value = "second"
  await flushPromises()
  expect((view.get('[name="team-name"]').element as HTMLInputElement).value).toBe("Second team")
  expect(account.central.members).toHaveBeenLastCalledWith("second")
})

test.each([false, true])("settings show team navigation only for a selected account team (selected=%s)", async selected => {
  const account = context()
  if (!selected) account.teamId.value = ""
  view = mount(SettingsView, { global: { plugins: [i18n, router], provide: { [accountContextKey as symbol]: account }, stubs: { RouterView: true } } })
  await flushPromises()
  expect(view.findAll("a").some(link => link.text() === "Team settings")).toBe(selected)
  expect(view.findAll("a").map(link => link.text())).toContain("Preferences")
})
