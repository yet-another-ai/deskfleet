import type { Meta, StoryObj } from "@storybook/vue3-vite"
import SystemMetricCard from "./SystemMetricCard.vue"

const meta = {
  title: "Foundational/Display & Badges/SystemMetricCard",
  component: SystemMetricCard,
  tags: ["autodocs"],
  args: {
    metric: "cpu",
    label: "CPU Usage",
    value: "34.2",
    unit: "%",
    detail: "16 logical cores",
  },
} satisfies Meta<typeof SystemMetricCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const HighUsageWarning: Story = {
  args: {
    metric: "cpu",
    label: "CPU Usage",
    value: "92.8",
    unit: "%",
    detail: "16 logical cores",
    warning: "High usage",
  },
}

export const MetricGridComparison: Story = {
  render: () => ({
    components: { SystemMetricCard },
    template: `
      <div class="grid gap-3 sm:grid-cols-3">
        <SystemMetricCard metric="cpu" label="CPU" value="28.4" unit="%" detail="16 logical cores" />
        <SystemMetricCard metric="memory" label="Memory" value="88.5" unit="%" detail="56.6 GB of 64.0 GB used" warning="High usage" />
        <SystemMetricCard metric="swap" label="Swap" value="1.2" unit="GB" detail="8.0 GB total" />
      </div>
    `,
  }),
}
