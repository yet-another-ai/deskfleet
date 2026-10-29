import type { Meta, StoryObj } from "@storybook/vue3-vite"
import MermaidViewer from "./MermaidViewer.vue"

const flowchartCode = `flowchart LR
  Client["Desktop Client"] --> Peer["WebRTC DataChannel"]
  Peer --> Daemon["Local Daemon"]
  Daemon --> ACP["Agent Provider (ACP)"]
  Daemon --> Git["Git Worktree"]`

const meta = {
  title: "Domain/Markdown & Diagrams/MermaidViewer",
  component: MermaidViewer,
  tags: ["autodocs"],
  args: {
    code: flowchartCode,
    mode: "inline",
    source: {
      sessionId: "sess-1",
      entryId: "message-5",
      diagramId: "0",
    },
  },
} satisfies Meta<typeof MermaidViewer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
