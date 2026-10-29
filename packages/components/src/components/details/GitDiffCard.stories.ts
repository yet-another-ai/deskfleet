import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { storybookPatch } from "../../../.storybook/storybook-fixtures.ts"
import GitDiffCard from "./GitDiffCard.vue"

const sampleChange = {
  path: "packages/components/src/components/common/UiButton.vue",
  kind: "unstaged" as const,
  status: "modified" as const,
  additions: 1,
  deletions: 0,
}

const sampleRequest = {
  sessionId: "sess-1",
  repositoryId: "repo-1",
  path: sampleChange.path,
  kind: sampleChange.kind,
}

const meta = {
  title: "Interactive & Collapsible/Collapsible Panels/GitDiffCard",
  component: GitDiffCard,
  tags: ["autodocs"],
  args: {
    repositoryId: "repo-1",
    change: sampleChange,
    expanded: true,
    connected: true,
    panelError: null,
    card: {
      request: sampleRequest,
      loading: false,
      error: null,
      diff: {
        ...sampleRequest,
        patch: storybookPatch,
        binary: false,
        truncated: false,
      },
    },
  },
} satisfies Meta<typeof GitDiffCard>

export default meta
type Story = StoryObj<typeof meta>

export const ExpandedWithDiff: Story = {}

export const Collapsed: Story = {
  args: {
    expanded: false,
  },
}
