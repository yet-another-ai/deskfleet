import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { AgentPermission } from "@deskfleet/protocol/agent"
import { computed, ref, watch } from "vue"
import { storybookPermission } from "../../../.storybook/storybook-fixtures.ts"
import AgentPermissions from "./AgentPermissions.vue"

const permissionPool: AgentPermission[] = [
  storybookPermission,
  {
    id: "perm-2",
    sessionId: "sess-1",
    runGeneration: 1,
    turnId: "turn-1",
    state: "pending",
    createdAt: "2026-10-29T14:20:05Z",
    request: {
      sessionId: "sess-1",
      toolCall: {
        toolCallId: "tc-edit-1",
        title: "Edit packages/components/src/styles.css",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/workspace/deskfleet/packages/components/src/styles.css", line: 42 }],
      },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow_conversation", name: "Always allow edits in this conversation", kind: "allow_always" },
        { optionId: "allow_project", name: "Always allow edits in this workspace", kind: "allow_always" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        { optionId: "reject_always", name: "Always reject edits to styles.css", kind: "reject_always" },
      ],
    },
  },
  {
    id: "perm-3",
    sessionId: "sess-1",
    runGeneration: 1,
    turnId: "turn-1",
    state: "pending",
    createdAt: "2026-10-29T14:20:10Z",
    request: {
      sessionId: "sess-1",
      toolCall: {
        toolCallId: "tc-mcp-1",
        title: "deskfleet_remote_mcp_call",
        kind: "other",
        status: "pending",
        rawInput: {
          machineId: "machine-2",
          serverId: "mcp-2",
          name: "github.list_pull_requests",
          arguments: { state: "open" },
        },
      },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    },
  },
  {
    id: "perm-4",
    sessionId: "sess-1",
    runGeneration: 1,
    turnId: "turn-1",
    state: "pending",
    createdAt: "2026-10-29T14:20:15Z",
    request: {
      sessionId: "sess-1",
      toolCall: {
        toolCallId: "tc-push-1",
        title: "git push origin style/composer-footer-icons",
        kind: "execute",
        status: "pending",
        rawInput: { command: "pnpm --filter @deskfleet/desktop test AgentSessionControls AgentFlow && pnpm --filter @deskfleet/web typecheck && git push origin style/composer-footer-icons" },
      },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    },
  },
]

interface PermissionStoryArgs {
  permissions: AgentPermission[]
  count: number
  disabled: boolean
}

const meta = {
  title: "Domain/Agent Session/AgentPermissions",
  component: AgentPermissions,
  tags: ["autodocs"],
  argTypes: {
    permissions: { table: { disable: true } },
    count: { control: { type: "range", min: 0, max: permissionPool.length, step: 1 } },
    disabled: { control: "boolean" },
  },
  args: {
    permissions: [],
    count: 1,
    disabled: false,
  },
  parameters: {
    controls: { include: ["count", "disabled"] },
  },
  render: args => ({
    components: { AgentPermissions },
    setup() {
      const answered = ref<string[]>([])
      watch(() => args.count, () => {
        answered.value = []
      })
      const permissions = computed(() =>
        permissionPool.slice(0, args.count).filter(item => !answered.value.includes(item.id)),
      )
      const respond = (id: string) => {
        answered.value = [...answered.value, id]
      }
      return { args, permissions, respond }
    },
    template: `<AgentPermissions :permissions="permissions" :disabled="args.disabled" @respond="respond" />`,
  }),
} satisfies Meta<PermissionStoryArgs>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const MultiplePending: Story = {
  args: {
    count: 3,
    disabled: false,
  },
}

export const Disabled: Story = {
  args: {
    count: 1,
    disabled: true,
  },
}
