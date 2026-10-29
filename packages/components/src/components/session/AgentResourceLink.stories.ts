import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AgentResourceLink from "./AgentResourceLink.vue"

const meta = {
  title: "Domain/Markdown & Diagrams/AgentResourceLink",
  component: AgentResourceLink,
  tags: ["autodocs"],
  args: {
    uri: "file:///workspace/deskfleet/packages/components/src/components/common/UiButton.vue",
    name: "UiButton.vue",
  },
} satisfies Meta<typeof AgentResourceLink>

export default meta
type Story = StoryObj<typeof meta>

export const WorkspaceFileResource: Story = {}

export const ExternalWebUrl: Story = {
  args: {
    uri: "https://storybook.js.org/docs/writing-stories",
    name: "Storybook Documentation — Writing Stories",
  },
}
