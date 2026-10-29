import type { Meta, StoryObj } from "@storybook/vue3-vite"
import BrandLogo from "./BrandLogo.vue"

const meta = {
  title: "Foundational/Display & Badges/BrandLogo",
  component: BrandLogo,
  tags: ["autodocs"],
  argTypes: {
    size: {
      control: { type: "number", min: 12, max: 128, step: 4 },
      description: "Width and height in pixels",
    },
    decorative: {
      control: "boolean",
      description: "When true, hides the logo from assistive technologies",
    },
  },
  args: {
    size: 32,
    decorative: false,
  },
} satisfies Meta<typeof BrandLogo>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const SizesShowcase: Story = {
  render: () => ({
    components: { BrandLogo },
    template: `
      <div class="flex items-center gap-4">
        <BrandLogo :size="16" />
        <BrandLogo :size="24" />
        <BrandLogo :size="32" />
        <BrandLogo :size="48" />
        <BrandLogo :size="64" />
      </div>
    `,
  }),
}
