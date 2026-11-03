import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { CloudflareTurnSettings as Settings, SiteAdministrationApi } from "@deskfleet/client/central"
import CloudflareTurnSettings from "./CloudflareTurnSettings.vue"

function api(enabled: boolean): Pick<SiteAdministrationApi, "cloudflareTurnSettings" | "updateCloudflareTurnSettings"> {
  let settings: Settings = {
    enabled, accountId: enabled ? "your-cloudflare-account" : "", keyId: enabled ? "your-turn-key" : "",
    apiTokenConfigured: enabled, analyticsTokenConfigured: enabled,
  }
  return {
    async cloudflareTurnSettings() { return { ...settings } },
    async updateCloudflareTurnSettings(value) {
      settings = {
        enabled: value.enabled, accountId: value.accountId, keyId: value.keyId,
        apiTokenConfigured: value.apiToken === undefined ? settings.apiTokenConfigured : value.apiToken.length > 0,
        analyticsTokenConfigured: value.analyticsToken === undefined ? settings.analyticsTokenConfigured : value.analyticsToken.length > 0,
      }
      return { ...settings }
    },
  }
}
const meta = {
  title: "Features/Settings/CloudflareTurnSettings",
  component: CloudflareTurnSettings,
  args: { api: api(true) },
  decorators: [() => ({ template: '<div class="mx-auto max-w-3xl"><story /></div>' })],
} satisfies Meta<typeof CloudflareTurnSettings>
export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {}
export const Disabled: Story = { args: { api: api(false) } }
export const LoadError: Story = {
  args: { api: { ...api(false), async cloudflareTurnSettings() { throw new Error("Unable to load Cloudflare TURN settings. Try again.") } } },
}
