import { configureClient, getClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import PreferencesSettings from "./PreferencesSettings.vue"

const host = getClient()
let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  configureClient(host)
})

const stubUpdates = {
  get: async () => ({ status: "idle" as const }),
  check: async () => ({ status: "idle" as const }),
  install: async () => {},
  onChanged: () => () => {},
}

test("shows the Updates section on Web hosts installed from Google Play", async () => {
  configureClient({
    ...host,
    platform: "web",
    updates: stubUpdates,
    settings: {
      ...host.settings,
      getAutoDownloadUpdates: vi.fn(async () => ({ enabled: true, installSource: "google_play" as const })),
    },
  })
  wrapper = mount(PreferencesSettings, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(wrapper.find("#updates-heading").exists()).toBe(true)
  expect(wrapper.find('[role="switch"]').exists()).toBe(true)
})

test("hides the Updates section on Web hosts installed from a sideloaded APK", async () => {
  configureClient({
    ...host,
    platform: "web",
    updates: stubUpdates,
    settings: {
      ...host.settings,
      getAutoDownloadUpdates: vi.fn(async () => ({ enabled: false, installSource: "apk" as const })),
    },
  })
  wrapper = mount(PreferencesSettings, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(wrapper.find("#updates-heading").exists()).toBe(false)
})
