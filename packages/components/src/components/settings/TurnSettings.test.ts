import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import type { TurnSettings as Settings } from "@deskfleet/client/central"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral } from "../../test/central.ts"
import TurnSettings from "./TurnSettings.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined })
const button = (label: string) => view!.findAll("button").find(value => value.text() === label)!
function render(central: ReturnType<typeof fakeCentral>["central"]): void {
  view = mount(TurnSettings, { props: { api: central }, global: { plugins: [i18n] } })
}

test("edits and adds TURN URLs in order, then clears the list without changing public site settings", async () => {
  const { central, state } = fakeCentral({ turn: { urls: ["turn:old.example:3478", "turns:backup.example:5349"] } })
  render(central)
  await flushPromises()
  expect(button("Save").attributes("disabled")).toBeDefined()
  await view!.get('[name="turn-url-0"]').setValue("  turn:primary.example:3478?transport=udp  ")
  await button("Add TURN URL").trigger("click")
  expect(button("Save").attributes("disabled")).toBeDefined()
  await view!.get('[name="turn-url-2"]').setValue("turn:third.example:3478?transport=tcp")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(central.updateTurnSettings).toHaveBeenCalledExactlyOnceWith({ urls: ["turn:primary.example:3478?transport=udp", "turns:backup.example:5349", "turn:third.example:3478?transport=tcp"] })
  expect(view!.get('[role="status"]').text()).toBe("TURN servers saved.")
  expect(button("Save").attributes("disabled")).toBeDefined()
  expect(view!.get<HTMLInputElement>('[name="turn-url-0"]').element.value).toBe("turn:primary.example:3478?transport=udp")
  for (let remaining = 3; remaining > 0; remaining -= 1) await view!.get('[aria-label="Remove TURN URL 1"]').trigger("click")
  expect(view!.text()).toContain("No TURN servers configured.")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(central.updateTurnSettings).toHaveBeenLastCalledWith({ urls: [] })
  expect(state.turn.urls).toEqual([])
  expect(central.updateSiteSettings).not.toHaveBeenCalled()
})

test("waits for the URL list and prevents duplicate writes or edits while saving", async () => {
  const { central } = fakeCentral()
  let loaded!: (settings: Settings) => void
  central.turnSettings.mockReturnValueOnce(new Promise(resolve => { loaded = resolve }))
  render(central)
  expect(view!.find("form").exists()).toBe(false)
  expect(view!.find('[role="status"]').exists()).toBe(true)
  loaded({ urls: ["turn:first.example:3478"] })
  await flushPromises()
  await view!.get('[name="turn-url-0"]').setValue("turn:updated.example:3478")
  let saved!: (settings: Settings) => void
  central.updateTurnSettings.mockReturnValueOnce(new Promise(resolve => { saved = resolve }))
  await view!.get("form").trigger("submit")
  await view!.get("form").trigger("submit")
  expect(central.updateTurnSettings).toHaveBeenCalledOnce()
  expect(view!.findAll("button, input").every(control => control.attributes("disabled") !== undefined)).toBe(true)
  saved({ urls: ["turn:updated.example:3478"] })
  await flushPromises()
  expect(button("Add TURN URL").attributes("disabled")).toBeUndefined()
  expect(button("Save").attributes("disabled")).toBeDefined()
})

test("retries loading and preserves edited URLs after a failed save", async () => {
  const { central } = fakeCentral({ turn: { urls: ["turn:first.example:3478"] } })
  central.turnSettings.mockRejectedValueOnce(new Error("Unable to load TURN servers"))
  render(central)
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("Unable to load TURN servers")
  expect(view!.find("form").exists()).toBe(false)
  await button("Try again").trigger("click")
  await flushPromises()
  expect(central.turnSettings).toHaveBeenCalledTimes(2)
  await view!.get('[name="turn-url-0"]').setValue("turn:updated.example:3478")
  central.updateTurnSettings.mockRejectedValueOnce(new Error("TURN shared secret is not configured"))
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("TURN shared secret is not configured")
  expect(view!.get<HTMLInputElement>('[name="turn-url-0"]').element.value).toBe("turn:updated.example:3478")
  expect(button("Save").attributes("disabled")).toBeUndefined()
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(view!.find('[role="alert"]').exists()).toBe(false)
  expect(view!.get('[role="status"]').text()).toBe("TURN servers saved.")
})
