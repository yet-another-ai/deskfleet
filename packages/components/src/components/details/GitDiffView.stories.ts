import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { storybookPatch } from "../../../.storybook/storybook-fixtures.ts"
import GitDiffView from "./GitDiffView.vue"

const baseDiff = {
  sessionId: "sess-1",
  repositoryId: "repo-1",
  path: "packages/components/src/components/common/UiButton.vue",
  kind: "unstaged" as const,
  patch: storybookPatch,
  binary: false,
  truncated: false,
}

const meta = {
  title: "Domain/Git & File Transfer/GitDiffView",
  component: GitDiffView,
  tags: ["autodocs"],
  args: {
    diff: baseDiff,
    loading: false,
    error: null,
    connected: true,
  },
} satisfies Meta<typeof GitDiffView>

export default meta
type Story = StoryObj<typeof meta>

export const UnifiedPatch: Story = {}

export const BinaryFileDiff: Story = {
  args: {
    diff: {
      ...baseDiff,
      path: "apps/desktop/resources/icon.png",
      patch: "",
      binary: true,
    },
  },
}

export const DisconnectedWithError: Story = {
  args: {
    diff: baseDiff,
    loading: false,
    connected: false,
    error: "Git diff RPC timed out after 10000ms",
  },
}
