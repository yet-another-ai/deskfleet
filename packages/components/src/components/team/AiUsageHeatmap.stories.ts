import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref } from "vue"
import type { AiUsageDay } from "@deskfleet/client/ai-usage"
import AiUsageHeatmap from "./AiUsageHeatmap.vue"

function buildHeatmapDays(): AiUsageDay[] {
  const start = Date.UTC(2026, 7, 3) // Monday
  return Array.from({ length: 90 }, (_, index) => {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10)
    const active = index % 4 !== 0
    const unreported = index === 72
    const totalTokens = !active || unreported ? 0 : ((index * 137_000) % 1_400_000) + 80_000
    const turnCount = active ? ((index * 7) % 45) + 4 : 0
    return {
      date,
      totalTokens,
      turnCount,
      reportedTurnCount: unreported ? 0 : turnCount,
    }
  })
}

const sampleDays = buildHeatmapDays()

const meta = {
  title: "Domain/Charts & Visualizations/AiUsageHeatmap",
  component: AiUsageHeatmap,
  tags: ["autodocs"],
  args: {
    days: sampleDays,
    from: "2026-09-30",
    to: "2026-10-31",
    selected: "2026-10-29",
  },
  render: (args) => ({
    components: { AiUsageHeatmap },
    setup() {
      const selected = ref<string | undefined>(args.selected)
      const onSelect = (date: string) => {
        selected.value = selected.value === date ? undefined : date
      }
      return { args, selected, onSelect }
    },
    template: `<AiUsageHeatmap :days="args.days" :from="args.from" :to="args.to" :selected="selected" @select="onSelect" />`,
  }),
} satisfies Meta<typeof AiUsageHeatmap>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
