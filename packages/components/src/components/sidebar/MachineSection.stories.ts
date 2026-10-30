import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { MachineSummary } from "../../stores/fleet-types.ts"
import MachineSection from "./MachineSection.vue"

const sampleMachine: MachineSummary = {
  id: "machine-1",
  name: "MacBook Pro (Studio)",
  local: true,
  online: true,
  desktop: true,
  terminals: [
    { id: "term-1", title: "zsh — deskfleet", cwd: "/workspace/deskfleet" },
  ],
  sessions: [
    {
      id: "sess-direct-1",
      title: "Quick shell script audit",
      provider: "Claude Code",
      providerIcon: "claude",
      providerTemplate: "claude-code",
      archiveState: "active",
    },
  ],
  workspaces: [
    {
      id: "ws-1",
      name: "deskfleet-monorepo",
      directories: [{ path: "/workspace/deskfleet" }],
      terminals: [
        { id: "term-1", title: "zsh — deskfleet", cwd: "/workspace/deskfleet" },
      ],
      sessions: [
        {
          id: "sess-1",
          title: "Add Storybook for UI components",
          provider: "Claude Code",
          providerIcon: "claude",
          providerTemplate: "claude-code",
          archiveState: "active",
        },
        {
          id: "sess-3",
          title: "Optimize terminal scrollback buffer",
          provider: "Codex",
          providerIcon: "openai",
          providerTemplate: "codex",
          archiveState: "active",
        },
      ],
    },
    {
      id: "ws-2",
      name: "cloud-control-plane",
      directories: [{ path: "/workspace/cloud-api" }],
      terminals: [],
      sessions: [],
    },
  ],
}

const meta = {
  title: "Interactive & Collapsible/Collapsible Panels/MachineSection",
  component: MachineSection,
  tags: ["autodocs"],
  args: {
    machine: sampleMachine,
  },
  render: (args) => ({
    components: { MachineSection },
    setup: () => ({ args }),
    template: "<div class='w-64 p-2 bg-ui-sidebar border border-ui-border rounded-lg'><MachineSection v-bind='args' /></div>",
  }),
} satisfies Meta<typeof MachineSection>

export default meta
type Story = StoryObj<typeof meta>

export const LocalOnlineMachine: Story = {}

export const UnreadResults: Story = {
  args: {
    machine: {
      ...sampleMachine,
      sessions: sampleMachine.sessions.map(session => ({ ...session, lastCompletedSeq: "12" })),
      workspaces: sampleMachine.workspaces.map(workspace => ({
        ...workspace,
        sessions: workspace.sessions.map((session, index) => ({ ...session, lastCompletedSeq: "12", lastReadSeq: index === 0 ? "8" : "12" })),
      })),
    },
  },
}

export const RemoteOfflineMachine: Story = {
  args: {
    machine: {
      ...sampleMachine,
      id: "machine-3",
      name: "Windows GPU Workstation",
      local: false,
      online: false,
      lastSeen: "2026-10-28T09:15:00Z",
    },
  },
}

export const EmptyMachine: Story = {
  args: {
    machine: {
      id: "machine-2",
      name: "Linux Build Server",
      local: false,
      online: true,
      desktop: false,
      terminals: [],
      sessions: [],
      workspaces: [],
    },
  },
}
