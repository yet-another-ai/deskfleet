import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { provide } from "vue"
import type { TeamBilling } from "@deskfleet/client/billing"
import { freeBilling } from "../../../.storybook/billing-fixtures.ts"
import { accountSessionKey, useAccountSession } from "../../composables/useAccountSession.ts"
import AccountFooter from "./AccountFooter.vue"
import TeamSwitcher from "./TeamSwitcher.vue"
import SidebarNavigation from "./SidebarNavigation.vue"

const meta = {
  title: "Navigation/Billing",
  args: { billing: freeBilling },
  render: args => ({
    components: { AccountFooter, TeamSwitcher, SidebarNavigation },
    setup() {
      const account = useAccountSession()!
      provide(accountSessionKey, { ...account, central: { ...account.central, billing: async () => args.billing } })
    },
    template: `<aside class="flex h-[600px] w-[260px] flex-col border border-ui-border bg-ui-sidebar pt-3">
        <TeamSwitcher /><SidebarNavigation /><div class="min-h-0 flex-1 overflow-y-auto" /><AccountFooter />
      </aside>`,
  }),
} satisfies Meta<{ billing: TeamBilling }>
export default meta
type Story = StoryObj<typeof meta>
export const FreeOwner: Story = {}
export const PaidOwner: Story = { args: { billing: { ...freeBilling, plan: "pro" } } }
export const Member: Story = { args: { billing: { ...freeBilling, canManageBilling: false } } }
export const SelfHosted: Story = { args: { billing: { ...freeBilling, plan: "selfHosted", paymentsAvailable: false } } }
