import type { Meta, StoryObj } from "@storybook/vue3-vite"
import GitChangeFile from "./GitChangeFile.vue"

const meta = {
  title: "Domain/Git & File Transfer/GitChangeFile",
  component: GitChangeFile,
  tags: ["autodocs"],
  args: {
    repositoryId: "repo-1",
    selected: false,
    disabled: false,
    showParent: true,
    disclosure: false,
    expanded: false,
    depth: 0,
    change: {
      path: "packages/components/src/components/common/UiButton.vue",
      kind: "unstaged",
      status: "modified",
      additions: 12,
      deletions: 2,
    },
  },
} satisfies Meta<typeof GitChangeFile>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const AllStatusesShowcase: Story = {
  render: () => ({
    components: { GitChangeFile },
    template: `
      <div class="flex flex-col gap-1 max-w-md">
        <GitChangeFile
          repository-id="repo-1"
          :selected="true"
          :disabled="false"
          show-parent
          :change="{ path: 'packages/components/src/components/common/UiButton.vue', kind: 'unstaged', status: 'modified', additions: 12, deletions: 2 }"
        />
        <GitChangeFile
          repository-id="repo-1"
          :selected="false"
          :disabled="false"
          show-parent
          :change="{ path: 'packages/components/.storybook/main.ts', kind: 'staged', status: 'added', additions: 28, deletions: 0 }"
        />
        <GitChangeFile
          repository-id="repo-1"
          :selected="false"
          :disabled="false"
          show-parent
          :change="{ path: 'packages/components/src/old-helper.ts', kind: 'unstaged', status: 'deleted', additions: 0, deletions: 45 }"
        />
        <GitChangeFile
          repository-id="repo-1"
          :selected="false"
          :disabled="false"
          show-parent
          disclosure
          expanded
          :change="{ path: 'packages/components/src/components/details/GitDiffView.vue', previousPath: 'packages/components/src/components/GitDiffView.vue', kind: 'staged', status: 'renamed', additions: 4, deletions: 1 }"
        />
        <GitChangeFile
          repository-id="repo-1"
          :selected="false"
          :disabled="false"
          show-parent
          :change="{ path: 'packages/components/package.json', kind: 'unstaged', status: 'conflicted', additions: 5, deletions: 5 }"
        />
      </div>
    `,
  }),
}
