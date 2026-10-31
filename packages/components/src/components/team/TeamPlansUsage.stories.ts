import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { provide } from "vue"
import type { TeamBilling } from "@deskfleet/client/billing"
import type { Team } from "@deskfleet/client/central"
import { freeBilling } from "../../../.storybook/billing-fixtures.ts"
import { accountSessionKey, useAccountSession } from "../../composables/useAccountSession.ts"
import TeamPlansUsage from "./TeamPlansUsage.vue"

const meta = {
  title: "Settings/TeamPlansUsage",
  args: { team: { id: "team-1", name: "Design team", role: "owner" }, billing: freeBilling },
  render: args => ({
    components: { TeamPlansUsage },
    setup() {
      const account = useAccountSession()!
      provide(accountSessionKey, {
        ...account,
        central: { ...account.central, billing: async () => args.billing },
      })
      return { args }
    },
    template: '<div style="max-width: 768px; margin: 0 auto"><TeamPlansUsage :team="args.team" /></div>',
  }),
} satisfies Meta<{ team: Team; billing: TeamBilling }>
export default meta
type Story = StoryObj<typeof meta>
export const Owner: Story = {}
export const Member: Story = { args: { billing: { ...freeBilling, canManageBilling: false } } }
export const Subscribed: Story = { args: { billing: {
  ...freeBilling, plan: "go",
  limits: { maxActiveSessions: null, maxTurnsPerSession: null, maxMembers: null, turnBytes: 2_147_483_648 },
  subscription: { plan: "go", status: "active", paidThrough: "2026-12-01T00:00:00Z", cancelAtPeriodEnd: false },
} } }
export const UnavailablePrices: Story = { args: { billing: { ...freeBilling, prices: null } } }
