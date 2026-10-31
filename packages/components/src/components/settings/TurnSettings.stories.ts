import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { SiteAdministrationApi, TurnSettings as Settings } from "@deskfleet/client/central"
import TurnSettings from "./TurnSettings.vue"

function api(initial: string[]): Pick<SiteAdministrationApi, "turnSettings" | "updateTurnSettings"> {
  let settings: Settings = { urls: [...initial] }
  return {
    async turnSettings() { return { urls: [...settings.urls] } },
    async updateTurnSettings(value) { settings = { urls: [...value.urls] }; return { urls: [...settings.urls] } },
  }
}
const meta = {
  title: "Features/Settings/TurnSettings",
  component: TurnSettings,
  args: { api: api(["turn:primary.example.com:3478?transport=udp", "turns:backup.example.com:5349?transport=tcp"]) },
  decorators: [() => ({ template: '<div class="mx-auto max-w-3xl"><story /></div>' })],
} satisfies Meta<typeof TurnSettings>
export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {}
export const Empty: Story = { args: { api: api([]) } }
export const LoadError: Story = {
  args: { api: { ...api([]), async turnSettings() { throw new Error("Unable to load TURN servers. Try again.") } } },
}
