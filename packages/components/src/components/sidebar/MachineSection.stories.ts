import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { useEventBus } from "@vueuse/core"
import { onScopeDispose } from "vue"
import type { GithubPullRequest } from "@deskfleet/client/central"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { githubSettingsChanged } from "../../services/github-settings-events.ts"
import { usePullRequestsStore } from "../../stores/pull-requests.ts"
import { useFleetStore } from "../../stores/fleet.ts"
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

const pullRequests: GithubPullRequest[] = [
  { number: 128, title: "Add GitHub pull request status", url: "https://github.com/deskfleet/app/pull/128", state: "open" },
  { number: 127, title: "Explore faster workspace startup", url: "https://github.com/deskfleet/app/pull/127", state: "draft" },
  { number: 126, title: "Connect GitHub App settings", url: "https://github.com/deskfleet/app/pull/126", state: "merged" },
  { number: 125, title: "Replace legacy session navigation", url: "https://github.com/deskfleet/app/pull/125", state: "closed" },
]

function statusStory(): Story {
  return {
    args: { machine: {
      ...sampleMachine, sessions: [], terminals: [], workspaces: [{
        ...sampleMachine.workspaces[0]!, terminals: [], sessions: pullRequests.map((pr, index) => ({
          id: `pr-${pr.state}`, title: pr.title, provider: "Codex", providerIcon: "openai", providerTemplate: "codex",
          archiveState: "active", lastCompletedSeq: "10", lastReadSeq: index === 0 ? "9" : "10",
        })),
      }],
    } },
    render: args => ({
      components: { MachineSection },
      setup() {
        const account = useAccountSession()!
        const central = account.central
        const originalSettings = central.githubSettings
        const originalPullRequest = central.githubPullRequest
        const originalCatalog = central.catalog
        const fleet = useFleetStore()
        const originalSnapshot = fleet.catalog
        const githubBranches = pullRequests.map(pr => ({
          sessionId: `pr-${pr.state}`, repositories: [{ repository: "deskfleet/app", headRepository: "deskfleet/app", branch: pr.state }],
        }))
        if (fleet.catalog) fleet.catalog = { ...fleet.catalog, githubBranches }
        const bus = useEventBus(githubSettingsChanged)
        central.githubSettings = async () => ({ configured: true, authorized: true, actAsYou: true, login: "octocat", manageUrl: null })
        central.githubPullRequest = async query => ({ pullRequest: pullRequests.find(pr => pr.state === query.branch) ?? null })
        central.catalog = async machineId => {
          const result = await originalCatalog(machineId)
          return { ...result, snapshot: { ...result.snapshot, githubBranches } }
        }
        const store = usePullRequestsStore()
        void central.githubSettings().then(settings => bus.emit({ central, settings }))
        void store.refresh()
        onScopeDispose(() => {
          central.githubSettings = originalSettings; central.githubPullRequest = originalPullRequest; central.catalog = originalCatalog
          fleet.catalog = originalSnapshot
          bus.emit({ central, settings: { configured: false, authorized: false, actAsYou: false, login: null, manageUrl: null } })
        })
        return { args }
      },
      template: "<div class='w-80 p-2 bg-ui-sidebar border border-ui-border rounded-lg'><MachineSection v-bind='args' /></div>",
    }),
  }
}

export const PullRequestStatuses = statusStory()
