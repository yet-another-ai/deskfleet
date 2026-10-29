import type { Meta, StoryObj } from "@storybook/vue3-vite"
import ComposerCompletions from "./ComposerCompletions.vue"
import type { ComposerCandidate } from "./useComposerCompletions.ts"

const sampleReferenceCandidates: ComposerCandidate[] = [
  {
    key: "file:UiButton.vue",
    kind: "file",
    name: "UiButton.vue",
    description: "packages/components/src/components/common/UiButton.vue",
    token: "@packages/components/src/components/common/UiButton.vue",
  },
  {
    key: "file:SessionComposer.vue",
    kind: "file",
    name: "SessionComposer.vue",
    description: "packages/components/src/components/composer/SessionComposer.vue",
    token: "@packages/components/src/components/composer/SessionComposer.vue",
  },
  {
    key: "session:sess-1",
    kind: "session",
    name: "Add Storybook for UI components",
    description: "deskfleet-monorepo",
    token: "@session:sess-1",
  },
]

const sampleSkillCandidates: ComposerCandidate[] = [
  {
    key: "skill:rust-skills",
    kind: "skill",
    name: "rust-skills",
    description: "Comprehensive Rust coding guidelines",
    token: "$rust-skills",
  },
  {
    key: "skill:vueuse-functions",
    kind: "skill",
    name: "vueuse-functions",
    description: "Apply VueUse composables cleanly",
    token: "$vueuse-functions",
  },
]

const sampleCommandCandidates: ComposerCandidate[] = [
  {
    key: "command:review",
    kind: "command",
    name: "/review",
    description: "Review pending git changes for bugs and style issues",
    token: "/review",
  },
  {
    key: "command:compact",
    kind: "command",
    name: "/compact",
    description: "Summarize conversation context",
    token: "/compact",
  },
]

const meta = {
  title: "Interactive & Collapsible/Pickers & Menus/ComposerCompletions",
  component: ComposerCompletions,
  tags: ["autodocs"],
  args: {
    id: "storybook-completions",
    candidates: sampleReferenceCandidates,
    selected: 0,
    loading: false,
    truncated: false,
    kind: "reference",
  },
  render: (args) => ({
    components: { ComposerCompletions },
    setup() {
      return { args }
    },
    template: `
      <div class="relative mt-64 w-full max-w-xl">
        <ComposerCompletions v-bind="args" />
      </div>
    `,
  }),
} satisfies Meta<typeof ComposerCompletions>

export default meta
type Story = StoryObj<typeof meta>

export const FileAndSessionReferences: Story = {}

export const SkillsList: Story = {
  args: {
    candidates: sampleSkillCandidates,
    kind: "skill",
    selected: 1,
  },
}

export const SlashCommands: Story = {
  args: {
    candidates: sampleCommandCandidates,
    kind: "command",
    selected: 0,
  },
}
