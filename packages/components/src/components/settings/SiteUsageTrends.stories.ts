import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { SiteUsagePeriod, SiteUsageTrends as UsageTrends } from "@deskfleet/client/site-usage"
import SiteUsageTrends from "./SiteUsageTrends.vue"

function usageTrends(period: SiteUsagePeriod, empty = false): UsageTrends {
  const days = Number.parseInt(period, 10)
  const end = Date.UTC(2026, 10, 14)
  const buckets = Array.from({ length: days }, (_, index) => {
    const progress = index + 90 - days
    return {
      date: new Date(end - (days - index - 1) * 86_400_000).toISOString().slice(0, 10),
      users: empty ? 0 : 340 + progress * 10,
      teams: empty ? 0 : 12 + Math.floor(progress / 2),
      sessions: empty ? 0 : 210 + progress * 22,
      turnCount: empty ? 0 : Math.round((120 + progress * 3) * (0.6 + Math.sin(progress * 1.3) * 0.25)),
      relayedBytes: String(empty ? 0 : Math.round((1 + progress / 50) * 2 ** 30 * (0.5 + Math.cos(progress) * 0.25))),
    }
  })
  const last = buckets.at(-1)!
  return {
    period, timeZone: "UTC", from: `${buckets[0]!.date}T00:00:00Z`, to: "2026-11-14T12:00:00Z", generatedAt: "2026-11-14T12:00:00Z",
    relayHistoryIncomplete: false, totals: { users: last.users, teams: last.teams, sessions: last.sessions }, buckets,
  }
}

const meta = {
  title: "Features/Settings/SiteUsageTrends",
  component: SiteUsageTrends,
  globals: { backgrounds: { grid: false } },
  args: { api: { usageTrends: async period => usageTrends(period) } },
  decorators: [() => ({ template: '<div class="mx-auto max-w-6xl"><story /></div>' })],
} satisfies Meta<typeof SiteUsageTrends>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Empty: Story = { args: { api: { usageTrends: async period => usageTrends(period, true) } } }
export const IncompleteRelayHistory: Story = { args: { api: { usageTrends: async period => ({ ...usageTrends(period), relayHistoryIncomplete: true }) } } }
export const LoadError: Story = { args: { api: { usageTrends: async () => { throw new Error("Could not load usage trends") } } } }
