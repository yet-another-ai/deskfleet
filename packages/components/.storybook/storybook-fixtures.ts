import { computed, type ComputedRef } from "vue"
import { createPinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import { configureClient } from "@deskfleet/client/platform"
import { DEFAULT_APPEARANCE_SETTINGS } from "@deskfleet/client/appearance"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { CentralApi, CentralEvent, LocalEnrollment, Machine, SiteAdministrationApi, SiteSettings, Team, TeamMember } from "@deskfleet/client/central"
import type { TeamBilling } from "@deskfleet/client/billing"
import type { AiUsageQuery, TeamAiUsage, TeamAiUsageSessions } from "@deskfleet/client/ai-usage"
import type { CatalogDirectory, CatalogSnapshot, CatalogWorkspace } from "@deskfleet/client/catalog"
import type { FileEntry, FileListing, FileTransfer } from "@deskfleet/client/files"
import type { McpServerConfig, McpServerInput, McpServerSnapshot } from "@deskfleet/client/mcp-servers"
import type { ScheduleInput, ScheduleRun, ScheduledTask } from "@deskfleet/client/schedules"
import type { SystemStatus } from "@deskfleet/client/system"
import type { AgentConfiguration } from "@deskfleet/client/agent-configuration"
import type { ProviderDisplay } from "@deskfleet/client/providers"
import type { AgentElicitation, AgentEvent, AgentPermission, AgentSessionRecord, AgentSnapshot } from "../../../apps/daemon/src/agent-protocol.ts"
import { AGENT_PROVIDER_TEMPLATES, type AgentProviderConfig } from "../../../apps/daemon/src/provider-protocol.ts"
import { accountSessionKey, createAccountSession, type AccountSession } from "../src/composables/useAccountSession.ts"
import { appearanceStoreKey, useAppearanceStore } from "../src/stores/appearance.ts"
import { useFleetStore } from "../src/stores/fleet.ts"
import { useAgentSessionsStore } from "../src/stores/agent-sessions.ts"
import { useProvidersStore } from "../src/stores/providers.ts"
import { useTerminalsStore } from "../src/stores/terminals.ts"
import { useLayoutStore } from "../src/stores/layout.ts"
import { usePinnedSessionsStore } from "../src/stores/pinned-sessions.ts"
import { agentResourceContextKey, type AgentResourceContext } from "../src/services/agent-resources.ts"

export const storybookProviders: ProviderDisplay[] = [
  { id: "claude-code", name: "Claude Code", template: "claude-code", icon: "claude" },
  { id: "codex", name: "Codex", template: "codex", icon: "openai" },
  { id: "cursor", name: "Cursor", template: "cursor", icon: "cursor" },
  { id: "grok", name: "Grok", template: "grok", icon: "grok" },
]

export const storybookProviderProfiles: AgentProviderConfig[] = [
  { id: "claude-code", name: "Claude Code", template: "claude-code", icon: "claude", binaryPath: "/usr/local/bin/claude", env: { ANTHROPIC_API_KEY: "sk-ant-***" } },
  { id: "codex", name: "Codex", template: "codex", icon: "openai", binaryPath: "/usr/local/bin/codex", env: {} },
  { id: "cursor", name: "Cursor", template: "cursor", icon: "cursor", binaryPath: "/usr/local/bin/agent", env: {} },
]

export const storybookTeams: Team[] = [
  { id: "team-1", name: "Core Engineering", role: "admin" },
  { id: "team-2", name: "Design Systems", role: "member" },
]

export const storybookMembers: TeamMember[] = [
  { userId: "user-1", name: "Ada Lovelace", email: "ada@deskfleet.dev", role: "admin" },
  { userId: "user-2", name: "Grace Hopper", email: "grace@deskfleet.dev", role: "admin" },
  { userId: "user-3", name: "Alan Turing", email: "alan@deskfleet.dev", role: "member" },
]

export const storybookMachines: Machine[] = [
  { id: "machine-1", teamId: "team-1", name: "MacBook Pro (Studio)", originId: "origin-1", localMachineId: "local-1", online: true, capabilities: { desktop: true }, lastSeenAt: "2026-10-29T14:30:00Z" },
  { id: "machine-2", teamId: "team-1", name: "Linux Build Server", originId: "origin-2", localMachineId: "local-2", online: true, capabilities: { desktop: false }, lastSeenAt: "2026-10-29T14:28:00Z" },
  { id: "machine-3", teamId: "team-1", name: "Windows GPU Workstation", originId: "origin-3", localMachineId: "local-3", online: false, capabilities: { desktop: true }, lastSeenAt: "2026-10-28T09:15:00Z" },
]

export const storybookMcpServers: McpServerConfig[] = [
  { id: "mcp-1", name: "filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"], env: {}, enabled: true },
  { id: "mcp-2", name: "github", transport: "http", url: "https://mcp.github.example/sse", headers: { Authorization: "Bearer ghp_***" }, enabled: true },
  { id: "mcp-3", name: "postgres-Staging", transport: "stdio", command: "uvx", args: ["mcp-server-postgres"], env: { DATABASE_URL: "postgres://localhost/app" }, enabled: false },
]

export const storybookSchedules: ScheduledTask[] = [
  {
    id: "sched-1",
    title: "Daily Dependency Audit",
    enabled: true,
    workspaceId: "ws-1",
    target: { kind: "new", provider: "claude-code", context: "worktree" },
    prompt: "Check outdated dependencies and open a report if security advisories exist.",
    trigger: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
    nextRunAt: "2026-10-30T01:00:00Z",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-29T01:00:00Z",
    lastRun: {
      id: "run-101",
      sessionId: "sess-1",
      state: "completed",
      scheduledFor: "2026-10-29T01:00:00Z",
      startedAt: "2026-10-29T01:00:00Z",
      finishedAt: "2026-10-29T01:02:14Z",
    },
    runs: [
      {
        id: "run-101",
        sessionId: "sess-1",
        state: "completed",
        scheduledFor: "2026-10-29T01:00:00Z",
        startedAt: "2026-10-29T01:00:00Z",
        finishedAt: "2026-10-29T01:02:14Z",
      },
      {
        id: "run-100",
        sessionId: "sess-2",
        state: "failed",
        scheduledFor: "2026-10-28T01:00:00Z",
        startedAt: "2026-10-28T01:00:00Z",
        finishedAt: "2026-10-28T01:00:45Z",
        error: "Provider rate limit exceeded",
      },
    ],
  },
  {
    id: "sched-2",
    title: "Weekly E2E Smoke Suite",
    enabled: false,
    workspaceId: "ws-2",
    target: { kind: "new", provider: "codex", context: "directory" },
    prompt: "Run the full smoke suite and summarize flaky tests.",
    trigger: { kind: "weekly", weekdays: [1, 4], time: "18:30", timeZone: "UTC" },
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-25T00:00:00Z",
    runs: [],
  },
]

