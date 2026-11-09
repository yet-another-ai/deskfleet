import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { computed, provide, ref } from "vue"
import { accountSessionKey, type AccountSession } from "../../composables/useAccountSession.ts"
import type { ComposerAttachment } from "../../services/composer-attachments.ts"
import type { ComposerMention } from "../../services/composer-mentions.ts"
import type { SessionTarget } from "../../stores/fleet.ts"
import type { MachineSummary, WorkspaceSummary, WorktreeSummary } from "../../stores/fleet-types.ts"
import SessionComposer from "./SessionComposer.vue"

const sampleWorktree: WorktreeSummary = {
  id: "wt-sess-1",
  directories: [
    {
      path: "/workspace/.worktrees/sess-1",
      git: {
        branch: "feat/storybook-components",
        head: "a1b2c3d",
        changes: [
          { path: "packages/components/src/components/common/UiButton.vue", status: "modified", additions: 12, deletions: 2 },
        ],
      },
    },
  ],
  terminals: [],
}

const sampleWorkspace: WorkspaceSummary = {
  id: "ws-1",
  name: "deskfleet-monorepo",
  directories: [{ path: "/workspace/deskfleet" }],
  sessions: [],
  terminals: [],
}

const secondaryWorkspace: WorkspaceSummary = {
  id: "ws-2",
  name: "deskfleet-docs",
  directories: [{ path: "/workspace/deskfleet-docs" }],
  sessions: [],
  terminals: [],
}

const sampleMachine: MachineSummary = {
  id: "machine-1",
  name: "MacBook Pro (Studio)",
  local: true,
  online: true,
  desktop: true,
  terminals: [],
  sessions: [],
  workspaces: [sampleWorkspace, secondaryWorkspace],
}

const remoteWorkspace: WorkspaceSummary = {
  id: "ws-remote-1",
  name: "cloud-control-plane",
  directories: [{ path: "/srv/cloud-control-plane" }],
  sessions: [],
  terminals: [],
}

const remoteMachine: MachineSummary = {
  id: "machine-2",
  name: "Linux Build Server",
  local: false,
  online: true,
  desktop: false,
  terminals: [],
  sessions: [],
  workspaces: [remoteWorkspace],
}

const sampleMachines: MachineSummary[] = [sampleMachine, remoteMachine]

const newSessionTarget: SessionTarget = {
  machine: sampleMachine,
  workspace: sampleWorkspace,
}

const existingSessionTarget: SessionTarget = {
  machine: sampleMachine,
  workspace: sampleWorkspace,
  session: {
    id: "sess-1",
    title: "Add Storybook for UI components",
    provider: "Claude Code",
    providerIcon: "claude",
    providerTemplate: "claude-code",
    archiveState: "active",
    context: "worktree",
    worktree: sampleWorktree,
  },
  worktree: sampleWorktree,
}

const sampleAttachments: ComposerAttachment[] = [
  {
    id: "att-1",
    kind: "machine_file",
    name: "uno.config.ts",
    path: "/workspace/deskfleet/packages/components/uno.config.ts",
    uri: "file:///workspace/deskfleet/packages/components/uno.config.ts",
    size: 3_420,
  },
  {
    id: "att-2",
    kind: "pasted_text",
    text: "stack trace line 1\nstack trace line 2",
    lines: 42,
  },
]

const sampleMentions: ComposerMention[] = [
  {
    id: "men-1",
    start: 6,
    end: 21,
    token: "$vueuse-functions",
    reference: {
      kind: "skill",
      id: "vueuse-functions",
      name: "vueuse-functions",
      invocation: "$vueuse-functions",
      providerId: "claude-code",
    },
  },
]

const meta = {
  title: "Domain/Agent Session/SessionComposer",
  component: SessionComposer,
  tags: ["autodocs"],
  args: {
    location: newSessionTarget,
    showTarget: true,
    disabled: false,
    submitting: false,
    activeTurn: false,
    canSteer: false,
    canCancel: false,
    modelValue: "",
    attachments: [],
    mentions: [],
    context: "directory",
    baseBranch: "main",
  },
  render: (args) => ({
    components: { SessionComposer },
    setup() {
      const location = ref(args.location)
      const draft = ref(args.modelValue ?? "")
      const attachments = ref<ComposerAttachment[]>([...(args.attachments ?? [])])
      const mentions = ref<ComposerMention[]>([...(args.mentions ?? [])])
      const context = ref(args.context ?? "directory")
      const baseBranch = ref(args.baseBranch ?? "main")
      function selectMachine(machineId: string): void {
        const machine = sampleMachines.find(item => item.id === machineId)
        if (machine) location.value = { machine, workspace: machine.workspaces[0] }
      }
      function selectWorkspace(workspaceId: string | null): void {
        if (!location.value) return
        if (workspaceId === null) {
          location.value = { machine: location.value.machine }
          return
        }
        const workspace = location.value.machine.workspaces.find(item => item.id === workspaceId)
        if (workspace) location.value = { ...location.value, workspace }
      }
      provide(accountSessionKey, {
        machines: ref(sampleMachines.map(machine => ({ id: machine.id, teamId: "team-1", name: machine.name, online: machine.online }))),
        localMachineId: computed(() => sampleMachine.id),
        selectMachine,
      } as unknown as AccountSession)
      return { args, location, draft, attachments, mentions, context, baseBranch, selectMachine, selectWorkspace }
    },
    template: `
      <SessionComposer
        v-bind="args"
        :location="location"
        v-model="draft"
        v-model:attachments="attachments"
        v-model:mentions="mentions"
        v-model:context="context"
        v-model:base-branch="baseBranch"
        @select-machine="selectMachine"
        @select-workspace="selectWorkspace"
      />
    `,
  }),
} satisfies Meta<typeof SessionComposer>

export default meta
type Story = StoryObj<typeof meta>

export const NewSessionWithTargetBar: Story = {}

export const PrepareDirectoryWithChanges: Story = {
  args: { context: "directory", modelValue: "Start the next task from the latest default branch." },
}

export const ExistingSessionWithAttachmentsAndUsage: Story = {
  args: {
    location: existingSessionTarget,
    showTarget: false,
    modelValue: "Apply $vueuse-functions to simplify the keyboard listener.",
    attachments: sampleAttachments,
    mentions: sampleMentions,
    usage: {
      sessionUpdate: "usage_update",
      used: 64_200,
      size: 200_000,
      cost: {
        amount: 0.38,
        currency: "USD",
      },
    },
  },
}

export const ActiveTurnWithSteerAndCancel: Story = {
  args: {
    location: existingSessionTarget,
    showTarget: false,
    activeTurn: true,
    canSteer: true,
    canCancel: true,
    modelValue: "Also export the Story type from each file.",
    usage: {
      sessionUpdate: "usage_update",
      used: 142_000,
      size: 200_000,
    },
  },
}
