import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { fileSize } from "../../services/file-format.ts"
import UsageMeter from "./UsageMeter.vue"

const meta = {
  title: "Foundational/Display & Badges/UsageMeter",
  component: UsageMeter,
  tags: ["autodocs"],
  args: {
    label: "Relayed traffic",
    hint: "Encrypted relay bandwidth used by remote sessions this billing period.",
    used: 3_221_225_472,
    limit: 10_737_418_240,
    format: fileSize,
    caption: "7.0 GB remaining · Resets Nov 1, 2026",
  },
} satisfies Meta<typeof UsageMeter>

export default meta
type Story = StoryObj<typeof meta>

export const NormalAllowance: Story = {}

export const WarningOverEightyPercent: Story = {
  args: {
    label: "Active sessions",
    hint: "Concurrent active sessions across all machines in your team.",
    used: 21,
    limit: 25,
    format: (v: number) => String(v),
    caption: undefined,
  },
}

export const LimitReachedDanger: Story = {
  args: {
    label: "Team members",
    hint: "Maximum members included in the current plan.",
    used: 10,
    limit: 10,
    format: (v: number) => String(v),
    caption: "Seat limit reached",
  },
}

export const UnlimitedAllowance: Story = {
  args: {
    label: "Relayed traffic",
    hint: "Enterprise teams have unmetered relay traffic.",
    used: 42_949_672_960,
    limit: null,
    format: fileSize,
    caption: undefined,
  },
}
