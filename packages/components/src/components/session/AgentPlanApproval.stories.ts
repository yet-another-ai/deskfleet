import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { CursorPlanApproval } from "../../../../../apps/daemon/src/agents/plans.ts"
import { storybookPlanApproval } from "../../../.storybook/storybook-fixtures.ts"
import AgentPlanApproval from "./AgentPlanApproval.vue"

const basePlan: CursorPlanApproval = {
  name: "Introduce Storybook 10 for @deskfleet/components",
  overview: "Configure Storybook with UnoCSS, Vue I18n, and mock stores, then add stories for all reusable components.",
  plan: "1. Setup `.storybook/main.ts` and `.storybook/preview.ts`.\n2. Provide seeded Pinia stores and mock Desktop API.\n3. Add stories covering props and state variants for every component.",
  todos: [
    { id: "todo-1", content: "Configure Storybook Vite plugins", status: "completed" },
    { id: "todo-2", content: "Seed Pinia and AccountSession fixtures", status: "in_progress" },
    { id: "todo-3", content: "Create stories for all component categories", status: "pending" },
  ],
  isProject: false,
}

const meta = {
  title: "Domain/Agent Session/AgentPlanApproval",
  component: AgentPlanApproval,
  tags: ["autodocs"],
  args: {
    elicitation: storybookPlanApproval,
    plan: basePlan,
    disabled: false,
  },
} satisfies Meta<typeof AgentPlanApproval>

export default meta
type Story = StoryObj<typeof meta>

export const PendingApproval: Story = {}

export const Accepted: Story = {
  args: {
    elicitation: {
      ...storybookPlanApproval,
      id: "elic-plan-accepted",
      state: "resolved",
      actor: { kind: "user", userId: "user-1" },
      response: {
        action: "accept",
        content: {},
      },
    },
  },
}