export const storybookSystemStatus: SystemStatus = {
  sampledAt: Date.now(),
  cpuUsagePercent: 34.2,
  memoryUsedBytes: 41_231_686_041,
  memoryTotalBytes: 68_719_476_736,
  swapUsedBytes: 1_073_741_824,
  swapTotalBytes: 8_589_934_592,
  cpuModel: "Apple M3 Max",
  logicalCpuCount: 16,
  os: "macOS 15.2",
  arch: "arm64",
  uptimeSeconds: 345_600,
  daemonVersion: "0.4.2",
}

export const storybookSystemHistory: SystemStatus[] = Array.from({ length: 15 }, (_, index) => ({
  ...storybookSystemStatus,
  sampledAt: storybookSystemStatus.sampledAt - (14 - index) * 2000,
  cpuUsagePercent: 20 + ((index * 7) % 45),
  memoryUsedBytes: Math.round(storybookSystemStatus.memoryTotalBytes * ((55 + ((index * 3) % 15)) / 100)),
}))

export const storybookFileEntries: FileEntry[] = [
  { name: "src", path: "/workspace/deskfleet/src", kind: "directory", size: 0, modifiedAt: 1_761_739_200_000 },
  { name: "package.json", path: "/workspace/deskfleet/package.json", kind: "file", size: 2450, modifiedAt: 1_761_737_400_000 },
  { name: "README.md", path: "/workspace/deskfleet/README.md", kind: "file", size: 8192, modifiedAt: 1_761_668_400_000 },
  { name: ".env.example", path: "/workspace/deskfleet/.env.example", kind: "file", size: 512, modifiedAt: 1_760_950_800_000 },
]

export const storybookFileTransfers: FileTransfer[] = [
  {
    id: "tr-1",
    name: "release-bundle.tar.gz",
    kind: "file",
    source: { target: { kind: "local" }, path: "/Users/ada/Downloads/release-bundle.tar.gz" },
    destination: { target: { kind: "machine", machineId: "machine-1", teamId: "team-1" }, path: "/workspace/deskfleet/release-bundle.tar.gz" },
    state: "transferring",
    transferredBytes: 15_728_640,
    totalBytes: 31_457_280,
    bytesPerSecond: 5_242_880,
  },
  {
    id: "tr-2",
    name: "config.json",
    kind: "file",
    source: { target: { kind: "machine", machineId: "machine-1", teamId: "team-1" }, path: "/workspace/deskfleet/config.json" },
    destination: { target: { kind: "local" }, path: "/Users/ada/Desktop/config.json" },
    state: "conflict",
    transferredBytes: 0,
    totalBytes: 4096,
    bytesPerSecond: 0,
  },
  {
    id: "tr-3",
    name: "build-logs.txt",
    kind: "file",
    source: { target: { kind: "machine", machineId: "machine-1", teamId: "team-1" }, path: "/workspace/deskfleet/build-logs.txt" },
    destination: { target: { kind: "local" }, path: "/Users/ada/Desktop/build-logs.txt" },
    state: "completed",
    transferredBytes: 128_000,
    totalBytes: 128_000,
    bytesPerSecond: 0,
  },
]

export const storybookBilling: TeamBilling = {
  plan: "pro",
  limits: {
    maxActiveSessions: 25,
    maxTurnsPerSession: 200,
    maxMembers: 10,
    turnBytes: 10_737_418_240,
  },
  usage: {
    relayedBytes: "3221225472",
    activeSessionCount: 8,
    memberCount: 3,
  },
  period: {
    start: "2026-10-01T00:00:00Z",
    end: "2026-11-01T00:00:00Z",
  },
  nextResetAt: "2026-11-01T00:00:00Z",
  enterpriseOverride: false,
  subscription: {
    plan: "pro",
    status: "active",
    paidThrough: "2026-11-01T00:00:00Z",
    cancelAtPeriodEnd: false,
  },
  paymentsAvailable: true,
  canManageBilling: true,
  enterpriseContactEmail: "sales@deskfleet.dev",
}

export const storybookAiUsage: TeamAiUsage = {
  period: "30d",
  timeZone: "UTC",
  from: "2026-09-30T00:00:00Z",
  to: "2026-10-29T23:59:59Z",
  lastSyncedAt: "2026-10-29T14:00:00Z",
  totals: {
    totalTokens: 4_850_000,
    inputTokens: 3_200_000,
    outputTokens: 1_150_000,
    cachedReadTokens: 400_000,
    cachedWriteTokens: 50_000,
    thoughtTokens: 50_000,
    turnCount: 342,
    reportedTurnCount: 340,
  },
  buckets: [
    { start: "2026-10-25T00:00:00Z", totalTokens: 820_000, turnCount: 58, reportedTurnCount: 58, models: { "claude-sonnet-4-5": 520_000, "gpt-5-codex": 300_000 }, members: { "user-1": 500_000, "user-2": 320_000 } },
    { start: "2026-10-26T00:00:00Z", totalTokens: 640_000, turnCount: 45, reportedTurnCount: 45, models: { "claude-sonnet-4-5": 400_000, "gpt-5-codex": 240_000 }, members: { "user-1": 380_000, "user-2": 260_000 } },
    { start: "2026-10-27T00:00:00Z", totalTokens: 1_120_000, turnCount: 82, reportedTurnCount: 81, models: { "claude-sonnet-4-5": 700_000, "gpt-5-codex": 420_000 }, members: { "user-1": 640_000, "user-2": 480_000 } },
    { start: "2026-10-28T00:00:00Z", totalTokens: 980_000, turnCount: 71, reportedTurnCount: 70, models: { "claude-sonnet-4-5": 600_000, "gpt-5-codex": 380_000 }, members: { "user-1": 560_000, "user-2": 420_000 } },
    { start: "2026-10-29T00:00:00Z", totalTokens: 1_290_000, turnCount: 86, reportedTurnCount: 86, models: { "claude-sonnet-4-5": 730_000, "gpt-5-codex": 560_000 }, members: { "user-1": 720_000, "user-2": 570_000 } },
  ],
  heatmap: [
    { date: "2026-10-25", totalTokens: 820_000, turnCount: 58, reportedTurnCount: 58 },
    { date: "2026-10-26", totalTokens: 640_000, turnCount: 45, reportedTurnCount: 45 },
    { date: "2026-10-27", totalTokens: 1_120_000, turnCount: 82, reportedTurnCount: 81 },
    { date: "2026-10-28", totalTokens: 980_000, turnCount: 71, reportedTurnCount: 70 },
    { date: "2026-10-29", totalTokens: 1_290_000, turnCount: 86, reportedTurnCount: 86 },
  ],
  models: [
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", totalTokens: 2_950_000, turnCount: 210, reportedTurnCount: 210 },
    { id: "gpt-5-codex", name: "GPT-5 Codex", totalTokens: 1_900_000, turnCount: 132, reportedTurnCount: 130 },
  ],
  members: [
    { id: "user-1", name: "Ada Lovelace", totalTokens: 2_800_000, turnCount: 195, reportedTurnCount: 195 },
    { id: "user-2", name: "Grace Hopper", totalTokens: 2_050_000, turnCount: 147, reportedTurnCount: 145 },
  ],
}

