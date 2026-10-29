import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { LocalApplication } from "@deskfleet/client/applications"
import ApplicationIcon from "./ApplicationIcon.vue"

const sampleApplications = [
  { id: "vscode", name: "Visual Studio Code", kind: "editor" },
  { id: "cursor", name: "Cursor", kind: "editor" },
  { id: "zed", name: "Zed", kind: "editor" },
  { id: "xcode", name: "Xcode", kind: "editor" },
  { id: "terminal", name: "Terminal", kind: "terminal" },
  { id: "finder", name: "Finder", kind: "fileManager" },
  { id: "custom-ide", name: "Custom IDE", kind: "editor" },
] satisfies LocalApplication[]

const meta = {
  title: "Foundational/Display & Badges/ApplicationIcon",
  component: ApplicationIcon,
  tags: ["autodocs"],
  args: {
    application: sampleApplications[0],
  },
} satisfies Meta<typeof ApplicationIcon>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const AllApplicationsShowcase: Story = {
  render: () => ({
    components: { ApplicationIcon },
    setup: () => ({ sampleApplications }),
    template: `
      <div class="flex flex-wrap items-center gap-5">
        <div
          v-for="app in sampleApplications"
          :key="app.id"
          class="flex items-center gap-2 rounded-lg border border-ui-border bg-ui-surface px-3 py-1.5 text-sm"
        >
          <ApplicationIcon :application="app" />
          <span>{{ app.name }}</span>
        </div>
      </div>
    `,
  }),
}
