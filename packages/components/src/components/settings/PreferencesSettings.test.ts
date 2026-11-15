import { configureClient, getClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { ref } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { setUserTelemetryConsent, userTelemetryConsent } from "../../services/analytics.ts"
import PreferencesSettings from "./PreferencesSettings.vue"

const mockSession = ref<{
  account: { value: { user?: { id: string; name: string } } }
  site: { value?: { telemetryEnabled: boolean } }
  central: { updateTelemetryConsent: ReturnType<typeof vi.fn> }
} | undefined>()

vi.mock("../../composables/useAccountSession.ts", () => ({
  useAccountSession: () => mockSession.value,
}))

const host = getClient()
let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  mockSession.value = undefined
  setUserTelemetryConsent(false)
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
      getAutoDownloadUpdates: vi.fn(async () => ({ enabled: true, pauseOnMetered: true, installSource: "google_play" as const })),
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
      getAutoDownloadUpdates: vi.fn(async () => ({ enabled: false, pauseOnMetered: true, installSource: "apk" as const })),
    },
  })
  wrapper = mount(PreferencesSettings, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(wrapper.find("#updates-heading").exists()).toBe(false)
})

test("shows telemetry consent switch only when site telemetry is enabled and syncs changes to central", async () => {
  const updateTelemetryConsent = vi.fn(async () => {})
  mockSession.value = {
    account: { value: { user: { id: "user-1", name: "Ada" } } },
    site: { value: { telemetryEnabled: true } },
    central: { updateTelemetryConsent },
  }
  wrapper = mount(PreferencesSettings, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(wrapper.find("#privacy-settings-heading").exists()).toBe(true)
  const toggle = wrapper.get('[aria-labelledby="telemetry-consent-label"]')
  await toggle.trigger("click")
  expect(userTelemetryConsent.value).toBe(true)
  expect(updateTelemetryConsent).toHaveBeenCalledWith(expect.objectContaining({ consented: true }))
})
