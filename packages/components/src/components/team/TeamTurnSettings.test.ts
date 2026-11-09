import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { platformClientKey, usePlatformClient } from "../../composables/usePlatformClient.ts"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral, type FakeCentralOptions } from "../../test/central.ts"
import TeamTurnSettings from "./TeamTurnSettings.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined })
const button = (label: string) => view!.findAll("button").find(value => value.text() === label)
const secret = () => view!.get<HTMLInputElement>('[name="team-turn-secret"]')
async function render(options: FakeCentralOptions = {}, mobile = false) {
  const fake = fakeCentral(options)
  const host = { ...usePlatformClient(), ...(mobile ? { mobile: true } : {}) }
  view = mount(TeamTurnSettings, {
    props: { api: fake.central, teamId: "team-1" },
    global: { plugins: [i18n], provide: { [platformClientKey as symbol]: host }, stubs: { teleport: { inheritAttrs: false, template: "<slot />" } } },
    attachTo: document.body,
  })
  await flushPromises()
  return fake
}

test("adds a server with a write-only secret, then changes URLs without resending it", async () => {
  const { central, state } = await render()
  expect(central.teamTurnSettings).toHaveBeenCalledExactlyOnceWith("team-1")
  expect(button("Save")!.attributes("disabled")).toBeDefined()
  await view!.get('[name="team-turn-url-0"]').setValue("  turn:relay.example:3478?transport=udp  ")
  // A first save needs the shared secret.
  expect(button("Save")!.attributes("disabled")).toBeDefined()
  await secret().setValue("north-secret")
  expect(secret().attributes("type")).toBe("password")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(central.updateTeamTurnSettings).toHaveBeenCalledExactlyOnceWith("team-1", { urls: ["turn:relay.example:3478?transport=udp"], secret: "north-secret" })
  expect(state.teamTurn.secret).toBe("north-secret")
  expect(view!.get('[role="status"]').text()).toBe("TURN server saved.")
  expect(secret().element.value).toBe("")
  expect(secret().attributes("placeholder")).toBe("Saved")
  expect(view!.text()).toContain("Leave blank to keep the saved secret.")

  await button("Add TURN URL")!.trigger("click")
  await view!.get('[name="team-turn-url-1"]').setValue("turns:relay.example:5349?transport=tcp")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(central.updateTeamTurnSettings).toHaveBeenLastCalledWith("team-1", { urls: ["turn:relay.example:3478?transport=udp", "turns:relay.example:5349?transport=tcp"] })
  expect(state.teamTurn.secret).toBe("north-secret")
})

test("removal confirms first and deletes the URLs and secret", async () => {
  const { central, state } = await render({ teamTurn: { urls: ["turn:relay.example:3478"], secret: "north-secret" } })
  expect(view!.get<HTMLInputElement>('[name="team-turn-url-0"]').element.value).toBe("turn:relay.example:3478")
  await button("Remove server")!.trigger("click")
  expect(central.updateTeamTurnSettings).not.toHaveBeenCalled()
  const dialog = view!.findAll("button").filter(value => value.text() === "Remove server").at(-1)!
  await dialog.trigger("click")
  await flushPromises()
  expect(central.updateTeamTurnSettings).toHaveBeenCalledExactlyOnceWith("team-1", { urls: [] })
  expect(state.teamTurn).toMatchObject({ urls: [], secret: undefined })
  expect(button("Remove server")).toBeUndefined()
  expect(view!.get<HTMLInputElement>('[name="team-turn-url-0"]').element.value).toBe("")
})

test("plans without the feature link to plans and still allow removing a saved server", async () => {
  const { central } = await render({ teamTurn: { availability: "planRequired", urls: ["turn:relay.example:3478"], secret: "north-secret" } })
  expect(view!.find("form").exists()).toBe(false)
  expect(view!.text()).toContain("Your own TURN server requires the Pro or Enterprise plan.")
  expect(view!.text()).toContain("Your saved server isn’t used: turn:relay.example:3478")
  await button("View plans")!.trigger("click")
  expect(view!.emitted("plans")).toHaveLength(1)
  await button("Remove server")!.trigger("click")
  await view!.findAll("button").filter(value => value.text() === "Remove server").at(-1)!.trigger("click")
  await flushPromises()
  expect(central.updateTeamTurnSettings).toHaveBeenCalledExactlyOnceWith("team-1", { urls: [] })
  expect(button("Remove server")).toBeUndefined()
})

test("a site-wide disable explains the site relay and offers no plan upgrade", async () => {
  await render({ teamTurn: { availability: "disabledBySite" } })
  expect(view!.text()).toContain("Site administrators have turned off team TURN servers.")
  expect(button("View plans")).toBeUndefined()
  expect(button("Remove server")).toBeUndefined()
})

test("mobile hides plan names and the plans link while still allowing saved server removal", async () => {
  const { central } = await render({ teamTurn: { availability: "planRequired", urls: ["turn:relay.example:3478"], secret: "north-secret" } }, true)
  expect(view!.text()).toContain("Your own TURN server is not available for this team.")
  expect(view!.text()).not.toMatch(/Pro|Enterprise|View plans/)
  expect(button("View plans")).toBeUndefined()
  await button("Remove server")!.trigger("click")
  await view!.findAll("button").filter(value => value.text() === "Remove server").at(-1)!.trigger("click")
  await flushPromises()
  expect(central.updateTeamTurnSettings).toHaveBeenCalledExactlyOnceWith("team-1", { urls: [] })
})

test("shows save errors and keeps the typed form for retry", async () => {
  const { central } = await render()
  central.updateTeamTurnSettings.mockRejectedValueOnce(new Error("TURN URLs must use turn: or turns:"))
  await view!.get('[name="team-turn-url-0"]').setValue("turn:relay.example:3478")
  await secret().setValue("north-secret")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("TURN URLs must use turn: or turns:")
  expect(secret().element.value).toBe("north-secret")
  expect(button("Save")!.attributes("disabled")).toBeUndefined()
})