export const storybookCatalog: CatalogSnapshot = {
  teamId: "team-1",
  machineId: "machine-1",
  machineName: "MacBook Pro (Studio)",
  workspaces: [
    {
      id: "ws-1",
      name: "deskfleet-monorepo",
      worktrees: [
        { id: "wt-main-1", workspaceId: "ws-1", directories: [{ path: "/workspace/deskfleet" }, { path: "/workspace/deskfleet-docs" }] },
        { id: "wt-sess-1", workspaceId: "ws-1", sessionId: "sess-1", directories: [{ path: "/workspace/.worktrees/sess-1" }] },
        { id: "wt-sess-2", workspaceId: "ws-1", sessionId: "sess-2", directories: [{ path: "/workspace/.worktrees/sess-2" }] },
      ],
    },
    {
      id: "ws-2",
      name: "cloud-control-plane",
      worktrees: [
        { id: "wt-main-2", workspaceId: "ws-2", directories: [{ path: "/workspace/cloud-api" }] },
      ],
    },
  ],
  sessions: [],
}

export const storybookPatch = `diff --git a/packages/components/src/components/common/UiButton.vue b/packages/components/src/components/common/UiButton.vue
index 12a4b8c..89e1f20 100644
--- a/packages/components/src/components/common/UiButton.vue
+++ b/packages/components/src/components/common/UiButton.vue
@@ -10,6 +10,7 @@ export default defineComponent({
     variant: { type: String as PropType<"default" | "primary" | "danger" | "ghost">, default: "default" },
     size: { type: String as PropType<"default" | "sm" | "icon">, default: "default" },
     disabled: Boolean,
+    loading: Boolean,
   },
 })
 </script>
`

export function makeConfiguration(providerId = "claude-code"): AgentConfiguration {
  const provider = storybookProviders.find(p => p.id === providerId) ?? storybookProviders[0]!
  return {
    provider,
    models: {
      id: "model",
      currentValue: "claude-sonnet-4-5",
      options: [
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
      ],
    },
    reasoningEfforts: {
      id: "reasoning_effort",
      currentValue: "medium",
      options: [
        { id: "low", name: "Low" },
        { id: "medium", name: "Medium" },
        { id: "high", name: "High" },
      ],
    },
    modes: {
      id: "mode",
      currentValue: "agent",
      options: [
        { id: "agent", name: "Agent" },
        { id: "plan", name: "Plan" },
        { id: "ask", name: "Ask" },
      ],
    },
    commands: [
      { name: "review", description: "Review pending git changes for bugs and style issues" },
      { name: "compact", description: "Summarize conversation context" },
    ],
    skills: [
      { id: "rust-skills", name: "rust-skills", description: "Comprehensive Rust coding guidelines", invocation: "/rust-skills" },
      { id: "vueuse-functions", name: "vueuse-functions", description: "Apply VueUse composables cleanly", invocation: "/vueuse-functions" },
    ],
  }
}

