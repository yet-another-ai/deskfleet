import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { storybookElicitation } from "../../../.storybook/storybook-fixtures.ts"
import AgentElicitation from "./AgentElicitation.vue"

const meta = {
  title: "Domain/Agent Session/AgentElicitation",
  component: AgentElicitation,
  tags: ["autodocs"],
  args: {
    elicitation: storybookElicitation,
    disabled: false,
  },
} satisfies Meta<typeof AgentElicitation>

export default meta
type Story = StoryObj<typeof meta>

export const PendingForm: Story = {}

export const PendingUrlConsent: Story = {
  args: {
    elicitation: {
      id: "elic-url-1",
      sessionId: "sess-1",
      runGeneration: 1,
      turnId: "turn-1",
      state: "pending",
      createdAt: "2026-10-29T14:25:00Z",
      request: {
        sessionId: "sess-1",
        toolCallId: "tc-oauth-1",
        mode: "url",
        message: "Authenticate with GitHub to inspect pull request checks.",
        url: "https://github.com/login/oauth/authorize?client_id=demo",
      },
    },
  },
}

export const ResolvedAccepted: Story = {
  args: {
    elicitation: {
      ...storybookElicitation,
      id: "elic-resolved-1",
      state: "resolved",
      resolvedAt: "2026-10-29T14:22:30Z",
      actor: { kind: "user", userId: "user-1" },
      response: {
        action: "accept",
        content: {
          environment: "development",
          includeTests: true,
        },
      },
    },
  },
}
