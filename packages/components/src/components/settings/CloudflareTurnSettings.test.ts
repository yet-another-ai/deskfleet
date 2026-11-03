import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import type { CloudflareTurnSettings as Settings } from "@deskfleet/client/central"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral } from "../../test/central.ts"
import CloudflareTurnSettings from "./CloudflareTurnSettings.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined })
const configured: Settings = { enabled: true, accountId: "account", keyId: "key", apiTokenConfigured: true, analyticsTokenConfigured: true }
const button = (label: string) => view!.findAll("button").find(value => value.text() === label)!
const field = (name: string) => view!.get<HTMLInputElement>(`input[name="cloudflare-turn-${name}"]`)
function render(central: ReturnType<typeof fakeCentral>["central"]): void {
  view = mount(CloudflareTurnSettings, { props: { api: central }, global: { plugins: [i18n] } })
}

test("enables Cloudflare only with both credentials and clears tokens after saving", async () => {
  const { central, state } = fakeCentral()
  render(central)
  await flushPromises()
  expect(button("Save").attributes("disabled")).toBeDefined()
  expect(view!.find('[name="cloudflare-turn-account-id"]').exists()).toBe(false)
  await view!.get('[role="switch"]').trigger("click")
  await field("account-id").setValue(" account ")
  await field("key-id").setValue(" key ")
  await field("api-token").setValue(" turn-token ")
  expect(button("Save").attributes("disabled")).toBeDefined()
  await view!.get("form").trigger("submit")
  expect(central.updateCloudflareTurnSettings).not.toHaveBeenCalled()
  await field("analytics-token").setValue(" analytics-token ")
  expect(field("api-token").attributes("type")).toBe("password")
  expect(field("analytics-token").attributes("type")).toBe("password")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(central.updateCloudflareTurnSettings).toHaveBeenCalledExactlyOnceWith({ enabled: true, accountId: "account", keyId: "key", apiToken: "turn-token", analyticsToken: "analytics-token" })
  expect(state.cloudflareTurn).toEqual(configured)
  expect(field("api-token").element.value).toBe("")
  expect(field("analytics-token").element.value).toBe("")
  expect(field("api-token").attributes("placeholder")).toBe("Token saved")
  expect(view!.get('[role="status"]').text()).toBe("Cloudflare TURN settings saved.")
  expect(button("Save").attributes("disabled")).toBeDefined()
  expect(central.updateTurnSettings).not.toHaveBeenCalled()
  expect(central.updateSiteSettings).not.toHaveBeenCalled()
})

test("disabling preserves stored tokens and replacing one leaves the other untouched", async () => {
  const { central, state } = fakeCentral({ cloudflareTurn: configured })
  render(central)
  await flushPromises()
  expect(field("api-token").element.value).toBe("")
  await view!.get('[role="switch"]').trigger("click")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(central.updateCloudflareTurnSettings).toHaveBeenLastCalledWith({ enabled: false, accountId: "account", keyId: "key" })
  expect(state.cloudflareTurn.apiTokenConfigured).toBe(true)
  expect(state.cloudflareTurn.analyticsTokenConfigured).toBe(true)
  await view!.get('[role="switch"]').trigger("click")
  await field("api-token").setValue("replacement")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(central.updateCloudflareTurnSettings).toHaveBeenLastCalledWith({ enabled: true, accountId: "account", keyId: "key", apiToken: "replacement" })
})

test("retries loading and retains edits when saving fails", async () => {
  const { central } = fakeCentral({ cloudflareTurn: configured })
  central.cloudflareTurnSettings.mockRejectedValueOnce(new Error("Unable to load Cloudflare settings"))
  render(central)
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("Unable to load Cloudflare settings")
  await button("Try again").trigger("click")
  await flushPromises()
  await field("analytics-token").setValue("replacement")
  central.updateCloudflareTurnSettings.mockRejectedValueOnce(new Error("Analytics token is invalid"))
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("Analytics token is invalid")
  expect(field("analytics-token").element.value).toBe("replacement")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(view!.find('[role="alert"]').exists()).toBe(false)
  expect(field("analytics-token").element.value).toBe("")
})

test("waits for loading and prevents duplicate saves or edits while saving", async () => {
  const { central } = fakeCentral()
  let loaded!: (settings: Settings) => void
  central.cloudflareTurnSettings.mockReturnValueOnce(new Promise(resolve => { loaded = resolve }))
  render(central)
  expect(view!.find("form").exists()).toBe(false)
  loaded(configured)
  await flushPromises()
  await field("key-id").setValue("updated-key")
  let saved!: (settings: Settings) => void
  central.updateCloudflareTurnSettings.mockReturnValueOnce(new Promise(resolve => { saved = resolve }))
  await view!.get("form").trigger("submit")
  await view!.get("form").trigger("submit")
  expect(central.updateCloudflareTurnSettings).toHaveBeenCalledOnce()
  expect(view!.findAll("button, input").every(control => control.attributes("disabled") !== undefined)).toBe(true)
  saved({ ...configured, keyId: "updated-key" })
  await flushPromises()
  expect(field("key-id").attributes("disabled")).toBeUndefined()
})
