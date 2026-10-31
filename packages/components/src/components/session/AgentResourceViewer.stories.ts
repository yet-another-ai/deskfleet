import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { ref } from "vue"
import type { FilesApi } from "../../../../client/src/files.ts"
import { createStorybookDesktopApi } from "../../../.storybook/storybook-fixtures.ts"
import UiButton from "../common/UiButton.vue"
import AgentResourceViewer from "./AgentResourceViewer.vue"

const source = `/**
 * Select the working directory on the session's machine.
 * A missing directory leaves the workspace unchanged.
 */
type Workspace = { name: string; directories: string[] }

export function defaultDirectory(workspace: Workspace): string {
  const [directory] = workspace.directories
  if (!directory) {
    throw new Error("Choose a workspace directory first")
  }

  return directory
}

const workspace = { name: "deskfleet", directories: ["/work/deskfleet"] }
console.log(defaultDirectory(workspace))
`

function fileApi(name: string, content: string): FilesApi {
  const data = new TextEncoder().encode(content)
  return {
    ...createStorybookDesktopApi().files!,
    resolveResource: async () => ({ name, path: `/work/deskfleet/${name}`, kind: "file", size: data.byteLength, modifiedAt: 1_761_739_200_000 }),
    readResource: async () => ({ name, data, mimeType: "text/plain" }),
  }
}

const meta = {
  title: "Domain/Markdown & Diagrams/AgentResourceViewer",
  component: AgentResourceViewer,
  tags: ["autodocs"],
  args: {
    api: fileApi("workspace.ts", source),
    request: {
      target: { kind: "machine", teamId: "team-1", machineId: "machine-1" },
      sessionId: "session-1",
      uri: "workspace.ts#L7-L11",
    },
  },
  render: args => ({
    components: { AgentResourceViewer, UiButton },
    setup() {
      const open = ref(true)
      return { args, open }
    },
    template: `<UiButton @click="open = true">Preview file</UiButton><AgentResourceViewer v-if="open" v-bind="args" @close="open = false" />`,
  }),
} satisfies Meta<typeof AgentResourceViewer>

export default meta
type Story = StoryObj<typeof meta>

export const CodeWithLineRange: Story = {}

export const DarkCodeWithLineRange: Story = {
  globals: { theme: "dark" },
}

export const PlainText: Story = {
  args: {
    api: fileApi("notes.txt", "Remote workspace notes\n\nKeep <placeholder> values unchanged.\n  Indentation and blank lines remain visible.\n"),
    request: {
      target: { kind: "machine", teamId: "team-1", machineId: "machine-1" },
      sessionId: "session-1",
      uri: "notes.txt",
    },
  },
}
