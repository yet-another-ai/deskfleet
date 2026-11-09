import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AgentAuthStatus from "./AgentAuthStatus.vue"
import AgentLiveNotices from "./AgentLiveNotices.vue"

const meta = {
  title: "Domain/Agent Session/AgentAuthStatus",
  component: AgentAuthStatus,
  args: { status: { kind: "account", label: "Signed in with Claude", account: { email: "developer@example.com", organization: "Workspace", plan: "Team" } } },
} satisfies Meta<typeof AgentAuthStatus>
export default meta
type Story = StoryObj<typeof meta>
export const ConnectedWithNotice: Story = {
  render: args => ({
    components: { AgentAuthStatus, AgentLiveNotices },
    setup: () => ({ args, notices: [{ id: "rate-limit", severity: "warning", title: "Approaching the context limit", description: "The agent will compact the conversation before continuing." }] }),
    template: '<div class="max-w-3xl p-6"><AgentAuthStatus v-bind="args" /><AgentLiveNotices :notices="notices" /></div>',
  }),
}
export const SignedOut: Story = { args: { status: { kind: "none", label: "Not signed in", detail: "Sign in with the agent CLI to continue." } } }