export const storybookPermission: AgentPermission = {
  id: "perm-1",
  sessionId: "sess-1",
  runGeneration: 1,
  turnId: "turn-1",
  state: "pending",
  createdAt: "2026-10-29T14:20:00Z",
  request: {
    sessionId: "sess-1",
    toolCall: {
      toolCallId: "tc-bash-1",
      title: "pnpm --filter @deskfleet/components test",
      kind: "execute",
      status: "pending",
      rawInput: { command: "pnpm --filter @deskfleet/components test" },
    },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow in session", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  },
}

export const storybookElicitation: AgentElicitation = {
  id: "elic-1",
  sessionId: "sess-1",
  runGeneration: 1,
  turnId: "turn-1",
  state: "pending",
  createdAt: "2026-10-29T14:21:00Z",
  request: {
    sessionId: "sess-1",
    toolCallId: "tc-question-1",
    mode: "form",
    message: "Which target environment should we configure for the Storybook build?",
    requestedSchema: {
      type: "object",
      properties: {
        environment: {
          type: "string",
          title: "Environment",
          oneOf: [
            { const: "development", title: "Development (Recommended)", description: "Interactive hot-reload with mock daemon state" },
            { const: "static", title: "Static Docs Bundle", description: "Pre-built static HTML for CI artifacts" },
          ],
        },
        includeTests: {
          type: "boolean",
          title: "Include interaction tests",
          description: "Run play functions automatically",
        },
      },
      required: ["environment"],
    },
  },
}

export const storybookPlanApproval: AgentElicitation = {
  id: "elic-plan-1",
  sessionId: "sess-1",
  runGeneration: 1,
  turnId: "turn-1",
  state: "pending",
  createdAt: "2026-10-29T14:22:00Z",
  request: {
    sessionId: "sess-1",
    toolCallId: "tc-plan-1",
    mode: "form",
    message: "Introduce Storybook 10 for @deskfleet/components",
    requestedSchema: { type: "object", properties: {} },
    _meta: {
      deskfleet: {
        cursorPlan: {
          name: "Introduce Storybook 10 for @deskfleet/components",
          overview: "Configure Storybook with UnoCSS, Vue I18n, and mock stores, then add stories for all 130 reusable components.",
          plan: "1. Setup `.storybook/main.ts` and `.storybook/preview.ts`.\n2. Provide seeded Pinia stores and mock Desktop API.\n3. Add stories covering props and state variants for every component.",
          todos: [
            { id: "todo-1", content: "Configure Storybook Vite plugins", status: "completed" },
            { id: "todo-2", content: "Seed Pinia and AccountSession fixtures", status: "in_progress" },
            { id: "todo-3", content: "Create stories for all component categories", status: "pending" },
          ],
          isProject: false,
        },
      },
    },
  },
}

export const storybookSessionSnapshot: AgentSnapshot = {
  session: {
    id: "sess-1",
    workspaceId: "ws-1",
    provider: "claude-code",
    title: "Add Storybook for UI components",
    context: "worktree",
    lifecycle: "ready",
    archiveState: "active",
    lastEventSeq: "6",
    createdAt: "2026-10-29T14:00:00Z",
    updatedAt: "2026-10-29T14:25:00Z",
    capabilities: { steering: true, resume: true },
  },
  runs: [{ sessionId: "sess-1", generation: 1, state: "running", startedAt: "2026-10-29T14:00:00Z" }],
  inputs: [
    {
      id: "inp-1",
      sessionId: "sess-1",
      submissionCommandId: "cmd-1",
      author: { kind: "user", userId: "Ada Lovelace" },
      content: [{ type: "text", text: "Let's add Storybook stories for all reusable Vue components in @deskfleet/components." }],
      acceptedSeq: "1",
      state: "delivered",
      requestedDelivery: "backlog",
      actualDelivery: "turn_start",
      createdAt: "2026-10-29T14:00:05Z",
    },
    {
      id: "inp-2",
      sessionId: "sess-1",
      submissionCommandId: "cmd-2",
      author: { kind: "user", userId: "Grace Hopper" },
      content: [{ type: "text", text: "Make sure dark mode and Chinese locale can be toggled from the toolbar." }],
      acceptedSeq: "5",
      state: "pending",
      requestedDelivery: "backlog",
      createdAt: "2026-10-29T14:23:00Z",
    },
  ],
  turns: [
    {
      id: "turn-1",
      sessionId: "sess-1",
      initialInputId: "inp-1",
      dispatchCommandId: "cmd-1",
      runGeneration: 1,
      state: "running",
      startedAt: "2026-10-29T14:00:06Z",
      usage: {
        inputTokens: 14_200,
        outputTokens: 1_850,
        cachedReadTokens: 8_000,
        totalTokens: 24_050,
      },
    },
  ],
  permissions: [storybookPermission],
  elicitations: [storybookElicitation],
}

export const storybookSessionEvents: AgentEvent[] = [
  {
    sessionId: "sess-1",
    seq: "1",
    kind: "input",
    payload: storybookSessionSnapshot.inputs[0]!,
    createdAt: "2026-10-29T14:00:05Z",
    runGeneration: 1,
    turnId: "turn-1",
  },
  {
    sessionId: "sess-1",
    seq: "2",
    kind: "acp",
    payload: {
      sessionId: "sess-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Inspecting the component directory structure under `packages/components/src/components`." },
      },
    },
    createdAt: "2026-10-29T14:00:10Z",
    runGeneration: 1,
    turnId: "turn-1",
  },
  {
    sessionId: "sess-1",
    seq: "3",
    kind: "acp",
    payload: {
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-read-1",
        title: "Read packages/components/uno.config.ts",
        kind: "read",
        status: "completed",
        locations: [{ path: "/workspace/deskfleet/packages/components/uno.config.ts", line: 1 }],
      },
    },
    createdAt: "2026-10-29T14:00:15Z",
    runGeneration: 1,
    turnId: "turn-1",
  },
  {
    sessionId: "sess-1",
    seq: "4",
    kind: "acp",
    payload: {
      sessionId: "sess-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Configure Storybook with UnoCSS and Vue I18n", priority: "high", status: "completed" },
          { content: "Create stories for all 130 components", priority: "high", status: "in_progress" },
          { content: "Verify controls and state variants", priority: "medium", status: "pending" },
        ],
      },
    },
    createdAt: "2026-10-29T14:00:25Z",
    runGeneration: 1,
    turnId: "turn-1",
  },
  {
    sessionId: "sess-1",
    seq: "5",
    kind: "acp",
    payload: {
      sessionId: "sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "I have inspected the component hierarchy and set up the Storybook configuration.\n\n```ts\nexport const variant = 'primary'\n```\n\nNext, I will run the test suite to verify the component stories.",
        },
      },
    },
    createdAt: "2026-10-29T14:01:00Z",
    runGeneration: 1,
    turnId: "turn-1",
  },
  {
    sessionId: "sess-1",
    seq: "6",
    kind: "permission",
    payload: storybookPermission,
    createdAt: "2026-10-29T14:20:00Z",
    runGeneration: 1,
    turnId: "turn-1",
  },
]

export const storybookArchivedSessionRecord: AgentSessionRecord = {
  id: "sess-2",
  workspaceId: "ws-1",
  provider: "codex",
  title: "Refactor WebRTC signaling channel",
  context: "worktree",
  lifecycle: "ready",
  archiveState: "archived",
  lastEventSeq: "2",
  createdAt: "2026-10-25T10:00:00Z",
  updatedAt: "2026-10-25T11:30:00Z",
  capabilities: { steering: true, resume: true },
}

