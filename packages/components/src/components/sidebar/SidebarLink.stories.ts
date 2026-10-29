import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { Bot, CalendarClock, SlidersHorizontal, SquarePen } from "@lucide/vue"
import { useRouter } from "vue-router"
import SidebarLink from "./SidebarLink.vue"

const meta = {
  title: "Foundational/Layout & Chrome/SidebarLink",
  component: SidebarLink,
  tags: ["autodocs"],
  args: {
    to: { name: "new-session" },
    icon: SquarePen,
    label: "New Session",
    replace: false,
    section: false,
  },
  render: (args) => ({
    components: { SidebarLink },
    setup: () => ({ args }),
    template: "<div class='w-60 p-2 bg-ui-sidebar border border-ui-border rounded-lg'><SidebarLink v-bind='args' /></div>",
  }),
} satisfies Meta<typeof SidebarLink>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  decorators: [
    (story) => ({
      components: { story },
      setup() {
        const router = useRouter()
        void router.push({ name: "new-session" })
        return {}
      },
      template: "<story />",
    }),
  ],
}

export const SettingsNavList: Story = {
  render: () => ({
    components: { SidebarLink },
    setup() {
      const router = useRouter()
      void router.push({ name: "settings-preferences" })
      return { SlidersHorizontal, Bot, CalendarClock }
    },
    template: `
      <div class="w-60 p-2 flex flex-col gap-1 bg-ui-sidebar border border-ui-border rounded-lg">
        <SidebarLink :to="{ name: 'settings-preferences' }" :icon="SlidersHorizontal" label="Preferences" replace />
        <SidebarLink :to="{ name: 'settings-agents' }" :icon="Bot" label="Agents" replace />
        <SidebarLink :to="{ name: 'schedules' }" :icon="CalendarClock" label="Schedules" section />
      </div>
    `,
  }),
}
