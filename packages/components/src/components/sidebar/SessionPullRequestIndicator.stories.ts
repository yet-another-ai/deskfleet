import type { Meta, StoryObj } from "@storybook/vue3-vite"
import SessionPullRequestIndicator from "./SessionPullRequestIndicator.vue"

const meta = {
  title: "Foundational/Display & Badges/SessionPullRequestIndicator",
  component: SessionPullRequestIndicator,
  tags: ["autodocs"],
  args: { pullRequest: { number: 128, title: "Show pull request status", url: "https://github.com/deskfleet/app/pull/128", state: "open" } },
} satisfies Meta<typeof SessionPullRequestIndicator>
export default meta
type Story = StoryObj<typeof meta>
export const Open: Story = {}
export const Draft: Story = { args: { pullRequest: { ...meta.args.pullRequest, state: "draft" } } }
export const Merged: Story = { args: { pullRequest: { ...meta.args.pullRequest, state: "merged" } } }
export const Closed: Story = { args: { pullRequest: { ...meta.args.pullRequest, state: "closed" } } }
