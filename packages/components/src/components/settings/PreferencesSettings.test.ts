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

test("shows the Updates section on Web hosts whose updater supports auto-download (Play)", async () => {
  configureClient({
    ...host,
    platform: "web",
    updates: stubUpdates,
    settings: {
      ...host.settings,
      getAutoDownloadUpdates: vi.fn(async () => ({ available: true, enabled: true })),
    },
  })
  wrapper = mount(PreferencesSettings, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(wrapper.find("#updates-heading").exists()).toBe(true)
  expect(wrapper.find('[role="switch"]').exists()).toBe(true)
})

test("hides the Updates section on Web hosts whose updater has no auto-download (sideloaded APK)", async () => {
  configureClient({
    ...host,
    platform: "web",
    updates: stubUpdates,
    settings: {
      ...host.settings,
      getAutoDownloadUpdates: vi.fn(async () => ({ available: false, enabled: false })),
    },
  })
  wrapper = mount(PreferencesSettings, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(wrapper.find("#updates-heading").exists()).toBe(false)
})
