import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { AiUsageBucket, AiUsageGroup } from "@deskfleet/client/ai-usage"
import AiUsageChart from "./AiUsageChart.vue"

const modelGroups: AiUsageGroup[] = [
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", totalTokens: 2_950_000, turnCount: 210, reportedTurnCount: 210 },
  { id: "gpt-5-codex", name: "GPT-5 Codex", totalTokens: 1_900_000, turnCount: 132, reportedTurnCount: 130 },
]

const dailyBuckets: AiUsageBucket[] = [
  {
    start: "2026-10-25T00:00:00Z",
    totalTokens: 820_000,
    turnCount: 58,
    reportedTurnCount: 58,
    models: { "claude-sonnet-4-5": 500_000, "gpt-5-codex": 320_000 },
    members: { "user-1": 420_000, "user-2": 260_000, "user-3": 140_000 },
  },
  {
    start: "2026-10-26T00:00:00Z",
    totalTokens: 640_000,
    turnCount: 45,
    reportedTurnCount: 45,
    models: { "claude-sonnet-4-5": 400_000, "gpt-5-codex": 240_000 },
    members: { "user-1": 310_000, "user-2": 210_000, "user-3": 120_000 },
  },
  {
    start: "2026-10-27T00:00:00Z",
    totalTokens: 1_120_000,
    turnCount: 82,
    reportedTurnCount: 81,
    models: { "claude-sonnet-4-5": 680_000, "gpt-5-codex": 440_000 },
    members: { "user-1": 580_000, "user-2": 340_000, "user-3": 200_000 },
  },
  {
    start: "2026-10-28T00:00:00Z",
    totalTokens: 980_000,
    turnCount: 71,
    reportedTurnCount: 70,
    models: { "claude-sonnet-4-5": 590_000, "gpt-5-codex": 390_000 },
    members: { "user-1": 490_000, "user-2": 310_000, "user-3": 180_000 },
  },
  {
    start: "2026-10-29T00:00:00Z",
    totalTokens: 1_290_000,
    turnCount: 86,
    reportedTurnCount: 86,
    models: { "claude-sonnet-4-5": 780_000, "gpt-5-codex": 510_000 },
    members: { "user-1": 650_000, "user-2": 370_000, "user-3": 270_000 },
  },
]

const meta = {
  title: "Domain/Charts & Visualizations/AiUsageChart",
  component: AiUsageChart,
  tags: ["autodocs"],
  args: {
    buckets: dailyBuckets,
    groups: modelGroups,
    dimension: "models",
    period: "30d",
    timeZone: "UTC",
  },
} satisfies Meta<typeof AiUsageChart>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
