import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { AgentInput } from "@deskfleet/protocol/agent"
import { computed, ref, watch } from "vue"
import AgentBacklog from "./AgentBacklog.vue"

const pendingPool: AgentInput[] = [
  {
    id: "inp-pending-1",
    sessionId: "sess-1",
    submissionCommandId: "cmd-10",
    author: { kind: "user", userId: "user-1" },
    content: [{ type: "text", text: "Add dark mode and Chinese locale switchers to the Storybook toolbar." }],
    acceptedSeq: "10",
    state: "pending",
    requestedDelivery: "backlog",
    createdAt: "2026-10-29T14:23:00Z",
  },
  {
    id: "inp-pending-2",
    sessionId: "sess-1",
    submissionCommandId: "cmd-11",
    author: { kind: "user", userId: "user-2" },
    content: [{ type: "text", text: "/compact" }],
    acceptedSeq: "11",
    state: "pending",
    requestedDelivery: "backlog",
    createdAt: "2026-10-29T14:24:00Z",
  },
  {
    id: "inp-pending-3",
    sessionId: "sess-1",
    submissionCommandId: "cmd-12",
    author: { kind: "user", userId: "user-1" },
    content: [{ type: "text", text: "Verify mobile swipe gestures do not hijack horizontally scrollable diffs." }],
    acceptedSeq: "12",
    state: "pending",
    requestedDelivery: "backlog",
    createdAt: "2026-10-29T14:25:00Z",
  },
  {
    id: "inp-pending-4",
    sessionId: "sess-1",
    submissionCommandId: "cmd-13",
    author: { kind: "user", userId: "user-3" },
    content: [{ type: "text", text: "Run typecheck across @deskfleet/web and @deskfleet/desktop before pushing." }],
    acceptedSeq: "13",
    state: "pending",
    requestedDelivery: "backlog",
    createdAt: "2026-10-29T14:26:00Z",
  },
  {
    id: "inp-pending-5",
    sessionId: "sess-1",
    submissionCommandId: "cmd-14",
    author: { kind: "user", userId: "user-2" },
    content: [{ type: "text", text: "Update the changelog summary with the composer icon sizing tweaks." }],
    acceptedSeq: "14",
    state: "pending",
    requestedDelivery: "backlog",
    createdAt: "2026-10-29T14:27:00Z",
  },
  {
    id: "inp-pending-6",
    sessionId: "sess-1",
    submissionCommandId: "cmd-15",
    author: { kind: "user", userId: "user-1" },
    content: [{ type: "text", text: "Squash the WIP commits and open a draft PR with before/after screenshots." }],
    acceptedSeq: "15",
    state: "pending",
    requestedDelivery: "backlog",
    createdAt: "2026-10-29T14:28:00Z",
  },
]

const failedPool: AgentInput[] = [
  {
    id: "inp-failed-1",
    sessionId: "sess-1",
    submissionCommandId: "cmd-20",
    author: { kind: "user", userId: "user-1" },
    content: [{ type: "text", text: "Run the visual regression suite across all viewports." }],
    acceptedSeq: "20",
    state: "failed",
    requestedDelivery: "backlog",
    createdAt: "2026-10-29T14:29:00Z",
    error: "Provider session disconnected while dispatching prompt.",
  },
  {
    id: "inp-failed-2",
    sessionId: "sess-1",
    submissionCommandId: "cmd-21",
    author: { kind: "user", userId: "user-2" },
    content: [{ type: "text", text: "Upload the verification bundle to the staging artifact bucket." }],
    acceptedSeq: "21",
    state: "failed",
    requestedDelivery: "backlog",
    createdAt: "2026-10-29T14:30:00Z",
    error: "Timed out waiting for daemon acknowledgement.",
  },
]

interface BacklogStoryArgs {
  inputs: AgentInput[]
  pendingCount: number
  failedCount: number
  canSteer: boolean
  disabled: boolean
}

const meta = {
  title: "Domain/Agent Session/AgentBacklog",
  component: AgentBacklog,
  tags: ["autodocs"],
  argTypes: {
    inputs: { table: { disable: true } },
    pendingCount: { control: { type: "range", min: 0, max: pendingPool.length, step: 1 } },
    failedCount: { control: { type: "range", min: 0, max: failedPool.length, step: 1 } },
    canSteer: { control: "boolean" },
    disabled: { control: "boolean" },
  },
  args: {
    inputs: [],
    pendingCount: 2,
    failedCount: 0,
    canSteer: true,
    disabled: false,
  },
  parameters: {
    controls: { include: ["pendingCount", "failedCount", "canSteer", "disabled"] },
  },
  render: args => ({
    components: { AgentBacklog },
    setup() {
      const dismissed = ref<string[]>([])
      watch(() => [args.pendingCount, args.failedCount], () => {
        dismissed.value = []
      })
      const inputs = computed(() => [
        ...pendingPool.slice(0, args.pendingCount),
        ...failedPool.slice(0, args.failedCount),
      ].filter(item => !dismissed.value.includes(item.id)))
      const dismiss = (id: string) => {
        dismissed.value = [...dismissed.value, id]
      }
      return { args, inputs, dismiss }
    },
    template: `<AgentBacklog :inputs="inputs" :can-steer="args.canSteer" :disabled="args.disabled" @steer="dismiss" @withdraw="dismiss" @retry="dismiss" />`,
  }),
} satisfies Meta<BacklogStoryArgs>

export default meta
type Story = StoryObj<typeof meta>

export const PendingQueue: Story = {}

export const SinglePending: Story = {
  args: {
    pendingCount: 1,
    failedCount: 0,
  },
}

export const WithFailedInput: Story = {
  args: {
    pendingCount: 2,
    failedCount: 1,
  },
}