export function createStorybookCentral(): CentralApi & SiteAdministrationApi {
  const listeners = new Set<(event: CentralEvent) => void>()
  let site: SiteSettings = {
    siteName: "DeskFleet Cloud",
    announcement: "Scheduled maintenance on Sunday 02:00 UTC.",
    allowTeamCreation: true,
    termsOfServiceUrl: "https://deskfleet.dev/terms",
    privacyTermsUrl: "https://deskfleet.dev/privacy",
  }
  let registrationEnabled = true
  let enrollment: LocalEnrollment = {
    configured: true,
    connected: true,
    revoked: false,
    serverUrl: "https://fleet.deskfleet.dev",
    machineId: "machine-1",
    teamId: "team-1",
    identity: { originId: "origin-1", machineId: "local-1" },
    machineName: "MacBook Pro (Studio)",
  }
  const teams = structuredClone(storybookTeams)
  const members = structuredClone(storybookMembers)
  const machines = structuredClone(storybookMachines)
  const mcpServers = structuredClone(storybookMcpServers)
  const schedules = structuredClone(storybookSchedules)

  return {
    status: async () => ({
      serverUrl: "https://fleet.deskfleet.dev",
      siteAdmin: true,
      user: { id: "user-1", name: "Ada Lovelace", email: "ada@deskfleet.dev" },
    }),
    login: async () => {},
    logout: async () => {},
    openAccountSettings: async () => {},
    billing: async () => structuredClone(storybookBilling),
    checkout: async () => {},
    billingPortal: async () => {},
    site: async () => ({ ...site }),
    siteSettings: async () => ({ ...site }),
    updateSiteSettings: async (next: SiteSettings) => {
      site = { ...next }
      return { ...site }
    },
    billingTeams: async () => [
      { id: "team-1", name: "Core Engineering", billing: structuredClone(storybookBilling) },
      { id: "team-2", name: "Design Systems", billing: { ...structuredClone(storybookBilling), plan: "free", enterpriseOverride: true } },
    ],
    setEnterprise: async () => {},
    registrationPolicy: async () => ({ registrationEnabled }),
    updateRegistration: async (enabled: boolean) => { registrationEnabled = enabled },
    users: async () => [
      { id: "user-1", name: "Ada Lovelace", email: "ada@deskfleet.dev", disabled: false },
      { id: "user-2", name: "Grace Hopper", email: "grace@deskfleet.dev", disabled: false },
      { id: "user-3", name: "Alan Turing", email: "alan@deskfleet.dev", disabled: true },
    ],
    disableUser: async () => {},
    reauthenticate: async () => {},
    teams: async () => structuredClone(teams),
    createTeam: async (name: string) => {
      const created: Team = { id: `team-${teams.length + 1}`, name, role: "admin" }
      teams.push(created)
      return created
    },
    members: async () => structuredClone(members),
    teamUsage: async () => ({ relayedBytes: "3221225472", activeSessionCount: 8, memberCount: members.length }),
    aiUsage: async (_teamId: string, query: AiUsageQuery) => ({
      ...structuredClone(storybookAiUsage),
      period: query.period ?? storybookAiUsage.period,
      timeZone: query.timeZone ?? storybookAiUsage.timeZone,
    }),
    aiUsageSessions: async (_teamId: string, query: { date: string; timeZone?: string }): Promise<TeamAiUsageSessions> => ({
      date: query.date,
      timeZone: query.timeZone ?? "UTC",
      truncated: false,
      sessions: [
        {
          sessionId: "sess-1",
          title: "Add Storybook for UI components",
          machineId: "machine-1",
          machineName: "MacBook Pro (Studio)",
          turnCount: 14,
          reportedTurnCount: 14,
          totalTokens: 420_000,
          inputTokens: 280_000,
          outputTokens: 90_000,
          cachedReadTokens: 40_000,
          cachedWriteTokens: 5_000,
          thoughtTokens: 5_000,
        },
      ],
    }),
    renameTeam: async (teamId: string, name: string) => {
      const found = teams.find(t => t.id === teamId) ?? teams[0]!
      found.name = name
      return { ...found }
    },
    invite: async () => ({ token: "inv_storybook_demo_998877", expiresAt: "2026-11-05T12:00:00Z" }),
    acceptInvite: async () => teams[0]!,
    setMemberRole: async (_teamId: string, userId: string, role: "admin" | "member") => {
      const m = members.find(item => item.userId === userId)
      if (m) m.role = role
    },
    removeMember: async () => {},
    machines: async () => structuredClone(machines),
    renameMachine: async (machineId: string, name: string) => {
      const m = machines.find(item => item.id === machineId) ?? machines[0]!
      m.name = name
      return { ...m }
    },
    removeMachine: async () => {},
    enrollHeadless: async (teamId: string, input: { name: string; originId: string; localMachineId: string }) => {
      const created: Machine = {
        id: `machine-${machines.length + 1}`,
        teamId,
        name: input.name,
        originId: input.originId,
        localMachineId: input.localMachineId,
        online: true,
        capabilities: {},
        lastSeenAt: new Date().toISOString(),
      }
      return { machine: created, token: "df_machine_tok_demo123456" }
    },
    localEnrollment: async () => ({ ...enrollment }),
    enrollLocal: async (teamId: string, name?: string) => {
      enrollment = { ...enrollment, configured: true, revoked: false, teamId, machineName: name || enrollment.machineName }
      return { ...enrollment }
    },
    catalog: async (machineId: string) => ({
      machineId,
      snapshot: structuredClone(storybookCatalog),
      lastObservedAt: "2026-10-29T14:25:00Z",
      providers: { providers: structuredClone(storybookProviders) },
    }),
    sessions: async () => [
      {
        session: storybookSessionSnapshot.session,
        turns: [{ id: "turn-1", state: "running" }],
        permissions: [{ id: "perm-1", state: "pending", createdAt: "2026-10-29T14:20:00Z" }],
        elicitations: [{ id: "elic-1", state: "pending", createdAt: "2026-10-29T14:21:00Z" }],
      },
    ],
    session: async () => ({
      snapshot: structuredClone(storybookSessionSnapshot),
      lastEventSeq: "6",
      lastObservedAt: "2026-10-29T14:25:00Z",
    }),
    events: async () => ({
      events: structuredClone(storybookSessionEvents),
      lastEventSeq: "6",
    }),
    rpc: async <T = unknown>(_machineId: string, method: string, params: unknown): Promise<T> => {
      if (method === "mcpServerList") {
        const snapshot: McpServerSnapshot = { revision: "storybook-rev-1", servers: structuredClone(mcpServers) }
        return snapshot as T
      }
      if (method === "mcpServerCreate") {
        const input = (params as { server: McpServerInput }).server
        const created = { ...input, id: `mcp-${mcpServers.length + 1}` } as McpServerConfig
        mcpServers.push(created)
        return created as T
      }
      if (method === "mcpServerUpdate") {
        const { serverId, changes } = params as { serverId: string; changes: McpServerInput }
        const created = { ...changes, id: serverId } as McpServerConfig
        return created as T
      }
      if (method === "mcpServerRemove") return null as T
      if (method === "scheduleList") return structuredClone(schedules) as T
      if (method === "scheduleCreate") {
        const input = (params as { schedule: ScheduleInput }).schedule
        return { ...storybookSchedules[0]!, ...input, id: `sched-${schedules.length + 1}` } as T
      }
      if (method === "scheduleUpdate") {
        const { scheduleId, changes } = params as { scheduleId: string; changes: Partial<ScheduleInput> }
        const found = schedules.find(s => s.id === scheduleId) ?? schedules[0]!
        return { ...found, ...changes } as T
      }
      if (method === "scheduleRun") {
        const run: ScheduleRun = {
          id: `run-${Date.now()}`,
          sessionId: "sess-1",
          state: "running",
          scheduledFor: new Date().toISOString(),
          startedAt: new Date().toISOString(),
        }
        return run as T
      }
      if (method === "scheduleDelete") return null as T
      return {} as T
    },
    createPeer: async () => ({
      peerId: "peer-1",
      authorization: {
        peerId: "peer-1",
        serverId: "srv-1",
        teamId: "team-1",
        actor: { kind: "user", userId: "user-1", deviceId: "dev-1" },
        targetMachine: { id: "machine-1", originId: "origin-1", localMachineId: "local-1" },
        purpose: "agent",
        actions: [],
        issuedAt: "2026-10-29T14:00:00Z",
        expiresAt: "2026-10-29T16:00:00Z",
        signature: "sig",
      },
      iceServers: [],
    }),
    offerPeer: async () => ({ sdp: "" }),
    startPeer: async () => {},
    candidatePeer: async () => {},
    closePeer: async () => {},
    onEvent: (listener: (event: CentralEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function createStorybookDesktopApi(): DeskfleetDesktopApi {
  const central = createStorybookCentral()
  const subscribe = () => () => {}
  const profiles = structuredClone(storybookProviderProfiles)
  let keepAwake = false
  let launchAtStartup = false
  let worktreeRoot: string | null = "/Users/ada/.deskfleet/worktrees"
  let notifications = { enabled: true, taskCompleted: true, taskNeedsInput: true }
  let appearance = { ...DEFAULT_APPEARANCE_SETTINGS }

  return {
    platform: "darwin",
    locale: "en-US",
    target: { id: "machine-1", local: true },
    central,
    siteAdministration: central,
    onboarding: {
      get: async () => ({ step: "complete" }),
      permissions: async () => ({
        screenCapturePermission: { status: "granted" },
        accessibilityPermission: { status: "denied" },
        fullDiskAccessPermission: { status: "granted" },
      }),
      requestPermission: async () => ({
        screenCapturePermission: { status: "granted" },
        accessibilityPermission: { status: "granted" },
        fullDiskAccessPermission: { status: "granted" },
      }),
      advancePermission: async () => ({ step: "account" }),
      complete: async () => ({ step: "complete" }),
    },
    appearance: {
      get: async () => ({ ...appearance }),
      set: async (next) => {
        appearance = { ...next }
        return { ...appearance }
      },
      onChanged: subscribe,
    },
    applications: {
      scan: async () => [
        { id: "vscode", name: "Visual Studio Code", kind: "editor" },
        { id: "cursor", name: "Cursor", kind: "editor" },
        { id: "zed", name: "Zed", kind: "editor" },
        { id: "terminal", name: "Terminal", kind: "terminal" },
        { id: "finder", name: "Finder", kind: "fileManager" },
      ],
      openWorkspace: async () => {},
    },
    updates: {
      get: async () => ({ status: "downloaded", version: "0.4.2", percent: 100 }),
      install: async () => {},
      onChanged: subscribe,
    },
    settings: {
      get: async () => ({ enabled: true, status: "running" }),
      setLocalAgentEnabled: async (enabled) => ({ enabled, status: enabled ? "running" : "stopped" }),
      getLaunchAtStartup: async () => ({ available: true, enabled: launchAtStartup }),
      setLaunchAtStartup: async (enabled) => ({ available: true, enabled: (launchAtStartup = enabled) }),
      getKeepAwake: async () => ({ enabled: keepAwake }),
      setKeepAwake: async (enabled) => ({ enabled: (keepAwake = enabled) }),
      getWorktreeRoot: async () => ({ root: worktreeRoot, defaultRoot: "/Users/ada/.deskfleet/worktrees" }),
      setWorktreeRoot: async (root) => ({ root: (worktreeRoot = root), defaultRoot: "/Users/ada/.deskfleet/worktrees" }),
      chooseWorktreeRoot: async () => "/Users/ada/CustomWorktrees",
      getNotifications: async () => ({ ...notifications }),
      setNotifications: async (next) => {
        notifications = { ...next }
        return { ...notifications }
      },
      onChanged: subscribe,
    },
    catalog: {
      list: async () => structuredClone(storybookCatalog),
      createWorkspace: async (name: string, directories: CatalogDirectory[]): Promise<CatalogWorkspace> => ({
        id: `ws-${Date.now()}`,
        name,
        worktrees: [{ id: `wt-${Date.now()}`, workspaceId: "ws-new", directories }],
      }),
      updateWorkspace: async (id: string, name: string, directories: CatalogDirectory[]): Promise<CatalogWorkspace> => ({
        id,
        name,
        worktrees: [{ id: `wt-${id}`, workspaceId: id, directories }],
      }),
      deleteWorkspace: async () => {},
      onChanged: subscribe,
    },
    filesystem: {
      listDirectories: async (path = "/workspace") => ({
        path,
        parentPath: path === "/" ? null : "/workspace",
        homePath: "/Users/ada",
        roots: [{ name: "/", path: "/" }, { name: "Home", path: "/Users/ada" }],
        directories: [
          { name: "deskfleet", path: `${path === "/" ? "" : path}/deskfleet`, hidden: false },
          { name: "cloud-api", path: `${path === "/" ? "" : path}/cloud-api`, hidden: false },
          { name: "design-tokens", path: `${path === "/" ? "" : path}/design-tokens`, hidden: false },
          { name: ".config", path: `${path === "/" ? "" : path}/.config`, hidden: true },
        ],
      }),
    },
    files: {
      list: async (_target, path = "/workspace/deskfleet"): Promise<FileListing> => ({
        path,
        parentPath: "/workspace",
        homePath: "/Users/ada",
        roots: [{ name: "/", path: "/" }, { name: "Workspace", path: "/workspace" }],
        entries: structuredClone(storybookFileEntries),
      }),
      chooseLocalDirectory: async () => ({
        path: "/Users/ada/Projects",
        parentPath: "/Users/ada",
        homePath: "/Users/ada",
        roots: [{ name: "/", path: "/" }],
        entries: structuredClone(storybookFileEntries),
        grantId: "grant-local-1",
      }),
      enqueue: async () => "tr-new",
      transfers: async () => structuredClone(storybookFileTransfers),
      cancel: async () => {},
      retry: async () => {},
      onChanged: subscribe,
      resolveResource: async ({ uri }) => ({
        name: uri.split("/").pop() || "resource.ts",
        path: "/workspace/deskfleet/src/resource.ts",
        kind: "file",
        size: 1420,
        modifiedAt: 1_761_739_200_000,
      }),
      readResource: async ({ uri }) => ({
        data: new TextEncoder().encode(`// Sample content for ${uri}\nexport const ready = true\n`),
        name: uri.split("/").pop() || "resource.ts",
        mimeType: "text/plain",
      }),
      saveResource: async () => "/Users/ada/Downloads/resource.ts",
      uploadAttachment: async ({ name, data }) => ({
        path: `/workspace/.deskfleet/uploads/${name}`,
        uri: `file:///workspace/.deskfleet/uploads/${encodeURIComponent(name)}`,
        name,
        size: data.byteLength,
      }),
    },
    providers: {
      list: async () => ({
        revision: "storybook-rev-1",
        templates: [...AGENT_PROVIDER_TEMPLATES],
        providers: structuredClone(profiles),
      }),
      display: async () => ({
        revision: "storybook-rev-1",
        providers: structuredClone(storybookProviders),
      }),
      create: async (input) => ({ ...input, id: `prov-${Date.now()}` }),
      update: async (id, changes) => ({ ...(profiles[0]!), ...changes, id }),
      remove: async () => {},
      test: async (provider) => ({ agentName: provider.name }),
      probe: async (provider) => ({
        status: "found",
        binaryPath: provider.binaryPath || `/usr/local/bin/${provider.template}`,
        version: "1.4.0",
        auth: "authenticated",
        installable: true,
        loginAvailable: true,
      }),
      install: async () => ({ id: "term-install", title: "Install Provider", cwd: "/workspace", cols: 80, rows: 24, status: "running" }),
      login: async () => ({ id: "term-login", title: "Provider Login", cwd: "/workspace", cols: 80, rows: 24, status: "running" }),
      onChanged: subscribe,
    },
    agent: {
      offer: async () => ({ sdp: "" }),
      candidate: async () => {},
      close: async () => {},
      onEvent: subscribe,
    },
    terminal: {
      list: async () => [
        { id: "term-1", title: "zsh — deskfleet", cwd: "/workspace/deskfleet", cols: 100, rows: 30, status: "running", worktreeId: "wt-sess-1" },
        { id: "term-2", title: "pnpm test", cwd: "/workspace/deskfleet", cols: 100, rows: 30, status: "exited", exitCode: 0, worktreeId: "wt-sess-1" },
      ],
      dial: async (opts) => ({
        id: opts.terminalId,
        title: "zsh",
        cwd: "/workspace/deskfleet",
        cols: opts.mode === "create" ? (opts.cols ?? 80) : 80,
        rows: opts.mode === "create" ? (opts.rows ?? 24) : 24,
        status: "running",
      }),
      hangup: async () => {},
      onSessionEvent: subscribe,
      offer: async () => ({ sdp: "" }),
      candidate: async () => {},
      close: async () => {},
      onEvent: subscribe,
    },
    desktop: {
      target: async () => ({ id: "machine-1", name: "MacBook Pro (Studio)", online: true, desktop: true }),
      capabilities: async () => ({
        displays: [
          { id: 1, width: 1728, height: 1117, refreshRateHz: 120, codecs: ["h264", "av1"] },
          { id: 2, width: 2560, height: 1440, refreshRateHz: 60, codecs: ["h264", "av1"] },
        ],
        audio: true,
      }),
      offer: async () => ({ sdp: "" }),
      candidate: async () => {},
      start: async () => {},
      close: async () => {},
      onEvent: subscribe,
    },
    system: {
      status: async () => ({ ...storybookSystemStatus, sampledAt: Date.now() }),
    },
  }
}

export function createStorybookRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: { template: "<div />" } },
      { path: "/admin", name: "site-admin", component: { template: "<div />" } },
      { path: "/schedules/:scheduleId?", name: "schedules", component: { template: "<div />" }, props: true },
      { path: "/workspaces/:workspaceId", name: "workspace", component: { template: "<div />" }, props: true },
      { path: "/worktrees/:worktreeId", name: "worktree", component: { template: "<div />" }, props: true },
      { path: "/sessions/archived", name: "archived-sessions", component: { template: "<div />" } },
      { path: "/sessions/:sessionId", name: "session", component: { template: "<div />" }, props: true },
      { path: "/machines/:machineId/control", name: "machine-control", component: { template: "<div />" }, props: true },
      { path: "/machines/:machineId/terminals", name: "machine-terminals", component: { template: "<div />" }, props: true },
      { path: "/machines/:machineId/desktop", name: "machine-desktop", component: { template: "<div />" }, props: true },
      { path: "/terminals/:terminalId", name: "terminal", component: { template: "<div />" }, props: true },
      { path: "/settings", name: "settings", component: { template: "<div />" } },
      { path: "/settings/preferences", name: "settings-preferences", component: { template: "<div />" } },
      { path: "/settings/appearance", name: "settings-appearance", component: { template: "<div />" } },
      { path: "/settings/notifications", name: "settings-notifications", component: { template: "<div />" } },
      { path: "/settings/agents", name: "settings-agents", component: { template: "<div />" } },
      { path: "/settings/mcp-servers", name: "settings-mcp-servers", component: { template: "<div />" } },
      { path: "/team/settings", name: "team-settings", component: { template: "<div />" } },
      { path: "/team/settings/plans", name: "team-settings-plans", component: { template: "<div />" } },
      { path: "/team/settings/ai-usage", name: "team-settings-ai-usage", component: { template: "<div />" } },
      { path: "/:pathMatch(.*)*", redirect: "/" },
    ],
  })
}

