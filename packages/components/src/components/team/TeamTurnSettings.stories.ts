import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { CentralApi, TeamTurnSettings as Settings } from "@deskfleet/client/central"
import TeamTurnSettings from "./TeamTurnSettings.vue"

function api(initial: Settings): Pick<CentralApi, "teamTurnSettings" | "updateTeamTurnSettings"> {
  let settings = structuredClone(initial)
  return {
    async teamTurnSettings() { return structuredClone(settings) },
    async updateTeamTurnSettings(_teamId, value) {
      settings = { ...settings, urls: [...value.urls], secretConfigured: value.urls.length > 0 && (settings.secretConfigured || value.secret !== undefined) }
      return structuredClone(settings)
    },
  }
}
const relay = ["turn:relay.example.com:3478?transport=udp", "turns:relay.example.com:5349?transport=tcp"]
const meta = {
  title: "Features/Team/TeamTurnSettings",
  component: TeamTurnSettings,
  args: { teamId: "team-1", api: api({ availability: "available", urls: relay, secretConfigured: true }) },
  decorators: [() => ({ template: '<div class="mx-auto max-w-3xl"><story /></div>' })],
} satisfies Meta<typeof TeamTurnSettings>
export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {}
export const Empty: Story = { args: { api: api({ availability: "available", urls: [], secretConfigured: false }) } }
export const PlanRequired: Story = { args: { api: api({ availability: "planRequired", urls: relay, secretConfigured: true }) } }
export const DisabledBySite: Story = { args: { api: api({ availability: "disabledBySite", urls: [], secretConfigured: false }) } }
