import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref } from "vue"
import type { SessionTarget } from "../../stores/fleet.ts"
import SessionComposer from "../composer/SessionComposer.vue"
import WorkspaceReEditBanner from "./WorkspaceReEditBanner.vue"

const sampleLocation: SessionTarget = {
  machine: {
    id: "machine-1",
    name: "Studio Mac",
    local: true,
    online: true,
    desktop: true,
    terminals: [],
    sessions: [],
    workspaces: [{ id: "ws-1", name: "deskfleet-sa", directories: [{ path: "/workspace/deskfleet-sa" }], sessions: [], terminals: [] }],
  },
  workspace: { id: "ws-1", name: "deskfleet-sa", directories: [{ path: "/workspace/deskfleet-sa" }], sessions: [], terminals: [] },
}

const meta = {
  title: "Domain/Agent Session/WorkspaceReEditBanner",
  component: WorkspaceReEditBanner,
  tags: ["autodocs"],
  args: {
    sourceMessageId: "msg-stopped-1",
    hasStashedDraft: false,
    disabled: false,
    touch: false,
  },
  render: (args) => ({
    components: { SessionComposer, WorkspaceReEditBanner },
    setup() {
      const draft = ref("在 Super Agent 的设置项中，增加给 Super Agent 改名的功能。")
      return { args, draft, location: sampleLocation }
    },
    template: `
      <SessionComposer :location="location" v-model="draft">
        <template #before-input>
          <WorkspaceReEditBanner v-bind="args" />
        </template>
      </SessionComposer>
    `,
  }),
} satisfies Meta<typeof WorkspaceReEditBanner>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithStashedDraft: Story = {
  args: {
    hasStashedDraft: true,
  },
}

export const NarrowWidth: Story = {
  args: {
    hasStashedDraft: true,
  },
  decorators: [
    () => ({
      template: '<div class="mx-auto w-[340px] max-w-full border border-dashed border-ui-border/50 p-2"><story /></div>',
    }),
  ],
}
