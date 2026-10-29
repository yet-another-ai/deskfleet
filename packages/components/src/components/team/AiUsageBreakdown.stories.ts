import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { TeamAiUsage } from "@deskfleet/client/ai-usage"
import AiUsageBreakdown from "./AiUsageBreakdown.vue"

const sampleUsage: TeamAiUsage = {
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
    {
      start: "2026-10-25T00:00:00Z",
      totalTokens: 820_000,
      turnCount: 58,
      reportedTurnCount: 58,
      models: { "claude-sonnet-4-5": 500_000, "gpt-5-codex": 320_000 },
      members: { "user-1": 480_000, "user-2": 340_000 },
    },
    {
      start: "2026-10-26T00:00:00Z",
      totalTokens: 640_000,
      turnCount: 45,
      reportedTurnCount: 45,
      models: { "claude-sonnet-4-5": 400_000, "gpt-5-codex": 240_000 },
      members: { "user-1": 360_000, "user-2": 280_000 },
    },
    {
      start: "2026-10-27T00:00:00Z",
      totalTokens: 1_120_000,
      turnCount: 82,
      reportedTurnCount: 81,
      models: { "claude-sonnet-4-5": 680_000, "gpt-5-codex": 440_000 },
      members: { "user-1": 650_000, "user-2": 470_000 },
    },
    {
      start: "2026-10-28T00:00:00Z",
      totalTokens: 980_000,
      turnCount: 71,
      reportedTurnCount: 70,
      models: { "claude-sonnet-4-5": 590_000, "gpt-5-codex": 390_000 },
      members: { "user-1": 570_000, "user-2": 410_000 },
    },
    {
      start: "2026-10-29T00:00:00Z",
      totalTokens: 1_290_000,
      turnCount: 86,
      reportedTurnCount: 86,
      models: { "claude-sonnet-4-5": 780_000, "gpt-5-codex": 510_000 },
      members: { "user-1": 740_000, "user-2": 550_000 },
    },
  ],
  heatmap: [],
  models: [
    {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      totalTokens: 2_950_000,
      turnCount: 210,
      reportedTurnCount: 210,
    },
    {
      id: "gpt-5-codex",
      name: "GPT-5 Codex",
      totalTokens: 1_900_000,
      turnCount: 132,
      reportedTurnCount: 130,
    },
  ],
  members: [
    {
      id: "user-1",
      name: "Ada Lovelace",
      totalTokens: 2_800_000,
      turnCount: 195,
      reportedTurnCount: 195,
    },
    {
      id: "user-2",
      name: "Grace Hopper",
      totalTokens: 2_050_000,
      turnCount: 147,
      reportedTurnCount: 145,
    },
  ],
}

const meta = {
  title: "Domain/Charts & Visualizations/AiUsageBreakdown",
  component: AiUsageBreakdown,
  tags: ["autodocs"],
  args: {
    usage: sampleUsage,
    dimension: "models",
  },
} satisfies Meta<typeof AiUsageBreakdown>

export default meta
type Story = StoryObj<typeof meta>

export const ByModel: Story = {
  args: {
    dimension: "models",
  },
}

export const ByMember: Story = {
  args: {
    dimension: "members",
  },
}
