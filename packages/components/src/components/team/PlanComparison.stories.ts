import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { freeBilling } from "../../../.storybook/billing-fixtures.ts"
import PlanComparison from "./PlanComparison.vue"

const meta = {
  title: "Settings/PlanComparison",
  component: PlanComparison,
  args: {
    interval: "month",
    billing: freeBilling,
    offers: true,
  },
} satisfies Meta<typeof PlanComparison>
export default meta
type Story = StoryObj<typeof meta>
export const Free: Story = {}
export const Member: Story = { args: { offers: false } }
export const Subscribed: Story = {
  args: {
    offers: false,
    billing: { ...meta.args.billing, plan: "go", limits: { maxActiveSessions: null, maxTurnsPerSession: null, maxMembers: null, turnBytes: 2_147_483_648 } },
  },
}

export const Annual: Story = { args: { interval: "year" } }
