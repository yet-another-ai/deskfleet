import type { Meta, StoryObj } from "@storybook/vue3-vite"
import UserAvatar from "./UserAvatar.vue"

const meta = {
  title: "Foundational/Display & Badges/UserAvatar",
  component: UserAvatar,
  tags: ["autodocs"],
  argTypes: {
    name: { control: "text" },
    email: { control: "text" },
    size: {
      control: { type: "number", min: 16, max: 96, step: 4 },
    },
  },
  args: {
    name: "Ada Lovelace",
    email: "ada@deskfleet.dev",
    size: 32,
  },
} satisfies Meta<typeof UserAvatar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const TeamRowShowcase: Story = {
  render: () => ({
    components: { UserAvatar },
    template: `
      <div class="flex items-center gap-3">
        <UserAvatar name="Ada Lovelace" email="ada@deskfleet.dev" :size="24" />
        <UserAvatar name="Grace Hopper" :email="null" :size="32" />
        <UserAvatar name="Alan Turing" email="alan@deskfleet.dev" :size="40" />
        <UserAvatar name="Margaret Hamilton" :email="null" :size="48" />
      </div>
    `,
  }),
}