export function createSeededStorybookState() {
  const api = createStorybookDesktopApi()
  configureClient(api)

  const pinia = createPinia()
  const appearance = useAppearanceStore(pinia)
  appearance.ready = true

  const providers = useProvidersStore(pinia)
  providers.providers = structuredClone(storybookProviders)
  providers.selectedId = "claude-code"
  providers.ready = true
  providers.loaded = true
  providers.refresh = async () => {}

  const agents = useAgentSessionsStore(pinia)
  agents.state = "connected"
  agents.sessions = {
    "sess-1": structuredClone(storybookSessionSnapshot.session),
    "sess-2": structuredClone(storybookArchivedSessionRecord),
  }
  agents.views = {
    "sess-1": {
      snapshot: structuredClone(storybookSessionSnapshot),
      events: structuredClone(storybookSessionEvents),
      loading: false,
      error: null,
      historySeq: "6",
      snapshotSeq: "6",
    },
  }
  agents.configurations = {
    "sess-1": makeConfiguration("claude-code"),
  }
  agents.refresh = async () => {}
  agents.open = async () => {}
  agents.agentConfiguration = async (params) => makeConfiguration(params.provider)
  agents.sessionConfiguration = async (id) => agents.configurations[id] ?? makeConfiguration("claude-code")
  agents.configureSession = async (id, choices) => {
    const cfg = makeConfiguration(agents.sessions[id]?.provider ?? "claude-code")
    if (choices.model && cfg.models) cfg.models.currentValue = choices.model
    if (choices.reasoningEffort && cfg.reasoningEfforts) cfg.reasoningEfforts.currentValue = choices.reasoningEffort
    if (choices.mode && cfg.modes) cfg.modes.currentValue = choices.mode
    agents.configurations[id] = cfg
    return cfg
  }
  agents.gitBranches = async (workspaceId) => ({
    workspaceId,
    currentBranch: "main",
    branches: ["main", "develop", "feat/storybook-components", "fix/terminal-resize"],
  })
  agents.gitStatus = async (sessionId) => ({
    sessionId,
    repositories: [
      {
        id: "repo-1",
        root: "/workspace/deskfleet",
        branch: "feat/storybook-components",
        head: "a1b2c3d",
        changes: [
          { path: "packages/components/src/components/common/UiButton.vue", kind: "unstaged", status: "modified", additions: 12, deletions: 2 },
          { path: "packages/components/.storybook/main.ts", kind: "staged", status: "added", additions: 28, deletions: 0 },
          { path: "packages/components/src/old-helper.ts", kind: "unstaged", status: "deleted", additions: 0, deletions: 45 },
        ],
      },
    ],
    directories: [{ path: "/workspace/deskfleet", repositoryId: "repo-1" }],
  })
  agents.gitDiff = async (request) => ({
    ...request,
    patch: storybookPatch,
    binary: false,
    truncated: false,
  })
  agents.watchGit = async () => () => {}
  agents.composerReferences = async () => ({
    items: [
      {
        reference: {
          kind: "file",
          originId: "origin-1",
          workspaceId: "ws-1",
          directoryIndex: 0,
          sourceDirectory: "/workspace/deskfleet",
          relativePath: "packages/components/src/components/common/UiButton.vue",
        },
        name: "UiButton.vue",
        description: "packages/components/src/components/common/UiButton.vue",
      },
      {
        reference: {
          kind: "file",
          originId: "origin-1",
          workspaceId: "ws-1",
          directoryIndex: 0,
          sourceDirectory: "/workspace/deskfleet",
          relativePath: "packages/components/src/components/session/AgentConversation.vue",
        },
        name: "AgentConversation.vue",
        description: "packages/components/src/components/session/AgentConversation.vue",
      },
    ],
    truncated: false,
  })

  const terminals = useTerminalsStore(pinia)
  terminals.sessions = [
    { id: "term-1", title: "zsh — deskfleet", cwd: "/workspace/deskfleet", cols: 100, rows: 30, status: "running", worktreeId: "wt-sess-1" },
    { id: "term-2", title: "pnpm test", cwd: "/workspace/deskfleet", cols: 100, rows: 30, status: "exited", exitCode: 0, worktreeId: "wt-sess-1" },
  ]
  terminals.selected = { "wt-sess-1": "term-1" }
  terminals.refresh = async () => {}

  const fleet = useFleetStore(pinia)
  fleet.catalog = structuredClone(storybookCatalog)
  fleet.localDesktopTarget = { id: "machine-1", name: "MacBook Pro (Studio)", online: true, desktop: true }
  fleet.catalogReady = true
  fleet.targetWorkspaceId = "ws-1"
  fleet.refreshLocal = async () => {}
  fleet.refreshLocalCatalog = async () => {}
  fleet.refreshLocalDesktop = async () => fleet.localDesktopTarget

  const layout = useLayoutStore(pinia)
  layout.sidebarOpen = true
  layout.detailsOpen = true

  const pinned = usePinnedSessionsStore(pinia)
  pinned.pin("machine-1", "sess-1", "Add Storybook for UI components")

  const accountSession: AccountSession = createAccountSession(api.central!)
  accountSession.ready.value = true
  accountSession.account.value = {
    serverUrl: "https://fleet.deskfleet.dev",
    siteAdmin: true,
    user: { id: "user-1", name: "Ada Lovelace", email: "ada@deskfleet.dev" },
  }
  accountSession.site.value = {
    siteName: "DeskFleet Cloud",
    announcement: "Scheduled maintenance on Sunday 02:00 UTC.",
    allowTeamCreation: true,
    termsOfServiceUrl: "https://deskfleet.dev/terms",
    privacyTermsUrl: "https://deskfleet.dev/privacy",
  }
  accountSession.teams.value = structuredClone(storybookTeams)
  accountSession.teamId.value = "team-1"
  accountSession.members.value = structuredClone(storybookMembers)
  accountSession.machines.value = structuredClone(storybookMachines)
  accountSession.machineId.value = "machine-1"
  accountSession.enrollment.value = {
    configured: true,
    connected: true,
    revoked: false,
    serverUrl: "https://fleet.deskfleet.dev",
    machineId: "machine-1",
    teamId: "team-1",
    identity: { originId: "origin-1", machineId: "local-1" },
    machineName: "MacBook Pro (Studio)",
  }

  const resourceContext: ComputedRef<AgentResourceContext | undefined> = computed(() => ({
    target: { kind: "machine", machineId: "machine-1", teamId: "team-1" },
    sessionId: "sess-1",
    roots: ["/workspace/deskfleet"],
  }))

  return {
    api,
    pinia,
    appearance,
    accountSession,
    resourceContext,
    provideMap: {
      [accountSessionKey as symbol]: accountSession,
      [appearanceStoreKey as symbol]: appearance,
      [agentResourceContextKey as symbol]: resourceContext,
    },
  }
}
